import type { ValidateFunction } from 'ajv';
import load30 from './generated/openapi-3.0-validator.cjs';
import load31 from './generated/openapi-3.1-validator.cjs';
import load32 from './generated/openapi-3.2-validator.cjs';
import { validationError } from '../errors.ts';
import { sanitizeSpecText } from './sanitize.ts';

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

// Each generated module exports a loader that evaluates its validator on
// first use, so a run pays only for the version its spec declares
const VALIDATORS: Record<OpenapiVersion, () => ValidateFunction> = {
  '3.0': load30,
  '3.1': load31,
  '3.2': load32,
};

const getValidator = (version: OpenapiVersion): ValidateFunction => VALIDATORS[version]();

// The declared version is spec content: bound it before it reaches any message
const DECLARED_VERSION_MAX = 32;

type AjvErrorLike = {
  instancePath?: string;
  message?: string;
};

const formatAjvErrors = (errors: readonly AjvErrorLike[]): string => {
  const lines = errors
    .slice(0, 10)
    .map(
      (error) =>
        `  ${error.instancePath === undefined || error.instancePath === '' ? '/' : error.instancePath}: ${error.message ?? 'invalid'}`,
    );
  const more = errors.length > 10 ? `\n  … and ${errors.length - 10} more` : '';
  return `${lines.join('\n')}${more}`;
};

// The minor version a declared "openapi" value belongs to, or undefined when
// it is none this package supports. Patch releases add no features (OAS
// 3.2.1 §2.1), so every 3.x.y maps to its 3.x.
export const openapiVersionOf = (declared: string): OpenapiVersion | undefined =>
  (['3.0', '3.1', '3.2'] as const).find((version) => declared.startsWith(`${version}.`));

export const validateOpenApiDocument = (document: Record<string, unknown>): ValidatedSpec => {
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
  const validate = getValidator(version);
  if (!validate(document)) {
    // The declared version is attacker-controlled past the "3.x." prefix
    // checked by the gate above: sanitize and cap it before it is echoed
    const declaredDisplay = sanitizeSpecText(declared, DECLARED_VERSION_MAX);
    throw validationError(
      `spec failed OpenAPI ${declaredDisplay} schema validation:\n${formatAjvErrors(validate.errors ?? [])}`,
    );
  }
  return { document, version };
};
