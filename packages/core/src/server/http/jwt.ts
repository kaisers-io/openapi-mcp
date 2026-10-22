import { Buffer } from 'node:buffer';
import { isAllowedAlg, verifyWithJwk } from './jwk.ts';
import type { JwsAlg, KeySet } from './jwk.ts';

// Local validation of JWT access tokens (RFC 9068) for the HTTP transport's
// OAuth resource-server mode. Pure: no I/O and no clock of its own — the key
// set and `nowMs` are handed in, so every rule below is unit-testable with a
// fixed clock and locally generated keys.
//
// The checks follow the JWT BCP (RFC 8725) and RFC 9068 §4:
// - an EXPLICIT algorithm allowlist of asymmetric JWS algorithms. `none` and
//   every HMAC algorithm are rejected outright: the verifying side only ever
//   holds PUBLIC keys, and accepting HS* would let an attacker sign with the
//   public key as the HMAC secret (the classic algorithm-confusion attack);
// - the key is chosen by `kid` and must be of the type the algorithm
//   requires (an RS256 header can never be verified with an EC key), and a
//   key that pins its own `alg`, `use` or `key_ops` must agree;
// - `crit` is rejected — no JWS extension is understood here, and RFC 7515
//   §4.1.11 requires rejecting a token whose critical extensions are unknown;
// - `iss` must equal the configured issuer exactly, `aud` must name this
//   server's canonical resource URI (RFC 8707 / MCP authorization), and
//   `exp` is mandatory, with `nbf`/`iat` honoured within a small skew.
// Deliberately more lenient than RFC 9068 §2.2: `sub`, `client_id`, `iat`
// and `jti` are optional here. None of them is needed to decide whether the
// token is valid for this resource (issuer, audience, signature and expiry
// are), and several deployed authorization servers omit one or the other in
// client-credentials tokens.

// Clock skew tolerated on exp/nbf/iat, in seconds — enough for ordinary NTP
// drift between the authorization server and this host, small enough not to
// extend a token's life meaningfully.
export const CLOCK_SKEW_SECONDS = 60;
// An access token is a header value; Node already caps the whole header
// block, but the cap here bounds the base64 decoding and JSON parsing this
// module does before any signature check.
export const MAX_TOKEN_LENGTH = 16_384;
// Typ values accepted in the JOSE header. RFC 9068 §4 asks resource servers
// to require `at+jwt`, but most widely deployed authorization servers
// (Keycloak, Entra ID, Okta's default) still emit `JWT` or omit `typ`. The
// token-confusion risk RFC 9068's typ check addresses (an ID token or other
// JWT replayed as an access token) is closed independently by the mandatory
// audience check below: an ID token's `aud` is the client id, never this
// server's resource URI. Any OTHER explicit typ (e.g. `dpop+jwt`,
// `logout+jwt`) names a different kind of token and is rejected.
const ACCEPTED_TYP = new Set(['at+jwt', 'application/at+jwt', 'jwt']);

export type JwtFailure =
  | 'malformed'
  | 'unsupported-alg'
  | 'unsupported-typ'
  | 'crit'
  | 'missing-kid'
  | 'unknown-kid'
  | 'key-mismatch'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'not-yet-valid'
  | 'issued-in-future'
  | 'missing-exp';

export type VerifiedAccessToken = {
  subject: string | undefined;
  clientId: string | undefined;
  scopes: readonly string[];
  // Seconds since the epoch, as in the `exp` claim.
  expiresAt: number;
};

export type JwtVerifyResult =
  | { ok: true; token: VerifiedAccessToken }
  | { ok: false; reason: JwtFailure };

export type JwtVerifyOptions = {
  issuer: string;
  audience: string;
  nowMs: number;
};

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Only the canonical spelling is accepted: Buffer ignores the unused
// trailing bits of the last character, so without the round-trip check one
// signature has several token strings that all verify — harmless for the
// signature itself, but anything keyed on the token string (a cache, rate
// limiting, replay detection) would see them as different tokens.
const decodeSegment = (segment: string): Buffer | undefined => {
  if (!BASE64URL_RE.test(segment)) {
    return undefined;
  }
  const bytes = Buffer.from(segment, 'base64url');
  return bytes.toString('base64url') === segment ? bytes : undefined;
};

const parseJsonSegment = (segment: string): Record<string, unknown> | undefined => {
  const bytes = decodeSegment(segment);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// RFC 8707 resource identifiers are compared on their WHATWG URL-normalized
// form, without a fragment and without ONE trailing slash — the MCP
// authorization spec asks servers to accept `https://mcp.example.com` and
// `https://mcp.example.com/` alike, and upper-case scheme/host components.
// The URL parser normalizes more than that: it elides the default port
// (`:443`), resolves dot segments (`/x/../mcp` equals `/mcp`) and
// percent-encodes as WHATWG does. Path case stays significant (`/MCP` does
// not match), and so does an empty segment (`//mcp`). The broader
// normalization is safe: the authorization server, not the caller, mints
// `aud`, and every accepted spelling names the same resource.
export const comparableResource = (value: string): string => {
  let normalized = value;
  try {
    const url = new URL(value);
    url.hash = '';
    normalized = url.href;
  } catch {
    // Not a URL: compare as an opaque string.
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

const audienceMatches = (aud: unknown, audience: string): boolean => {
  const expected = comparableResource(audience);
  if (typeof aud === 'string') {
    return comparableResource(aud) === expected;
  }
  return (Array.isArray(aud) ? aud : []).some(
    (value) => typeof value === 'string' && comparableResource(value) === expected,
  );
};

const isNumericDate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

// RFC 9068 §2.2.3 / RFC 8693 §4.2: `scope` is ONE space-separated string.
const scopesOf = (scope: unknown): readonly string[] =>
  typeof scope === 'string' ? scope.split(' ').filter((entry) => entry !== '') : [];

export type ParsedJws = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
};

const parseCompactJws = (token: string): ParsedJws | undefined => {
  if (token.length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const header = parseJsonSegment(headerPart);
  const payload = parseJsonSegment(payloadPart);
  const signature = decodeSegment(signaturePart);
  if (header === undefined || payload === undefined || signature === undefined) {
    return undefined;
  }
  return { header, payload, signingInput: `${headerPart}.${payloadPart}`, signature };
};

type HeaderCheck = { ok: true; alg: JwsAlg; kid: string } | { ok: false; reason: JwtFailure };

const checkHeader = (header: Record<string, unknown>): HeaderCheck => {
  const { alg, typ, crit, kid } = header;
  if (!isAllowedAlg(alg)) {
    return { ok: false, reason: 'unsupported-alg' };
  }
  if (typ !== undefined && (typeof typ !== 'string' || !ACCEPTED_TYP.has(typ.toLowerCase()))) {
    return { ok: false, reason: 'unsupported-typ' };
  }
  if (crit !== undefined) {
    return { ok: false, reason: 'crit' };
  }
  if (typeof kid !== 'string' || kid === '') {
    return { ok: false, reason: 'missing-kid' };
  }
  return { ok: true, alg, kid };
};

// The key-independent checks of verifyJwt: compact JWS structure and the
// JOSE header. Callers run this BEFORE touching a key cache, so a malformed
// or forbidden token never triggers (or waits for) a JWKS fetch.
export const checkJwtStructure = (
  token: string,
):
  | { ok: true; parsed: ParsedJws; alg: JwsAlg; kid: string }
  | { ok: false; reason: JwtFailure } => {
  const parsed = parseCompactJws(token);
  if (parsed === undefined) {
    return { ok: false, reason: 'malformed' };
  }
  const header = checkHeader(parsed.header);
  return header.ok ? { ok: true, parsed, alg: header.alg, kid: header.kid } : header;
};

// Signature first, claims second: nothing from an unauthenticated payload is
// interpreted (beyond parsing it as JSON) until its signature has verified.
export const verifyJwt = (token: string, keys: KeySet, opts: JwtVerifyOptions): JwtVerifyResult => {
  const header = checkJwtStructure(token);
  if (!header.ok) {
    return header;
  }
  const { parsed } = header;
  const jwk = keys.get(header.kid);
  if (jwk === undefined) {
    return { ok: false, reason: 'unknown-kid' };
  }
  const signature = verifyWithJwk(header.alg, jwk, parsed.signingInput, parsed.signature);
  if (signature !== 'ok') {
    return { ok: false, reason: signature };
  }
  const { iss, aud, exp, nbf, iat, sub, client_id: clientId, scope } = parsed.payload;
  if (iss !== opts.issuer) {
    return { ok: false, reason: 'wrong-issuer' };
  }
  if (!audienceMatches(aud, opts.audience)) {
    return { ok: false, reason: 'wrong-audience' };
  }
  const nowSeconds = opts.nowMs / 1000;
  if (!isNumericDate(exp)) {
    return { ok: false, reason: 'missing-exp' };
  }
  if (nowSeconds >= exp + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  if (nbf !== undefined && (!isNumericDate(nbf) || nowSeconds < nbf - CLOCK_SKEW_SECONDS)) {
    return { ok: false, reason: 'not-yet-valid' };
  }
  if (iat !== undefined && (!isNumericDate(iat) || iat > nowSeconds + CLOCK_SKEW_SECONDS)) {
    return { ok: false, reason: 'issued-in-future' };
  }
  return {
    ok: true,
    token: {
      subject: optionalString(sub),
      clientId: optionalString(clientId),
      scopes: scopesOf(scope),
      expiresAt: exp,
    },
  };
};
