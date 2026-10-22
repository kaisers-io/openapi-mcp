import { Buffer } from 'node:buffer';
import type { RuntimeRedactor } from '../redact.ts';
import { pinnedRequest } from './pinned-dispatcher.ts';
import type { PinnedDeps, PinnedErrorReason } from './pinned-dispatcher.ts';

// OAuth 2.0 client-credentials grant (RFC 6749 §4.4) for upstream API calls:
// one access token, fetched on first use, cached in memory only, refreshed
// shortly before it expires, and dropped when the upstream rejects it.
//
// The token request goes through the SAME pinned transport as every API
// call (DNS pinning, metadata always denied, private ranges only with
// --allow-private-network, never "trusted"), as a POST — and pinnedRequest
// refuses to follow any redirect of a write method, so a token endpoint
// that redirects can never forward the client secret elsewhere.
//
// Every access token is registered with the process redactor BEFORE it is
// handed out, so it is scrubbed from every tool result, error and log line
// exactly like a startup secret. Nothing from the token endpoint's body is
// ever echoed: an error carries only a status and, when it is one of RFC
// 6749 §5.2's registered codes, that code.

export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post';

export type ClientCredentialsConfig = {
  tokenUrl: URL;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  clientAuth: ClientAuthMethod;
  allowPrivateNetwork: boolean;
  timeoutMs: number;
  redactor: RuntimeRedactor;
  now: () => number;
};

export type TokenResult = { ok: string } | { error: string };

export type TokenSource = {
  // A cached token while it is fresh; otherwise one shared token request
  // (single-flight) whose result every concurrent caller receives.
  getToken: () => Promise<TokenResult>;
  // Drops `token` from the cache if it is still the cached one, so the next
  // getToken fetches a new token. A stale token (already replaced by a
  // concurrent refresh) is ignored, so N parallel 401s cause ONE refetch.
  invalidate: (token: string) => void;
};

// A token response is a small JSON object; anything larger is not one.
const MAX_TOKEN_RESPONSE_BYTES = 65_536;
// Refresh margin: 60 s (Spring Security's default clock skew for the same
// decision) or 10 % of the lifetime, whichever is smaller — so a 30 s token
// is refreshed 3 s early rather than never being reusable.
const MAX_REFRESH_MARGIN_MS = 60_000;
const REFRESH_MARGIN_FRACTION = 0.1;
// No `expires_in` (it is only RECOMMENDED, RFC 6749 §5.1): reuse the token
// for at most this long — a 401 still triggers a refetch sooner — and keep
// it registered for redaction for a full day, since its real lifetime is
// unknown.
const UNKNOWN_LIFETIME_REUSE_MS = 3_600_000;
const UNKNOWN_LIFETIME_RETAIN_MS = 86_400_000;
// Kept registered for redaction a little past its expiry (clock skew
// between this host and the authorization server).
const RETAIN_GRACE_MS = 60_000;

// RFC 6749 Appendix A.12: access-token = 1*VSCHAR (%x20-7E). Also what
// makes it safe to place in a header without a smuggling vector.
const ACCESS_TOKEN_RE = /^[ -~]+$/u;
// RFC 6749 §5.2 registered error codes — the only endpoint-supplied text
// ever surfaced (anything else could be attacker-chosen prose).
const REGISTERED_ERRORS: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

const TRANSPORT_FAILURES: Readonly<Record<PinnedErrorReason, string>> = {
  timeout: 'the token request timed out',
  cancelled: 'the token request was cancelled',
  egress: 'the token endpoint address is not allowed by the egress policy',
  'too-large': 'the token response exceeded its size budget',
  'redirect-loop': 'the token endpoint redirected, which is never followed',
  'redirect-write-method': 'the token endpoint redirected, which is never followed',
  'redirect-invalid': 'the token endpoint redirected, which is never followed',
  network: 'the token endpoint could not be reached',
};

// RFC 6749 §2.3.1: the client id and secret are each encoded with the
// application/x-www-form-urlencoded algorithm (Appendix B) BEFORE being
// joined with ":" and Base64-encoded for HTTP Basic.
const formEncode = (value: string): string =>
  new URLSearchParams([['', value]]).toString().slice(1);

export const clientSecretBasic = (clientId: string, clientSecret: string): string =>
  `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`, 'utf8').toString('base64')}`;

const failure = (detail: string): TokenResult => ({
  error: `could not obtain an OAuth2 access token: ${detail}`,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};

// `expires_in` is a JSON number per RFC 6749 §5.1; a few servers send it as
// a numeric string, which is accepted. Anything else means "unknown".
const lifetimeMs = (raw: unknown): number | undefined => {
  const seconds = typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : raw;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : undefined;
};

type Cached = { token: string; refreshAtMs: number };

type Parsed = { token: string; lifetime: number | undefined } | { error: string };

const parseTokenResponse = (status: number, body: Uint8Array): Parsed => {
  const json = parseJson(body);
  if (status !== 200) {
    const code = isRecord(json) ? json['error'] : undefined;
    const known = typeof code === 'string' && REGISTERED_ERRORS.has(code) ? ` (${code})` : '';
    return { error: `the token endpoint answered HTTP ${String(status)}${known}` };
  }
  if (!isRecord(json)) {
    return { error: 'the token response is not a JSON object' };
  }
  const token = json['access_token'];
  if (typeof token !== 'string' || !ACCESS_TOKEN_RE.test(token)) {
    return { error: 'the token response carries no valid access_token' };
  }
  // RFC 6749 §7.1: a client MUST NOT use a token whose type it does not
  // understand; §5.1: the type is case-insensitive.
  const type = json['token_type'];
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer') {
    return { error: 'the token response is not a Bearer token' };
  }
  return { token, lifetime: lifetimeMs(json['expires_in']) };
};

export const createClientCredentialsSource = (
  config: ClientCredentialsConfig,
  transport: PinnedDeps,
): TokenSource => {
  const form: [string, string][] = [['grant_type', 'client_credentials']];
  if (config.scopes.length > 0) {
    // RFC 6749 §3.3: space-delimited scope list.
    form.push(['scope', config.scopes.join(' ')]);
  }
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (config.clientAuth === 'client_secret_basic') {
    headers['authorization'] = clientSecretBasic(config.clientId, config.clientSecret);
  } else {
    form.push(['client_id', config.clientId], ['client_secret', config.clientSecret]);
  }
  const body = new TextEncoder().encode(new URLSearchParams(form).toString());
  let cached: Cached | undefined;
  let inFlight: Promise<TokenResult> | undefined;

  const fetchToken = async (): Promise<TokenResult> => {
    // Lifetimes count from the request START, the conservative end.
    const issuedAtMs = config.now();
    const outcome = await pinnedRequest(
      config.tokenUrl,
      {
        method: 'POST',
        // Never sent cross-origin: a POST redirect is refused outright.
        headers: { sameOriginHeaders: headers, crossOriginHeaders: {} },
        body,
        baseTrusted: false,
        allowPrivateNetwork: config.allowPrivateNetwork,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: MAX_TOKEN_RESPONSE_BYTES,
        // Shared by every waiting caller, so no one caller's cancellation
        // may abort it; the timeout still bounds it.
        signal: new AbortController().signal,
      },
      transport,
    );
    if (outcome.kind === 'error') {
      return failure(TRANSPORT_FAILURES[outcome.reason]);
    }
    const parsed = parseTokenResponse(outcome.status, outcome.bodyBytes);
    if ('error' in parsed) {
      return failure(parsed.error);
    }
    const { token, lifetime } = parsed;
    const retainUntilMs =
      lifetime === undefined
        ? issuedAtMs + UNKNOWN_LIFETIME_RETAIN_MS
        : issuedAtMs + lifetime + RETAIN_GRACE_MS;
    try {
      config.redactor.registerRuntimeSecret(token, retainUntilMs, config.now());
    } catch {
      // Unredactable (or the budget is spent): never use it.
      return failure('the access token could not be registered for redaction');
    }
    const refreshAtMs =
      lifetime === undefined
        ? issuedAtMs + UNKNOWN_LIFETIME_REUSE_MS
        : issuedAtMs +
          lifetime -
          Math.min(MAX_REFRESH_MARGIN_MS, lifetime * REFRESH_MARGIN_FRACTION);
    cached = { token, refreshAtMs };
    return { ok: token };
  };

  // The single-flight slot is cleared once the shared request settles, so
  // the next stale-cache call starts a new one.
  const shared = async (): Promise<TokenResult> => {
    try {
      return await fetchToken();
    } finally {
      inFlight = undefined;
    }
  };

  const getToken = async (): Promise<TokenResult> => {
    if (cached !== undefined && config.now() < cached.refreshAtMs) {
      return { ok: cached.token };
    }
    inFlight ??= shared();
    return await inFlight;
  };

  const invalidate = (token: string): void => {
    if (cached?.token === token) {
      cached = undefined;
    }
  };

  return { getToken, invalidate };
};
