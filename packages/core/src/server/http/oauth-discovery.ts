import { usageError, validationError } from '../../errors.ts';
import { pinnedRequest } from '../../http/pinned-dispatcher.ts';
import type { PinnedDeps } from '../../http/pinned-dispatcher.ts';
import { parseJwks } from './jwk.ts';
import type { KeySet } from './jwk.ts';

// Authorization-server discovery and JWKS caching for the OAuth
// resource-server mode (oauth.ts). Every outbound fetch goes through the
// same DNS-pinned egress transport as the upstream API: metadata addresses
// are always denied, private addresses only on the operator-configured
// issuer origin (or with --allow-private-network), and bodies are
// size-capped.

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
};

// Fixed cache policy for the JWKS. Keys are refreshed after JWKS_TTL_MS; an
// unknown `kid` (a key rotated in since the last fetch) triggers an early
// refresh, at most once per REFETCH_COOLDOWN_MS so a stream of tokens with
// made-up kids cannot turn into a stream of fetches. If refreshes fail, the
// last good set keeps verifying for at most MAX_STALE_MS after it was
// fetched; past that, requests fail closed with 503 rather than trusting
// keys the authorization server may have revoked.
export const JWKS_TTL_MS = 300_000;
export const REFETCH_COOLDOWN_MS = 30_000;
export const MAX_STALE_MS = 3_600_000;
// Metadata and JWKS documents are small; 64 KiB is generous for both.
export const MAX_DOCUMENT_BYTES = 65_536;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Cleartext is accepted only for a loopback authority (local development and
// tests, matching the SDK's own issuer check); everything else must be
// https. Fragments, queries and userinfo are refused: none belongs in an
// issuer identifier (RFC 8414 §2) or a resource URI (RFC 8707 §2).
export const parseSecureUrl = (raw: string, label: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`${label} must be an absolute URL`);
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw usageError(`${label} must use https (http is accepted only for a loopback host)`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw usageError(`${label} must not contain credentials, a query string or a fragment`);
  }
  return url;
};

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
    },
    deps.transport,
  );
  const where = `${url.origin}${url.pathname}`;
  if (outcome.kind === 'error') {
    return { ok: false, detail: `${where}: ${outcome.reason}` };
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
      failures.push(`${candidate.origin}${candidate.pathname}: issuer does not match`);
      continue;
    }
    const jwksUri = result.json['jwks_uri'];
    if (typeof jwksUri !== 'string') {
      throw validationError(
        `the authorization server metadata for ${config.issuer} has no jwks_uri`,
      );
    }
    try {
      return parseSecureUrl(jwksUri, 'the authorization server jwks_uri');
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : String(error));
    }
  }
  throw validationError(
    `cannot discover the authorization server metadata for ${config.issuer} (${failures.join('; ')})`,
  );
};

export type JwksCache = {
  get: () => Promise<KeySet | undefined>;
  refreshForUnknownKid: () => Promise<KeySet | undefined>;
};

const createJwksCache = (
  jwksUri: URL,
  issuer: URL,
  config: IssuerEgressConfig,
  deps: OAuthDeps,
  initial: KeySet,
): JwksCache => {
  // Trusted (private addresses allowed) only on the issuer's own origin —
  // the operator named that origin; a jwks_uri elsewhere is remote-chosen.
  const trusted = jwksUri.origin === issuer.origin;
  let keys = initial;
  let fetchedAtMs = deps.now();
  let lastAttemptMs = fetchedAtMs;
  let inflight: Promise<void> | undefined;

  const fetchKeys = async (): Promise<void> => {
    try {
      lastAttemptMs = deps.now();
      const result = await fetchJson(jwksUri, { trusted, config }, deps);
      const parsed = result.ok ? parseJwks(result.json) : undefined;
      if (parsed !== undefined) {
        keys = parsed;
        fetchedAtMs = deps.now();
      }
    } finally {
      inflight = undefined;
    }
  };
  // Single-flight: concurrent requests share one fetch.
  const refresh = (): Promise<void> => {
    inflight ??= fetchKeys();
    return inflight;
  };
  const current = (): KeySet | undefined =>
    deps.now() - fetchedAtMs < MAX_STALE_MS ? keys : undefined;

  return {
    get: async () => {
      if (deps.now() - fetchedAtMs >= JWKS_TTL_MS) {
        await refresh();
      }
      return current();
    },
    refreshForUnknownKid: async () => {
      if (deps.now() - lastAttemptMs >= REFETCH_COOLDOWN_MS) {
        await refresh();
      }
      return current();
    },
  };
};

// Discovers the issuer's JWKS and loads it once. Fails fast: an unreachable
// or inconsistent authorization server is a startup error, not a 503 on
// every request.
export const loadIssuerKeys = async (
  issuer: URL,
  config: IssuerEgressConfig,
  deps: OAuthDeps,
): Promise<JwksCache> => {
  const jwksUri = await discoverJwksUri(issuer, config, deps);
  const trusted = jwksUri.origin === issuer.origin;
  const initial = await fetchJson(jwksUri, { trusted, config }, deps);
  const initialKeys = initial.ok ? parseJwks(initial.json) : undefined;
  if (initialKeys === undefined || initialKeys.size === 0) {
    throw validationError(
      `cannot load a usable JWKS from ${jwksUri.origin}${jwksUri.pathname}${initial.ok ? '' : ` (${initial.detail})`}`,
    );
  }
  return createJwksCache(jwksUri, issuer, config, deps, initialKeys);
};
