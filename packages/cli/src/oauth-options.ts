import { isIP } from 'node:net';
import { clientSecretBasic, sanitizeSpecText, usageError } from '@kaisers-io/openapi-mcp-core';
import type { ClientAuthMethod, NormalizedSpec } from '@kaisers-io/openapi-mcp-core';

// The --upstream-oauth-* flags: OAuth2 client-credentials (RFC 6749 §4.4) for
// upstream API calls. Like --header-env, the client id and secret are only
// ever read from env vars named on the command line — never from argv.

export type OAuthCmdOpts = {
  upstreamOauthClientIdEnv?: string;
  upstreamOauthClientSecretEnv?: string;
  upstreamOauthScheme?: string;
  upstreamOauthScope: readonly string[];
  upstreamOauthTokenUrl?: string;
  upstreamOauthClientAuth: string;
};

export type ResolvedOAuthConfig = {
  clientId: string;
  clientSecret: string;
  // "CLIENT_ID / CLIENT_SECRET" — named in error hints, never the values.
  envVarHint: string;
  scheme?: string;
  scopes: readonly string[];
  tokenUrlOverride?: URL;
  clientAuth: ClientAuthMethod;
  // Registered with the redactor at startup: the secret itself and the
  // exact Basic credential sent on the wire.
  secretValues: readonly string[];
};

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// oxlint-disable-next-line no-control-regex -- matching control characters is this regex's purpose (it rejects them)
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;
// RFC 6749 §3.3: scope-token = 1*( %x21 / %x23-5B / %x5D-7E ) — visible
// ASCII except space, `"` and `\`.
const isScopeToken = (scope: string): boolean =>
  scope !== '' &&
  [...scope].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x21 && code <= 0x7e && char !== '"' && char !== '\\';
  });
// Matches the redactor's per-secret length budget.
const MAX_CREDENTIAL_LENGTH = 8192;
const MAX_SCOPES = 64;
const CLIENT_AUTH_METHODS: readonly ClientAuthMethod[] = [
  'client_secret_basic',
  'client_secret_post',
];

const readCredential = (
  envVar: string,
  flag: string,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  if (!ENV_VAR_NAME_RE.test(envVar)) {
    throw usageError(`invalid env var name "${envVar}" for ${flag}`);
  }
  const value = env[envVar];
  if (value === undefined || value === '') {
    throw usageError(`environment variable "${envVar}" (for ${flag}) is not set or empty`);
  }
  // Never echo the value: it is (or accompanies) a secret.
  if (CONTROL_CHAR_RE.test(value)) {
    throw usageError(`value of environment variable "${envVar}" contains control characters`);
  }
  if (value.length > MAX_CREDENTIAL_LENGTH) {
    throw usageError(`value of environment variable "${envVar}" is too long`);
  }
  return value;
};

// Literal loopback only: `localhost`, 127.0.0.0/8 and ::1. `*.localhost` is
// NOT accepted — whether it resolves to loopback depends on the resolver,
// and if it resolves to a public address the client secret would travel in
// cleartext.
const isLoopbackHost = (hostname: string): boolean => {
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const lower = bare.toLowerCase();
  if (lower === 'localhost') {
    return true;
  }
  return isIP(lower) === 4 ? lower.startsWith('127.') : lower === '::1';
};

// The token URL receives the client secret, so: https only (RFC 6749 §3.2
// "MUST use TLS"; loopback http is allowed for local development), no
// userinfo, no fragment (§3.2). A query component is allowed (§3.2).
export const assertTokenUrlShape = (url: URL, label: string): void => {
  const problem = (
    [
      [
        url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname)),
        'must use https (http is accepted for loopback only)',
      ],
      [url.username !== '' || url.password !== '', 'must not embed credentials in the URL'],
      [url.hash !== '', 'must not contain a fragment'],
    ] as const
  ).find(([bad]) => bad);
  if (problem !== undefined) {
    throw usageError(`invalid ${label} (${url.origin}${url.pathname}) — ${problem[1]}`);
  }
};

const parseTokenUrlOverride = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError('invalid --upstream-oauth-token-url — must be an absolute https URL');
  }
  assertTokenUrlShape(url, '--upstream-oauth-token-url');
  return url;
};

const parseScopes = (raw: readonly string[]): string[] => {
  if (raw.length > MAX_SCOPES) {
    throw usageError(
      `too many --upstream-oauth-scope values (${String(raw.length)} > ${String(MAX_SCOPES)})`,
    );
  }
  const bad = raw.find((scope) => !isScopeToken(scope));
  if (bad !== undefined) {
    throw usageError(
      'invalid --upstream-oauth-scope — a scope is one RFC 6749 scope-token (no spaces, quotes or backslashes)',
    );
  }
  return [...new Set(raw)];
};

// Undefined when no --upstream-oauth-* flag was given. Every failure is a startup
// usage error, before any network call or credential use.
export const resolveOAuthConfig = (
  opts: OAuthCmdOpts,
  secretHeaderNames: ReadonlySet<string>,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedOAuthConfig | undefined => {
  const anyFlag =
    opts.upstreamOauthClientIdEnv !== undefined ||
    opts.upstreamOauthClientSecretEnv !== undefined ||
    opts.upstreamOauthScheme !== undefined ||
    opts.upstreamOauthScope.length > 0 ||
    opts.upstreamOauthTokenUrl !== undefined;
  if (!anyFlag) {
    return undefined;
  }
  if (
    opts.upstreamOauthClientIdEnv === undefined ||
    opts.upstreamOauthClientSecretEnv === undefined
  ) {
    const given = [
      [opts.upstreamOauthClientIdEnv !== undefined, '--upstream-oauth-client-id-env'],
      [opts.upstreamOauthClientSecretEnv !== undefined, '--upstream-oauth-client-secret-env'],
      [opts.upstreamOauthScheme !== undefined, '--upstream-oauth-scheme'],
      [opts.upstreamOauthScope.length > 0, '--upstream-oauth-scope'],
      [opts.upstreamOauthTokenUrl !== undefined, '--upstream-oauth-token-url'],
    ] as const;
    const named = given.filter(([present]) => present).map(([, flag]) => flag);
    throw usageError(
      `${named.join(', ')} ${named.length === 1 ? 'requires' : 'require'} both --upstream-oauth-client-id-env <ENV> and --upstream-oauth-client-secret-env <ENV>`,
    );
  }
  // The token-bearing header is owned by the OAuth flow; a second source for
  // it would make which credential is sent depend on write order.
  if (secretHeaderNames.has('authorization')) {
    throw usageError(
      '--upstream-oauth-client-id-env/--upstream-oauth-client-secret-env cannot be combined with --header-env Authorization=... (the OAuth2 access token is sent in Authorization)',
    );
  }
  if (!(CLIENT_AUTH_METHODS as readonly string[]).includes(opts.upstreamOauthClientAuth)) {
    throw usageError(
      `--upstream-oauth-client-auth must be one of: ${CLIENT_AUTH_METHODS.join(', ')}`,
    );
  }
  const clientAuth = opts.upstreamOauthClientAuth as ClientAuthMethod;
  const clientId = readCredential(
    opts.upstreamOauthClientIdEnv,
    '--upstream-oauth-client-id-env',
    env,
  );
  const clientSecret = readCredential(
    opts.upstreamOauthClientSecretEnv,
    '--upstream-oauth-client-secret-env',
    env,
  );
  const tokenUrlOverride =
    opts.upstreamOauthTokenUrl === undefined
      ? undefined
      : parseTokenUrlOverride(opts.upstreamOauthTokenUrl);
  return {
    clientId,
    clientSecret,
    envVarHint: `${opts.upstreamOauthClientIdEnv} / ${opts.upstreamOauthClientSecretEnv}`,
    ...(opts.upstreamOauthScheme === undefined ? {} : { scheme: opts.upstreamOauthScheme }),
    scopes: parseScopes(opts.upstreamOauthScope),
    ...(tokenUrlOverride === undefined ? {} : { tokenUrlOverride }),
    clientAuth,
    secretValues: [clientSecret, clientSecretBasic(clientId, clientSecret)],
  };
};

// Picks the token URL: --upstream-oauth-token-url wins; else the clientCredentials
// tokenUrl of the selected oauth2 scheme (--upstream-oauth-scheme, or the only one),
// resolved against the API base (OpenAPI: relative URLs resolve against the
// Server Object URL). A spec-supplied token URL on another origin than the
// API is refused unless the operator confirms it with --upstream-oauth-token-url —
// otherwise whoever controls the spec controls where the secret is sent.
// For the same reason, a spec fetched from a URL with no --base-url (so the
// spec author chose the API origin too) needs --upstream-oauth-token-url.
export const resolveTokenUrl = (
  oauth: ResolvedOAuthConfig,
  spec: Pick<NormalizedSpec, 'securitySchemes'>,
  apiBase: { url: URL; trusted: boolean },
  specSourceIsFile: boolean,
): URL => {
  const base = apiBase.url;
  const candidates = (spec.securitySchemes ?? []).filter(
    (scheme) => scheme.type === 'oauth2' && scheme.clientCredentials !== undefined,
  );
  const names = candidates.map((scheme) => `"${sanitizeSpecText(scheme.name, 128)}"`).join(', ');
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const selected =
    oauth.scheme === undefined ? only : candidates.find((scheme) => scheme.name === oauth.scheme);
  if (oauth.scheme !== undefined && selected === undefined) {
    throw usageError(
      `--upstream-oauth-scheme does not name an oauth2 scheme with a clientCredentials flow${names === '' ? '' : ` (available: ${names})`}`,
    );
  }
  if (oauth.tokenUrlOverride !== undefined) {
    return oauth.tokenUrlOverride;
  }
  if (!specSourceIsFile && !apiBase.trusted) {
    throw usageError(
      'the spec is fetched from a URL and no --base-url is set, so the spec alone would decide where the client secret is sent — pass --base-url <url> or --upstream-oauth-token-url <url>',
    );
  }
  if (
    selected === undefined ||
    selected.type !== 'oauth2' ||
    selected.clientCredentials === undefined
  ) {
    throw usageError(
      candidates.length > 1
        ? `the spec declares several client-credentials schemes (${names}) — pass --upstream-oauth-scheme <name>`
        : 'the spec declares no oauth2 clientCredentials flow — pass --upstream-oauth-token-url <url>',
    );
  }
  let url: URL;
  try {
    url = new URL(selected.clientCredentials.tokenUrl, base);
  } catch {
    throw usageError('the spec token URL is invalid — pass --upstream-oauth-token-url <url>');
  }
  assertTokenUrlShape(url, 'spec token URL');
  if (url.origin !== base.origin) {
    throw usageError(
      `the spec token URL (${url.origin}${url.pathname}) is not on the API origin — pass --upstream-oauth-token-url <url> to confirm where the client secret is sent`,
    );
  }
  return url;
};
