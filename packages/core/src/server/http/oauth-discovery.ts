import { usageError, validationError } from '../../errors.ts';
import { pinnedRequest } from '../../http/pinned-dispatcher.ts';
import type { PinnedDeps } from '../../http/pinned-dispatcher.ts';
import { parseJwks } from './jwk.ts';
import { createJwksCache } from './jwks-cache.ts';
import type { JwksCache, KeySetFetch } from './jwks-cache.ts';

// Authorization-server discovery and JWKS caching for the OAuth
// resource-server mode (oauth.ts). Every outbound fetch goes through the
// same DNS-pinned egress transport as the upstream API: metadata addresses
// are always denied, private addresses only on the operator-configured
// issuer origin (or with --allow-private-network), bodies are size-capped,
// and every hop — redirects included — must be https (or loopback http).

export type IssuerEgressConfig = {
  // The issuer identifier, compared EXACTLY with the `issuer` member of its
  // metadata document.
  issuer: string;
  allowPrivateNetwork: boolean;
  timeoutMs: number;
};

export type OAuthDeps = {
  transport: PinnedDeps;
  now: () => number;
  // Operator-facing notices about the key set: a failed refresh (the last
  // good set is kept) or an authorization server that published an empty
  // set (every token is rejected). At most one per refresh cooldown
  // (jwks-cache.ts, which holds the cache policy).
  warn?: (message: string) => void;
};

// Metadata and JWKS documents are small; 64 KiB is generous for both.
export const MAX_DOCUMENT_BYTES = 65_536;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Cleartext is accepted only for a loopback authority (local development and
// tests, matching the SDK's own issuer check); everything else must be https.
const isSecureScheme = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));

const parseAbsoluteUrl = (raw: string, label: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`${label} must be an absolute URL`);
  }
  if (!isSecureScheme(url)) {
    throw usageError(`${label} must use https (http is accepted only for a loopback host)`);
  }
  return url;
};

// An issuer identifier or resource URI: fragments, queries and userinfo are
// refused — none belongs in an issuer identifier (RFC 8414 §2) or a resource
// URI (RFC 8707 §2).
export const parseSecureUrl = (raw: string, label: string): URL => {
  const url = parseAbsoluteUrl(raw, label);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw usageError(`${label} must not contain credentials, a query string or a fragment`);
  }
  return url;
};

// A JWKS location is a document URL, not an identifier: RFC 8414 §2 only
// requires https, and deployed authorization servers do put a query on it
// (Entra ID's `?appid=`). Credentials and fragments are still refused.
export const parseJwksUrl = (raw: string): URL => {
  const label = 'the authorization server jwks_uri';
  const url = parseAbsoluteUrl(raw, label);
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw usageError(`${label} must not contain credentials or a fragment`);
  }
  return url;
};

// Applied to every hop of every discovery/JWKS fetch: an https document
// that redirects to cleartext would otherwise hand a network attacker the
// key set.
const requireSecureHop = (url: URL): string | undefined =>
  isSecureScheme(url)
    ? undefined
    : `${url.origin} is not https (cleartext is accepted only for a loopback host)`;

// RFC 8414 §3.1 path insertion, then the two OpenID Connect Discovery
// locations — the order the MCP authorization spec prescribes for clients
// (authorization-server-discovery), so this server finds the same document
// its clients will.
export const metadataCandidates = (issuer: URL): readonly URL[] => {
  const path = issuer.pathname.endsWith('/') ? issuer.pathname.slice(0, -1) : issuer.pathname;
  const at = (suffix: string): URL => new URL(suffix, issuer.origin);
  return path === ''
    ? [at('/.well-known/oauth-authorization-server'), at('/.well-known/openid-configuration')]
    : [
        at(`/.well-known/oauth-authorization-server${path}`),
        at(`/.well-known/openid-configuration${path}`),
        at(`${path}/.well-known/openid-configuration`),
      ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type FetchJsonOptions = { trusted: boolean; config: IssuerEgressConfig };

const describeUrl = (url: URL): string => `${url.origin}${url.pathname}`;

// One GET through the pinned egress transport, returning parsed JSON or an
// operator-readable failure. Never echoes response bodies.
const fetchJson = async (
  url: URL,
  opts: FetchJsonOptions,
  deps: OAuthDeps,
): Promise<{ ok: true; json: unknown } | { ok: false; detail: string }> => {
  const accept = { accept: 'application/json' };
  const outcome = await pinnedRequest(
    url,
    {
      method: 'GET',
      headers: { sameOriginHeaders: accept, crossOriginHeaders: accept },
      baseTrusted: opts.trusted,
      allowPrivateNetwork: opts.config.allowPrivateNetwork,
      timeoutMs: opts.config.timeoutMs,
      maxResponseBytes: MAX_DOCUMENT_BYTES,
      signal: new AbortController().signal,
      checkHop: requireSecureHop,
    },
    deps.transport,
  );
  const where = describeUrl(url);
  if (outcome.kind === 'error') {
    const detail =
      outcome.reason === 'egress' && outcome.detail !== undefined ? ` (${outcome.detail})` : '';
    return { ok: false, detail: `${where}: ${outcome.reason}${detail}` };
  }
  if (outcome.status !== 200) {
    return { ok: false, detail: `${where}: HTTP ${String(outcome.status)}` };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.bodyBytes);
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, detail: `${where}: response is not valid JSON` };
  }
};

// Finds and validates the authorization server's metadata, returning its
// JWKS location. The document's `issuer` must be IDENTICAL to the configured
// issuer (RFC 8414 §3.3) — otherwise a document served at the issuer's
// well-known path could redirect key discovery to another issuer's keys.
const discoverJwksUri = async (
  issuer: URL,
  config: IssuerEgressConfig,
  deps: OAuthDeps,
): Promise<URL> => {
  const failures: string[] = [];
  for (const candidate of metadataCandidates(issuer)) {
    // Sequential on purpose: the candidates are a priority order, and the
    // first valid document wins.
    const result = await fetchJson(candidate, { trusted: true, config }, deps);
    if (!result.ok) {
      failures.push(result.detail);
      continue;
    }
    if (!isRecord(result.json) || result.json['issuer'] !== config.issuer) {
      failures.push(`${describeUrl(candidate)}: issuer does not match`);
      continue;
    }
    const jwksUri = result.json['jwks_uri'];
    if (typeof jwksUri !== 'string') {
      throw validationError(
        `the authorization server metadata for ${config.issuer} has no jwks_uri`,
      );
    }
    try {
      return parseJwksUrl(jwksUri);
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : String(error));
    }
  }
  throw validationError(
    `cannot discover the authorization server metadata for ${config.issuer} (${failures.join('; ')})`,
  );
};

// One JWKS fetch, classified: usable keys, an authoritative empty set, or a
// failure (unreachable, non-200, not a JWKS, or entries none of which can
// verify — e.g. only encryption keys, which is a broken document rather than
// a revocation).
const fetchKeySet = async (
  jwksUri: URL,
  opts: FetchJsonOptions,
  deps: OAuthDeps,
): Promise<KeySetFetch> => {
  const result = await fetchJson(jwksUri, opts, deps);
  if (!result.ok) {
    return { kind: 'failed', detail: result.detail };
  }
  const where = describeUrl(jwksUri);
  const parsed = parseJwks(result.json);
  if (parsed === undefined) {
    return { kind: 'failed', detail: `${where}: not a JWKS document` };
  }
  if (parsed.size > 0) {
    return { kind: 'keys', keys: parsed };
  }
  const entries = isRecord(result.json) ? result.json['keys'] : undefined;
  return Array.isArray(entries) && entries.length === 0
    ? { kind: 'revoked' }
    : { kind: 'failed', detail: `${where}: no usable signing key` };
};

// Discovers the issuer's JWKS and loads it once. Fails fast: an unreachable
// or inconsistent authorization server, or one without a usable signing key,
// is a startup error, not a 503 on every request.
export const loadIssuerKeys = async (
  issuer: URL,
  config: IssuerEgressConfig,
  deps: OAuthDeps,
): Promise<JwksCache> => {
  const jwksUri = await discoverJwksUri(issuer, config, deps);
  // Trusted (private addresses allowed) only on the issuer's own origin —
  // the operator named that origin; a jwks_uri elsewhere is remote-chosen.
  const opts: FetchJsonOptions = { trusted: jwksUri.origin === issuer.origin, config };
  const initial = await fetchKeySet(jwksUri, opts, deps);
  if (initial.kind !== 'keys') {
    throw validationError(
      `cannot load a usable JWKS from ${describeUrl(jwksUri)}${initial.kind === 'failed' ? ` (${initial.detail})` : ' (the key set is empty)'}`,
    );
  }
  return createJwksCache(initial.keys, {
    fetchKeySet: () => fetchKeySet(jwksUri, opts, deps),
    location: describeUrl(jwksUri),
    now: deps.now,
    warn: deps.warn ?? (() => {}),
  });
};
