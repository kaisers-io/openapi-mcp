import { DISPLAY_TEXT_MAX, sanitizeSpecText } from './sanitize.ts';

// OpenAPI 3.x `components.securitySchemes` and `security` requirements, read
// only to tell the operator which credential a spec expects and to locate an
// OAuth2 client-credentials token endpoint. A credential still only ever
// comes from an operator-configured env var, so every malformed shape
// degrades to "no information", never to a startup failure.

export type ClientCredentialsFlow = {
  // Raw spec text: a URL (possibly relative to the server URL, OAS §4.7) that
  // the CLI validates before any use.
  tokenUrl: string;
  scopes: readonly string[];
};

export type SecurityScheme =
  | { name: string; type: 'apiKey'; in: 'header' | 'query' | 'cookie'; paramName: string }
  | { name: string; type: 'http'; scheme: string }
  | {
      name: string;
      type: 'oauth2';
      flows: readonly string[];
      clientCredentials?: ClientCredentialsFlow;
    }
  | { name: string; type: 'openIdConnect' | 'mutualTLS' | 'unsupported' };

// Scheme name -> required scopes. `{}` makes security optional (OAS:
// "an empty security requirement ({}) can be included in the array").
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

// Bounds the work a hostile spec can cause in these display-only paths.
const MAX_SCHEMES = 64;
const MAX_REQUIREMENTS = 32;
const MAX_SCOPES = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const OAUTH_FLOWS = ['implicit', 'password', 'clientCredentials', 'authorizationCode'] as const;

const toScheme = (name: string, raw: Record<string, unknown>): SecurityScheme => {
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
    return { name, type: 'unsupported' };
  }
  if (type === 'http') {
    const { scheme } = raw;
    return typeof scheme === 'string' && scheme !== ''
      ? { name, type, scheme: scheme.toLowerCase() }
      : { name, type: 'unsupported' };
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
  return { name, type: 'unsupported' };
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

// What the operator configured, as far as satisfying a requirement goes.
export type ConfiguredCredentials = {
  // Lowercased names of every --header / --header-env header.
  headerNames: ReadonlySet<string>;
  // --oauth-*: satisfies any oauth2 scheme with a clientCredentials flow.
  oauthClientCredentials?: boolean;
};

const satisfies = (
  scheme: SecurityScheme | undefined,
  configured: ConfiguredCredentials,
): boolean => {
  if (scheme === undefined) {
    return false;
  }
  switch (scheme.type) {
    case 'apiKey': {
      const header = scheme.in === 'cookie' ? 'cookie' : scheme.paramName.toLowerCase();
      return scheme.in !== 'query' && configured.headerNames.has(header);
    }
    case 'oauth2': {
      const ours =
        configured.oauthClientCredentials === true && scheme.clientCredentials !== undefined;
      return ours || configured.headerNames.has('authorization');
    }
    case 'http':
    case 'openIdConnect': {
      return configured.headerNames.has('authorization');
    }
    default: {
      return false;
    }
  }
};

const show = (text: string): string => sanitizeSpecText(text, DISPLAY_TEXT_MAX);

const authorizationHint = (example: string): string =>
  `pass --header-env Authorization=<ENV> holding "${example}"`;

const HTTP_EXAMPLES: ReadonlyMap<string, string> = new Map([
  ['bearer', 'Bearer <token>'],
  ['basic', 'Basic <base64 user:password>'],
]);

// One operator-facing line per scheme: what it is, and the flag that
// supplies it (or why it cannot be supplied). Spec text is sanitized here.
export const describeSecurityScheme = (scheme: SecurityScheme): string => {
  const label = `security scheme "${show(scheme.name)}"`;
  switch (scheme.type) {
    case 'apiKey': {
      const where = `(apiKey in ${scheme.in} "${show(scheme.paramName)}")`;
      if (scheme.in === 'query') {
        return `${label} ${where} — query-string credentials are not supported (a secret in a URL leaks into logs)`;
      }
      if (scheme.in === 'cookie') {
        return `${label} ${where} — pass --header-env Cookie=<ENV> holding "${show(scheme.paramName)}=<value>"`;
      }
      return `${label} ${where} — pass --header-env ${show(scheme.paramName)}=<ENV>`;
    }
    case 'http': {
      const example = HTTP_EXAMPLES.get(scheme.scheme) ?? `${show(scheme.scheme)} <credentials>`;
      return `${label} (http ${show(scheme.scheme)}) — ${authorizationHint(example)}`;
    }
    case 'oauth2': {
      if (scheme.clientCredentials !== undefined) {
        return `${label} (oauth2 clientCredentials) — pass --oauth-client-id-env <ENV> and --oauth-client-secret-env <ENV>, or ${authorizationHint('Bearer <token>')}`;
      }
      const flows = scheme.flows.length === 0 ? 'no flows' : scheme.flows.join(', ');
      return `${label} (oauth2 ${flows}) — interactive OAuth flows are not supported; ${authorizationHint('Bearer <token>')} with a token obtained elsewhere`;
    }
    case 'openIdConnect': {
      return `${label} (openIdConnect) — ${authorizationHint('Bearer <token>')} with a token obtained elsewhere`;
    }
    case 'mutualTLS': {
      return `${label} (mutualTLS) — client certificates are not supported`;
    }
    default: {
      return `${label} — unrecognized or malformed security scheme`;
    }
  }
};

// The operation fields this module reads; OperationRecord satisfies it.
export type SecuredOperation = {
  method: string;
  path: string;
  security?: readonly SecurityRequirement[];
};

export type SecuritySpec = {
  securitySchemes?: readonly SecurityScheme[];
  security?: readonly SecurityRequirement[];
};

export type SchemeUsage = {
  scheme: string;
  type: SecurityScheme['type'];
  // How many of the given operations list this scheme in any alternative.
  toolCount: number;
  hint: string;
};

// OAS: an operation-level `security` overrides the root one; `[]` removes it.
const effectiveRequirements = (
  spec: SecuritySpec,
  operation: SecuredOperation,
): readonly SecurityRequirement[] => operation.security ?? spec.security ?? [];

// Declared schemes the given (exposed) operations reference, each with its
// hint (an undeclared name has nothing to describe; it is only warned about).
export const summarizeSecurity = (
  spec: SecuritySpec,
  operations: readonly SecuredOperation[],
): SchemeUsage[] => {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    const names = new Set(
      effectiveRequirements(spec, operation).flatMap((req) => Object.keys(req)),
    );
    for (const name of names) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return (spec.securitySchemes ?? [])
    .filter((scheme) => counts.has(scheme.name))
    .map((scheme) => ({
      scheme: scheme.name,
      type: scheme.type,
      toolCount: counts.get(scheme.name) ?? 0,
      hint: describeSecurityScheme(scheme),
    }));
};

const MAX_WARNINGS = 8;

// One warning per distinct unsatisfied requirement list among the given
// operations. An operation is satisfied when ANY alternative has ALL its
// schemes satisfied (an empty alternative always is).
export const unsatisfiedSecurityWarnings = (
  spec: SecuritySpec,
  operations: readonly SecuredOperation[],
  configured: ConfiguredCredentials,
): string[] => {
  const byName = new Map((spec.securitySchemes ?? []).map((scheme) => [scheme.name, scheme]));
  const groups = new Map<string, { example: SecuredOperation; count: number; names: string[] }>();
  for (const operation of operations) {
    const requirements = effectiveRequirements(spec, operation);
    const satisfied =
      requirements.length === 0 ||
      requirements.some((req) =>
        Object.keys(req).every((name) => satisfies(byName.get(name), configured)),
      );
    if (satisfied) {
      continue;
    }
    const names = [...new Set(requirements.flatMap((req) => Object.keys(req)))];
    const key = JSON.stringify(requirements.map((req) => Object.keys(req).toSorted()));
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { example: operation, count: 1, names });
    } else {
      group.count += 1;
    }
  }
  return [...groups.values()].slice(0, MAX_WARNINGS).map(({ example, count, names }) => {
    const hints = names.map((name) => {
      const scheme = byName.get(name);
      return scheme === undefined
        ? `security scheme "${show(name)}" is not declared in components.securitySchemes`
        : describeSecurityScheme(scheme);
    });
    const subject = count === 1 ? '1 exposed operation' : `${String(count)} exposed operations`;
    return `${subject} (e.g. ${example.method.toUpperCase()} ${show(example.path)}) require credentials no configured header satisfies: ${hints.join('; or ')}`;
  });
};
