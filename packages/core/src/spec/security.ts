import { DISPLAY_TEXT_MAX, sanitizeSpecText } from './sanitize.ts';

// `components.securitySchemes` and the root/operation `security`
// requirements (OpenAPI 3.x Security Scheme / Security Requirement Objects).
// Read for two purposes only: telling the operator which credential a spec
// expects (`tools` hints, `serve` startup warnings) and locating an OAuth2
// client-credentials token endpoint. Nothing here changes how a request is
// built — a credential still only ever comes from an operator-configured
// env var — so every malformed shape degrades to "no information", never to
// a startup failure. The operator-facing hints and warnings built on top
// of this live in security-hints.ts.

export type ClientCredentialsFlow = {
  // Raw spec text: a URL (possibly relative to the server URL, OAS §4.7) that
  // the CLI validates before any use.
  tokenUrl: string;
  scopes: readonly string[];
};

export type SecurityScheme = (
  | { name: string; type: 'apiKey'; in: 'header' | 'query' | 'cookie'; paramName: string }
  | { name: string; type: 'http'; scheme: string }
  | {
      name: string;
      type: 'oauth2';
      flows: readonly string[];
      clientCredentials?: ClientCredentialsFlow;
    }
  | { name: string; type: 'openIdConnect' | 'mutualTLS' }
  // `reason` is package-authored text; any spec value in it is sanitized.
  | { name: string; type: 'unsupported'; reason: string }
) & {
  // OpenAPI 3.2 `deprecated: true`: the spec discourages new use of the scheme
  deprecated?: true;
};

// Scheme name -> required scopes. `{}` makes security optional (OAS:
// "an empty security requirement ({}) can be included in the array").
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

// Bounds the work a hostile spec can cause in these display-only paths.
const MAX_SCHEMES = 64;
const MAX_REQUIREMENTS = 32;
const MAX_SCOPES = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const show = (text: string): string => sanitizeSpecText(text, DISPLAY_TEXT_MAX);

// `deviceAuthorization` is new in OpenAPI 3.2
const OAUTH_FLOWS = [
  'implicit',
  'password',
  'clientCredentials',
  'authorizationCode',
  'deviceAuthorization',
] as const;

const schemeOf = (name: string, raw: Record<string, unknown>): SecurityScheme => {
  const { type } = raw;
  if (type === 'apiKey') {
    const location = raw['in'];
    const paramName = raw['name'];
    if (
      (location === 'header' || location === 'query' || location === 'cookie') &&
      typeof paramName === 'string' &&
      paramName !== ''
    ) {
      return { name, type, in: location, paramName };
    }
    return {
      name,
      type: 'unsupported',
      reason: 'apiKey scheme without a valid "in" (header, query or cookie) and "name"',
    };
  }
  if (type === 'http') {
    const { scheme } = raw;
    return typeof scheme === 'string' && scheme !== ''
      ? { name, type, scheme: scheme.toLowerCase() }
      : { name, type: 'unsupported', reason: 'http scheme without a "scheme" value' };
  }
  if (type === 'oauth2') {
    const flows = isRecord(raw['flows']) ? raw['flows'] : {};
    const declared = OAUTH_FLOWS.filter((flow) => isRecord(flows[flow]));
    const cc = flows['clientCredentials'];
    if (isRecord(cc) && typeof cc['tokenUrl'] === 'string' && cc['tokenUrl'] !== '') {
      const scopes = isRecord(cc['scopes']) ? Object.keys(cc['scopes']).slice(0, MAX_SCOPES) : [];
      return {
        name,
        type,
        flows: declared,
        clientCredentials: { tokenUrl: cc['tokenUrl'], scopes },
      };
    }
    return { name, type, flows: declared.filter((flow) => flow !== 'clientCredentials') };
  }
  if (type === 'openIdConnect' || type === 'mutualTLS') {
    return { name, type };
  }
  return {
    name,
    type: 'unsupported',
    reason:
      typeof type === 'string'
        ? `unknown security scheme type "${show(type)}"`
        : 'security scheme without a "type"',
  };
};

const toScheme = (name: string, raw: Record<string, unknown>): SecurityScheme => {
  const scheme = schemeOf(name, raw);
  return raw['deprecated'] === true ? { ...scheme, deprecated: true } : scheme;
};

export const extractSecuritySchemes = (document: Record<string, unknown>): SecurityScheme[] => {
  const components = isRecord(document['components']) ? document['components'] : {};
  const schemes = isRecord(components['securitySchemes']) ? components['securitySchemes'] : {};
  return Object.entries(schemes)
    .slice(0, MAX_SCHEMES)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, raw]) => toScheme(name, raw));
};

// `undefined` when absent or malformed: "no information" (the root default
// applies), never a guess that an operation is unauthenticated.
export const parseSecurityRequirements = (value: unknown): SecurityRequirement[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENTS) {
    return undefined;
  }
  const requirements: SecurityRequirement[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const pairs = Object.entries(entry);
    if (
      !pairs.every(
        ([, scopes]) => Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string'),
      )
    ) {
      return undefined;
    }
    // Object.fromEntries defines own properties, so a scheme literally named
    // "__proto__" stays a plain key rather than hitting the prototype setter.
    requirements.push(
      Object.fromEntries(
        pairs.map(([scheme, scopes]) => [scheme, (scopes as string[]).slice(0, MAX_SCOPES)]),
      ),
    );
  }
  return requirements;
};
