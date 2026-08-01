import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

// Token grammar: the token must decode to EXACTLY 32 bytes (256 bits) —
// either 43 unpadded Base64URL characters, or a 44-character PADDED
// standard Base64 string (the literal shape of `openssl rand -base64 32`,
// one trailing '='). A minimum-length-only check (e.g. ">=32 Base64
// characters") would not guarantee this: it admits as few as 192 bits at
// its minimum length and rejects `openssl rand -base64 32`'s own output
// outright (44 chars, padded) — neither satisfies the required 256-bit
// guarantee. Length-gate FIRST (cheap; avoids base64-decoding an
// attacker-chosen string of arbitrary length) with a closed-form regex for
// each of the two accepted shapes, THEN decode and verify the EXACT byte
// count as a second, independent check — a string that merely LOOKS the
// right length is still rejected if it does not actually decode to 32
// bytes. Validated once at CLI startup so a malformed --http-token-env
// value fails fast rather than silently comparing against garbage forever.
const UNPADDED_BASE64URL_43_RE = /^[A-Za-z0-9_-]{43}$/u;
const PADDED_STANDARD_BASE64_44_RE = /^[A-Za-z0-9+/]{43}=$/u;
const REQUIRED_DECODED_BYTES = 32;

export const isValidBearerToken = (token: string): boolean => {
  if (!UNPADDED_BASE64URL_43_RE.test(token) && !PADDED_STANDARD_BASE64_44_RE.test(token)) {
    return false;
  }
  // Buffer.from(..., 'base64') is lenient about '-'/'_' vs '+'/'/' , so one
  // decode call handles both accepted shapes (verified: both a `base64url`
  // and a padded standard `base64` sample decode correctly through the
  // SAME 'base64' encoding name).
  return Buffer.from(token, 'base64').length === REQUIRED_DECODED_BYTES;
};

// Constant-time compare on EQUAL-LENGTH digests: hash both sides first so
// timingSafeEqual is NEVER called on unequal-length buffers (it throws), and
// so comparison time never leaks the token's length or content via timing.
// sha256 produces a fixed 32-byte digest regardless of input length.
// Params are named left/right, not a/b: the repo's id-length override (min 2)
// exempts s/m/h/d/z/T but not single-letter a/b, so a/b would fail lint.
export const constantTimeEquals = (left: string, right: string): boolean => {
  const digestLeft = createHash('sha256').update(left, 'utf8').digest();
  const digestRight = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(digestLeft, digestRight);
};

export type BearerCheck = {
  configuredToken: string; // Already validated via isValidBearerToken at startup
};

// RFC 7235 §2.1: the auth-scheme token is case-insensitive (`i` flag), and
// RFC 7235's `credentials = auth-scheme [ 1*SP ... ]` allows one-or-more SP
// before the credentials (`+`, not a fixed single space) — interop with
// clients that send `bearer <t>` or fold in an extra space. `\S+` is
// deliberately broader than RFC 6750's stricter `b64token` alphabet: this is
// NOT an authorization bypass, because the extracted credential is compared
// by EXACT equality (constantTimeEquals, below) against a configured token
// that already passed the much stricter `isValidBearerToken` grammar at
// startup — a `\S+`-but-not-b64token string can never equal it. The goal
// here is scheme/spacing tolerance, not a strict-grammar parser. Anchored
// (`^`/`$`) and linear (no nested quantifiers) — no ReDoS — and still
// fail-closed: rejects `Bearer <t> extra`, `Basic <t>`, bare `Bearer`, and
// literal leading/trailing whitespace (neither `^` nor `+` matches those).
const BEARER_RE = /^Bearer +(?<token>\S+)$/iu;

export const extractBearerToken = (authorizationHeader: string | undefined): string | undefined => {
  if (authorizationHeader === undefined) {
    return undefined;
  }
  const match = BEARER_RE.exec(authorizationHeader);
  return match?.groups?.['token'];
};

export const isAuthorized = (
  check: BearerCheck,
  authorizationHeader: string | undefined,
): boolean => {
  const token = extractBearerToken(authorizationHeader);
  return token !== undefined && constantTimeEquals(token, check.configuredToken);
};
