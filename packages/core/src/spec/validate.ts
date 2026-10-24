import type { ValidateFunction } from 'ajv';
import validate30 from './generated/openapi-3.0-validator.cjs';
import validate31 from './generated/openapi-3.1-validator.cjs';
import { validationError } from '../errors.ts';
import { sanitizeSpecText } from './sanitize.ts';

// The official OpenAPI meta-schemas (3.0: JSON Schema draft-04, 3.1: draft
// 2020-12), precompiled at development time into Ajv standalone code (issue
// kaisers-io/openapi-mcp-archive#76, see generate-validators.ts). Compiling
// them at runtime cost about 120 ms on every run that processed a spec; the
// generated code is what Ajv compiles, with the same options, so the verdicts
// and error objects are identical.

export type OpenapiVersion = '3.0' | '3.1';

export type ValidatedSpec = {
  document: Record<string, unknown>;
  version: OpenapiVersion;
};

const VALIDATORS: Record<OpenapiVersion, ValidateFunction> = {
  '3.0': validate30,
  '3.1': validate31,
};

const getValidator = (version: OpenapiVersion): ValidateFunction => VALIDATORS[version];

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

export const validateOpenApiDocument = (document: Record<string, unknown>): ValidatedSpec => {
  // Any `swagger` field marks a 2.0 document: unquoted in YAML (`swagger: 2.0`)
  // the version parses as a number. The value is never echoed.
  if (document['swagger'] !== undefined) {
    throw validationError(
      'OpenAPI 2.0 (swagger) documents are not supported — provide an OpenAPI 3.0 or 3.1 spec',
    );
  }
  const declared = document['openapi'];
  if (typeof declared === 'string' && declared.startsWith('3.2.')) {
    // OpenAPI 3.2 adds features (the QUERY method, `in: querystring`
    // parameters, ...) that tool generation does not handle yet (issue #11)
    throw validationError(
      `OpenAPI 3.2 documents are not supported yet (the spec declares "${sanitizeSpecText(declared, DECLARED_VERSION_MAX)}") — provide an OpenAPI 3.0 or 3.1 spec`,
    );
  }
  if (
    typeof declared !== 'string' ||
    !(declared.startsWith('3.0.') || declared.startsWith('3.1.'))
  ) {
    throw validationError('spec must declare an "openapi" version of 3.0.x or 3.1.x');
  }
  const version: OpenapiVersion = declared.startsWith('3.0.') ? '3.0' : '3.1';
  const validate = getValidator(version);
  if (!validate(document)) {
    // The declared version is attacker-controlled past the "3.0."/"3.1." prefix
    // checked by the gate above: sanitize and cap it before it is echoed
    const declaredDisplay = sanitizeSpecText(declared, DECLARED_VERSION_MAX);
    throw validationError(
      `spec failed OpenAPI ${declaredDisplay} schema validation:\n${formatAjvErrors(validate.errors ?? [])}`,
    );
  }
  return { document, version };
};
