import type { ValidateFunction } from 'ajv';
import { OpenapiMcpError, specValidationError, validationError } from '../errors.ts';
import { sanitizeSpecText } from './sanitize.ts';
import { formatValidationIssues, validationIssues } from './validation-issues.ts';

// The official OpenAPI meta-schemas (3.0: JSON Schema draft-04, 3.1 and 3.2:
// draft 2020-12), precompiled at development time into Ajv standalone code (issue
// kaisers-io/openapi-mcp-archive#76, see generate-validators.ts). Compiling
// them at runtime cost about 120 ms on every run that processed a spec; the
// generated code is what Ajv compiles, with the same options, so the verdicts
// and error objects are identical.

export type OpenapiVersion = '3.0' | '3.1' | '3.2';

export type ValidatedSpec = {
  document: Record<string, unknown>;
  version: OpenapiVersion;
};

// One loader per version, each evaluating its validator on first use, so a
// run pays only for the version its spec declares
export type OpenApiValidators = Readonly<Record<OpenapiVersion, () => ValidateFunction>>;

// The generated code is large (about 750 KB), and a run that serves its spec
// from the cache never validates: it is loaded only when a spec is (#47)
export const loadOpenApiValidators = async (): Promise<OpenApiValidators> => {
  const { OPENAPI_VALIDATORS } = await import('./validators.ts');
  return OPENAPI_VALIDATORS;
};

// The validators above stop at the first error. These collect every error,
// up to DIAGNOSER_ERROR_CAP (generate-validators.ts), and run only on a
// spec the fast one refused, so the verdict never depends on them (#131).
const loadOpenApiDiagnosers = async (): Promise<OpenApiValidators> => {
  const { OPENAPI_DIAGNOSERS } = await import('./diagnosers.ts');
  return OPENAPI_DIAGNOSERS;
};

type ErrorCap = { openapiMcpErrorCap: NonNullable<ValidateFunction['errors']> };

const isErrorCap = (thrown: unknown): thrown is ErrorCap =>
  typeof thrown === 'object' && thrown !== null && 'openapiMcpErrorCap' in thrown;

// The errors a diagnoser collects, and whether it stopped at its cap
const diagnosed = (
  diagnose: ValidateFunction,
  document: Record<string, unknown>,
): { errors: NonNullable<ValidateFunction['errors']>; capped: boolean } => {
  try {
    diagnose(document);
    return { errors: diagnose.errors ?? [], capped: false };
  } catch (error) {
    if (isErrorCap(error)) {
      return { errors: error.openapiMcpErrorCap, capped: true };
    }
    throw error;
  }
};

// What to do about it: fix the spec, or, when it can't be changed,
// correct a copy with an OpenAPI Overlay
const FIX_HINT =
  'Fix the spec; if you cannot change it, correct a copy with an OpenAPI Overlay: ' +
  'https://github.com/kaisers-io/openapi-mcp/blob/main/docs/overlays.md';

// The declared version is spec content: bound it before it reaches any message
const DECLARED_VERSION_MAX = 32;

// The minor version a declared "openapi" value belongs to, or undefined when
// it is none this package supports. Patch releases add no features (OAS
// 3.2.1 §2.1), so every 3.x.y maps to its 3.x.
export const openapiVersionOf = (declared: string): OpenapiVersion | undefined =>
  (['3.0', '3.1', '3.2'] as const).find((version) => declared.startsWith(`${version}.`));

export const validateOpenApiDocument = (
  document: Record<string, unknown>,
  validators: OpenApiValidators,
  diagnosers?: OpenApiValidators,
): ValidatedSpec => {
  // Any `swagger` field marks a 2.0 document: unquoted in YAML (`swagger: 2.0`)
  // the version parses as a number. The value is never echoed.
  if (document['swagger'] !== undefined) {
    throw validationError(
      'OpenAPI 2.0 (swagger) documents are not supported — provide an OpenAPI 3.0, 3.1 or 3.2 spec',
    );
  }
  const declared = document['openapi'];
  const version = typeof declared === 'string' ? openapiVersionOf(declared) : undefined;
  if (typeof declared !== 'string' || version === undefined) {
    throw validationError('spec must declare an "openapi" version of 3.0.x, 3.1.x or 3.2.x');
  }
  const validate = validators[version]();
  if (!validate(document)) {
    // The declared version is attacker-controlled past the "3.x." prefix
    // checked by the gate above: sanitize and cap it before it is echoed
    const declaredDisplay = sanitizeSpecText(declared, DECLARED_VERSION_MAX);
    const first = { errors: validate.errors ?? [], capped: false };
    const found = diagnosers === undefined ? first : diagnosed(diagnosers[version](), document);
    const { errors, capped } = found.errors.length === 0 ? first : found;
    const issues = validationIssues(errors);
    const count = `${String(issues.length)}${capped ? ' or more' : ''}`;
    const noun = issues.length === 1 && !capped ? 'location' : 'locations';
    throw specValidationError(
      `spec failed OpenAPI ${declaredDisplay} schema validation at ${count} ${noun}:\n${formatValidationIssues(issues, capped)}\n${FIX_HINT}`,
      issues,
    );
  }
  return { document, version };
};

// Validates with the fast validator, and lists every failing location only
// for a spec it refused
export const validateSpecDocument = async (
  document: Record<string, unknown>,
): Promise<ValidatedSpec> => {
  const validators = await loadOpenApiValidators();
  try {
    return validateOpenApiDocument(document, validators);
  } catch (error) {
    if (!(error instanceof OpenapiMcpError) || error.errors === undefined) {
      throw error;
    }
    return validateOpenApiDocument(document, validators, await loadOpenApiDiagnosers());
  }
};
