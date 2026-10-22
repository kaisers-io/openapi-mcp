import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server';
import { extractBearerToken } from './auth.ts';
import type { KeySet } from './jwk.ts';
import { verifyJwt } from './jwt.ts';
import type { JwtFailure, VerifiedAccessToken } from './jwt.ts';
import { loadIssuerKeys, parseSecureUrl } from './oauth-discovery.ts';
import type { IssuerEgressConfig, OAuthDeps } from './oauth-discovery.ts';

// OAuth 2.1 resource-server mode for the Streamable HTTP transport, per the
// MCP authorization spec (2026-07-28, basic/authorization):
// - Protected Resource Metadata (RFC 9728) names the authorization server;
// - a 401 carries `WWW-Authenticate: Bearer resource_metadata=…` so clients
//   discover it, and a token lacking a required scope gets 403
//   `insufficient_scope` (RFC 6750 §3.1);
// - access tokens are JWTs (RFC 9068) validated LOCALLY against the issuer's
//   JWKS — signature, `iss`, `aud` (this server's canonical resource URI,
//   RFC 8707), `exp`/`nbf` and scopes (see jwt.ts).
// The token is only ever read from the Authorization header and is never
// forwarded: upstream credentials stay the operator's --header-env headers,
// as the spec's token-passthrough prohibition requires. Discovery and JWKS
// caching live in oauth-discovery.ts.

export type OAuthResourceServerConfig = IssuerEgressConfig & {
  // This server's canonical resource URI (RFC 8707 / RFC 9728 `resource`):
  // the value tokens must carry in `aud`, and the public URL clients use.
  audience: string;
  requiredScopes: readonly string[];
};

export type { OAuthDeps } from './oauth-discovery.ts';

export type OAuthDecision =
  | { outcome: 'allow'; token: VerifiedAccessToken }
  | {
      outcome: 'deny';
      status: 401 | 403 | 503;
      headers: Record<string, string>;
      body: string;
      // Operator-facing cause (never contains the token), for the
      // transport's rate-bounded error sink. Absent for a request that
      // simply carried no token — the first step of every client's
      // discovery flow, not something worth reporting.
      reason?: string;
    };

export type OAuthResourceServer = {
  // The path the Protected Resource Metadata document is served at.
  metadataPath: string;
  metadataDocument: Readonly<Record<string, unknown>>;
  // The `Host` clients address this server by — the audience's authority.
  publicHost: string;
  authenticate: (authorization?: string) => Promise<OAuthDecision>;
};

// HTTP quoted-string (RFC 9110 §5.6.4). Every value here is operator- or
// package-authored ASCII, but escaping keeps the header well-formed anyway.
const quoted = (value: string): string => `"${value.replaceAll(/[\\"]/gu, String.raw`\$&`)}"`;

// Fixed, package-authored descriptions: the specific cause goes to the
// operator's log, not to an unauthenticated caller.
const INVALID_TOKEN_DESCRIPTION = 'The access token is invalid or expired';
const INSUFFICIENT_SCOPE_DESCRIPTION = 'The access token lacks a required scope';

const FAILURE_TEXT: Record<JwtFailure, string> = {
  malformed: 'malformed token',
  'unsupported-alg': 'unsupported or forbidden alg',
  'unsupported-typ': 'unsupported typ',
  crit: 'unsupported crit header',
  'missing-kid': 'token has no kid',
  'unknown-kid': 'kid not in the JWKS',
  'key-mismatch': 'key does not fit the alg',
  'bad-signature': 'signature does not verify',
  'wrong-issuer': 'wrong iss',
  'wrong-audience': 'aud does not name this resource',
  expired: 'token expired',
  'not-yet-valid': 'token not yet valid (nbf)',
  'issued-in-future': 'iat in the future',
  'missing-exp': 'token has no exp',
};

export const createOAuthResourceServer = async (
  config: OAuthResourceServerConfig,
  deps: OAuthDeps,
): Promise<OAuthResourceServer> => {
  const issuer = parseSecureUrl(config.issuer, '--oauth-issuer');
  const audience = parseSecureUrl(config.audience, '--oauth-audience');
  const jwks = await loadIssuerKeys(issuer, config, deps);

  const metadataUrl = getOAuthProtectedResourceMetadataUrl(audience);
  const scopeParam =
    config.requiredScopes.length === 0 ? '' : `, scope=${quoted(config.requiredScopes.join(' '))}`;
  const metadataParam = `resource_metadata=${quoted(metadataUrl)}`;
  const json = { 'content-type': 'application/json' };

  const deny = (
    status: 401 | 403,
    error: 'invalid_token' | 'insufficient_scope',
    reason: string,
  ): OAuthDecision => {
    const description =
      error === 'insufficient_scope' ? INSUFFICIENT_SCOPE_DESCRIPTION : INVALID_TOKEN_DESCRIPTION;
    return {
      outcome: 'deny',
      status,
      headers: {
        'www-authenticate': `Bearer error=${quoted(error)}, error_description=${quoted(description)}, ${metadataParam}${scopeParam}`,
        ...json,
      },
      body: JSON.stringify({ error, error_description: description }),
      reason,
    };
  };
  // RFC 6750 §3.1: a request without credentials gets the challenge but no
  // error code.
  const missingToken: OAuthDecision = {
    outcome: 'deny',
    status: 401,
    headers: { 'www-authenticate': `Bearer ${metadataParam}${scopeParam}` },
    body: '',
  };

  const authenticate = async (authorization?: string): Promise<OAuthDecision> => {
    const token = extractBearerToken(authorization);
    if (token === undefined) {
      return missingToken;
    }
    const verifyWith = (keys: KeySet) =>
      verifyJwt(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        nowMs: deps.now(),
      });
    const keys = await jwks.get();
    let result = keys === undefined ? undefined : verifyWith(keys);
    if (result !== undefined && !result.ok && result.reason === 'unknown-kid') {
      const refreshed = await jwks.refreshForUnknownKid();
      result = refreshed === undefined ? undefined : verifyWith(refreshed);
    }
    if (result === undefined) {
      return {
        outcome: 'deny',
        status: 503,
        headers: json,
        body: JSON.stringify({ error: 'temporarily_unavailable' }),
        reason: 'the authorization server JWKS could not be refreshed',
      };
    }
    if (!result.ok) {
      return deny(401, 'invalid_token', `token rejected: ${FAILURE_TEXT[result.reason]}`);
    }
    const granted = new Set(result.token.scopes);
    const missing = config.requiredScopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      return deny(403, 'insufficient_scope', `token lacks scope ${missing.join(' ')}`);
    }
    return { outcome: 'allow', token: result.token };
  };

  return {
    metadataPath: new URL(metadataUrl).pathname,
    // RFC 9728 §2. `resource` is the configured audience verbatim: clients
    // compare it with the server URL they used.
    metadataDocument: Object.freeze({
      resource: config.audience,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ['header'],
      ...(config.requiredScopes.length === 0
        ? {}
        : { scopes_supported: [...config.requiredScopes] }),
    }),
    publicHost: audience.host,
    authenticate,
  };
};
