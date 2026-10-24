import { DISPLAY_TEXT_MAX, sanitizeSpecText } from './sanitize.ts';
import { describeSecurityScheme, unsupportedReason } from './security-describe.ts';
import type { SecurityRequirement, SecurityScheme } from './security.ts';

// Operator-facing credential hints (`tools`, `serve` startup warnings) on
// top of security.ts. Display only; spec text is sanitized here.

const show = (text: string): string => sanitizeSpecText(text, DISPLAY_TEXT_MAX);

// What the operator configured, as far as satisfying a requirement goes.
export type ConfiguredCredentials = {
  // Lowercased names of every --header / --header-env header.
  headerNames: ReadonlySet<string>;
  // --upstream-oauth-client-*-env set: their token (in Authorization)
  // satisfies any oauth2 scheme with a clientCredentials flow.
  oauthClientCredentials?: boolean;
};

// The header a scheme's credential travels in (lowercased), or undefined
// when it cannot be supplied as a header at all.
const headerOf = (scheme: SecurityScheme): string | undefined => {
  if (unsupportedReason(scheme) !== undefined) {
    return undefined;
  }
  switch (scheme.type) {
    case 'apiKey': {
      return scheme.in === 'cookie' ? 'cookie' : scheme.paramName.toLowerCase();
    }
    case 'http':
    case 'oauth2':
    case 'openIdConnect': {
      return 'authorization';
    }
    default: {
      return undefined;
    }
  }
};

// One alternative (all its schemes together) is satisfiable only when every
// scheme travels in a configured header AND no two schemes need their own
// Authorization header — one request carries one. Several cookie schemes
// are fine: they share one Cookie value.
const alternativeSatisfied = (
  alternative: SecurityRequirement,
  byName: ReadonlyMap<string, SecurityScheme>,
  configured: ConfiguredCredentials,
): boolean => {
  const schemes = Object.keys(alternative).map((name) => byName.get(name));
  const supplied = (scheme: SecurityScheme | undefined): boolean => {
    const header = scheme === undefined ? undefined : headerOf(scheme);
    const viaClientCredentials =
      scheme?.type === 'oauth2' && scheme.clientCredentials !== undefined;
    return (
      header !== undefined &&
      (configured.headerNames.has(header) ||
        (viaClientCredentials && configured.oauthClientCredentials === true))
    );
  };
  const authorizationCount = schemes.filter(
    (scheme) => scheme !== undefined && headerOf(scheme) === 'authorization',
  ).length;
  return schemes.every((scheme) => supplied(scheme)) && authorizationCount <= 1;
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
  // Present when the scheme cannot be supplied through --header-env: why.
  reason?: string;
};

// OAS: an operation-level `security` overrides the root one; `[]` removes it.
const effectiveRequirements = (
  spec: SecuritySpec,
  operation: SecuredOperation,
): readonly SecurityRequirement[] => operation.security ?? spec.security ?? [];

// Schemes referenced by the given (exposed) operations, in declaration
// order, each with its hint. A requirement naming an undeclared scheme is
// skipped here (it has nothing to describe) but still counts as unsatisfied
// in `unsatisfiedSecurityWarnings`.
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
    .map((scheme) => {
      const usage: SchemeUsage = {
        scheme: scheme.name,
        type: scheme.type,
        toolCount: counts.get(scheme.name) ?? 0,
        hint: describeSecurityScheme(scheme),
      };
      const reason = unsupportedReason(scheme);
      if (reason !== undefined) {
        usage.reason = reason;
      }
      return usage;
    });
};

const MAX_WARNINGS = 8;

// One alternative as text: its schemes' hints, joined with "and" — every
// one of them is needed at once.
const describeAlternative = (
  alternative: SecurityRequirement,
  byName: ReadonlyMap<string, SecurityScheme>,
): string => {
  const names = Object.keys(alternative);
  const hints = names.map((name) => {
    const scheme = byName.get(name);
    return scheme === undefined
      ? `security scheme "${show(name)}" is not declared in components.securitySchemes`
      : describeSecurityScheme(scheme);
  });
  const authorizationCount = names.filter((name) => {
    const scheme = byName.get(name);
    return scheme !== undefined && headerOf(scheme) === 'authorization';
  }).length;
  const together = names.length > 1 ? `all of: ${hints.join(' AND ')}` : (hints[0] ?? '');
  return authorizationCount > 1
    ? `${together} (cannot be met: ${String(authorizationCount)} schemes each need the one Authorization header)`
    : together;
};

// One warning per distinct unsatisfied requirement list among the given
// operations: "N exposed operations (e.g. GET /x) require ... — <hints>".
// An operation is satisfied when ANY alternative has ALL its schemes
// satisfied (an empty alternative always is). Alternatives are joined with
// "; OR", the schemes within one alternative with "AND".
export const unsatisfiedSecurityWarnings = (
  spec: SecuritySpec,
  operations: readonly SecuredOperation[],
  configured: ConfiguredCredentials,
): string[] => {
  const byName = new Map((spec.securitySchemes ?? []).map((scheme) => [scheme.name, scheme]));
  const groups = new Map<
    string,
    { example: SecuredOperation; count: number; requirements: readonly SecurityRequirement[] }
  >();
  for (const operation of operations) {
    const requirements = effectiveRequirements(spec, operation);
    const satisfied =
      requirements.length === 0 ||
      requirements.some((req) => alternativeSatisfied(req, byName, configured));
    if (satisfied) {
      continue;
    }
    const key = JSON.stringify(requirements.map((req) => Object.keys(req).toSorted()));
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { example: operation, count: 1, requirements });
    } else {
      group.count += 1;
    }
  }
  return [...groups.values()].slice(0, MAX_WARNINGS).map(({ example, count, requirements }) => {
    const alternatives = requirements.map((req) => describeAlternative(req, byName));
    const subject =
      count === 1
        ? '1 exposed operation (e.g. %s) requires'
        : `${String(count)} exposed operations (e.g. %s) require`;
    const where = `${example.method.toUpperCase()} ${show(example.path)}`;
    return `${subject.replace('%s', where)} credentials no configured header satisfies: ${alternatives.join('; OR ')}`;
  });
};
