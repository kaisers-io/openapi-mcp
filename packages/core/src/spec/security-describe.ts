import { HEADER_NAME_RE } from '../http/headers.ts';
import { DISPLAY_TEXT_MAX, sanitizeSpecText } from './sanitize.ts';
import type { SecurityScheme } from './security.ts';

// One operator-facing line per security scheme (security-hints.ts lists
// them in `tools` and the `serve` startup warnings). Display only; spec text
// is sanitized here.

const show = (text: string): string => sanitizeSpecText(text, DISPLAY_TEXT_MAX);

// Challenge/response HTTP auth schemes (RFC 7616, 4559, 7486, 7804) need a
// per-request computation; any other registered or custom scheme is assumed
// to take a static `Authorization: <scheme> <credentials>`.
const CHALLENGE_HTTP_SCHEMES: ReadonlySet<string> = new Set([
  'digest',
  'negotiate',
  'ntlm',
  'hoba',
  'mutual',
  'scram-sha-1',
  'scram-sha-256',
]);

// Why a scheme can never be supplied through --header / --header-env, or
// undefined when it can.
export const unsupportedReason = (scheme: SecurityScheme): string | undefined => {
  switch (scheme.type) {
    case 'apiKey': {
      if (scheme.in === 'query') {
        return 'query-string credentials are not supported (a secret in a URL leaks into logs)';
      }
      return scheme.in === 'header' && !HEADER_NAME_RE.test(scheme.paramName)
        ? 'this header name cannot be sent: it is not a valid HTTP header name (RFC 9110 token)'
        : undefined;
    }
    case 'http': {
      return CHALLENGE_HTTP_SCHEMES.has(scheme.scheme)
        ? `http ${show(scheme.scheme)} is a challenge/response scheme and cannot be supplied as a static header`
        : undefined;
    }
    case 'mutualTLS': {
      return 'client certificates are not supported';
    }
    case 'unsupported': {
      return scheme.reason;
    }
    default: {
      return undefined;
    }
  }
};

const authorizationHint = (example: string): string =>
  `pass --header-env Authorization=<ENV> holding "${example}"`;

const HTTP_EXAMPLES: ReadonlyMap<string, string> = new Map([
  ['bearer', 'Bearer <token>'],
  ['basic', 'Basic <base64 user:password>'],
]);

// What a scheme is, for the operator.
const schemeKind = (scheme: SecurityScheme): string => {
  switch (scheme.type) {
    case 'apiKey': {
      return `apiKey in ${scheme.in} "${show(scheme.paramName)}"`;
    }
    case 'http': {
      return `http ${show(scheme.scheme)}`;
    }
    case 'oauth2': {
      if (scheme.clientCredentials !== undefined) {
        return 'oauth2 clientCredentials';
      }
      return `oauth2 ${scheme.flows.length === 0 ? 'no flows' : scheme.flows.join(', ')}`;
    }
    default: {
      return scheme.type;
    }
  }
};

// The flag that supplies a scheme the operator CAN supply.
const supplyHint = (scheme: SecurityScheme): string => {
  switch (scheme.type) {
    case 'apiKey': {
      return scheme.in === 'cookie'
        ? `pass --header-env Cookie=<ENV> holding "${show(scheme.paramName)}=<value>" (several cookie schemes go into that one Cookie value, joined with "; ")`
        : `pass --header-env ${show(scheme.paramName)}=<ENV>`;
    }
    case 'http': {
      return authorizationHint(
        HTTP_EXAMPLES.get(scheme.scheme) ?? `${show(scheme.scheme)} <credentials>`,
      );
    }
    case 'oauth2': {
      const how =
        scheme.clientCredentials === undefined
          ? `interactive OAuth flows are not supported; ${authorizationHint('Bearer <token>')} with a token obtained elsewhere`
          : `pass --upstream-oauth-client-id-env <ENV> and --upstream-oauth-client-secret-env <ENV>, or ${authorizationHint('Bearer <token>')}`;
      // OpenAPI 3.2 `oauth2MetadataUrl` (RFC 8414): shown, never fetched
      return scheme.metadataUrl === undefined
        ? how
        : `${how} (authorization server metadata: ${show(scheme.metadataUrl)})`;
    }
    default: {
      return `${authorizationHint('Bearer <token>')} with a token obtained elsewhere`;
    }
  }
};

// One operator-facing line per scheme: what it is, and the flag that
// supplies it (or why it cannot be supplied). Spec text is sanitized here.
export const describeSecurityScheme = (scheme: SecurityScheme): string => {
  const label = `security scheme "${show(scheme.name)}"`;
  const reason = unsupportedReason(scheme);
  if (scheme.type === 'unsupported') {
    return `${label} — not supported: ${reason ?? 'malformed security scheme'}`;
  }
  const deprecated = scheme.deprecated === true ? ', deprecated' : '';
  return `${label} (${schemeKind(scheme)}${deprecated}) — ${reason ?? supplyHint(scheme)}`;
};
