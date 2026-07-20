import Ajv04Module from 'ajv-draft-04';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Options, ValidateFunction } from 'ajv';
import schema30 from '@seriousme/openapi-schema-validator/schemas/v3.0/schema.json' with { type: 'json' };
import schema31 from '@seriousme/openapi-schema-validator/schemas/v3.1/schema.json' with { type: 'json' };
import { validationError } from '../errors.ts';
import { sanitizeSpecText } from './sanitize.ts';

// The official OpenAPI meta-schemas are imported as JSON modules so tsdown can
// inline them into the single-file bundle (Plan Decision D1). The 3.0 schema is
// JSON Schema draft-04, the 3.1 schema is draft 2020-12 — hence two Ajv builds.

// CJS interop (Plan Decision D10): TypeScript under nodenext types these CJS
// default imports as namespaces without construct/call signatures, while at
// runtime the binding (and its .default) is the class/function in every module
// system in play (Node ESM, Vite, rolldown — probed). Unwrap once, typed.
interface AjvInstance {
  addFormat: (name: string, format: true) => unknown;
  compile: (schema: object) => ValidateFunction;
}
type AjvConstructor = new (opts: Options) => AjvInstance;

const unwrapDefault = <Unwrapped>(moduleValue: unknown): Unwrapped => {
  const withDefault = moduleValue as { default?: Unwrapped };
  return withDefault.default ?? (moduleValue as Unwrapped);
};

const AjvDraft04 = unwrapDefault<AjvConstructor>(Ajv04Module);
const Ajv2020 = unwrapDefault<AjvConstructor>(Ajv2020Module);
const addFormats = unwrapDefault<(ajv: AjvInstance) => unknown>(addFormatsModule);

export type OpenapiVersion = '3.0' | '3.1';

export interface ValidatedSpec {
  document: Record<string, unknown>;
  version: OpenapiVersion;
}

const compiledValidators: Partial<Record<OpenapiVersion, ValidateFunction>> = {};

const getValidator = (version: OpenapiVersion): ValidateFunction => {
  const existing = compiledValidators[version];
  if (existing !== undefined) {
    return existing;
  }
  // Strict mode stays off: the official meta-schemas are not strict-mode clean
  const ajv =
    version === '3.0' ? new AjvDraft04({ strict: false }) : new Ajv2020({ strict: false });
  addFormats(ajv);
  // Mirrors @seriousme/openapi-schema-validator: media-range is used by the 3.1 schema
  ajv.addFormat('media-range', true);
  const validate = ajv.compile(version === '3.0' ? schema30 : schema31);
  compiledValidators[version] = validate;
  return validate;
};

// The declared version is spec content: bound it before it reaches any message
const DECLARED_VERSION_MAX = 32;

interface AjvErrorLike {
  instancePath?: string;
  message?: string;
}

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
  if (typeof document['swagger'] === 'string') {
    throw validationError(
      'OpenAPI 2.0 (swagger) documents are not supported — provide an OpenAPI 3.0 or 3.1 spec',
    );
  }
  const declared = document['openapi'];
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
    // checked by the gate above (D2): sanitize and cap it before it is echoed
    const declaredDisplay = sanitizeSpecText(declared, DECLARED_VERSION_MAX);
    throw validationError(
      `spec failed OpenAPI ${declaredDisplay} schema validation:\n${formatAjvErrors(validate.errors ?? [])}`,
    );
  }
  return { document, version };
};
