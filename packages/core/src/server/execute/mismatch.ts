import type { Redactor } from '../../redact.ts';
import { sanitizeSpecText } from '../../spec/sanitize.ts';
import type { ToolCallOutcome } from '../result.ts';
import type { ErrorObject } from './envelope-validators.ts';

// Why an upstream response was refused, for the operator's call log only
// (`--log json`, issue #24). The client still sees the same generic message.
// Nothing here comes from the response itself: the location is read off the
// SCHEMA path (spec property names), never off the instance path, so a
// response key, an array index or a value cannot appear. Types are reported
// only for a `type` failure, as JSON type names.

export type MismatchCategory =
  | 'schema'
  | 'invalid_json'
  | 'invalid_utf8'
  | 'invalid_sequence'
  | 'unmatched_branch';

export type SchemaMismatch = {
  category: MismatchCategory;
  keyword?: string;
  // A pointer into the response data (`/owner/email`, `/items/*/id`), only
  // when the schema path proves it; absent through a `$ref`
  path?: string;
  expected?: string;
  observed?: string;
};

const KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'required',
  'additionalProperties',
  'unevaluatedProperties',
  'enum',
  'const',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'oneOf',
  'anyOf',
  'not',
]);
const JSON_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

// Ajv reads at most this many errors; a oneOf can collect one per branch
const MAX_ERRORS = 64;
const MAX_SEGMENT = 64;
const MAX_PATH = 256;

// A schema path segment as written (Ajv escapes it as a URI fragment of a
// JSON Pointer token); undefined when it does not decode
const decodeSegment = (raw: string): string | undefined => {
  try {
    return decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
  } catch {
    return undefined;
  }
};

// Redacted whole before anything is cut, so a cut can never leave part of a
// secret; once more after control characters are stripped, which could join
// one (review of #24)
const safeName = (name: string, redactor: Redactor): string => {
  const whole = redactor.redactString(name);
  const cleaned = redactor.redactString(sanitizeSpecText(whole, whole.length));
  return sanitizeSpecText(cleaned, MAX_SEGMENT);
};

const escapeToken = (name: string): string => name.replaceAll('~', '~0').replaceAll('/', '~1');

// Keywords whose operand is the next segment, which names no data
const SKIP_OPERAND: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf']);
const NO_STEP: ReadonlySet<string> = new Set(['not', 'if', 'then', 'else']);
const ANY_ELEMENT: ReadonlySet<string> = new Set([
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
]);

// The data pointer a schema path below `data` leads to, or undefined when
// the path passes anything that does not prove a data location (`$ref`,
// `$defs`, `dependentSchemas`, an unknown keyword). `tokens` ends just
// before the failing keyword.
const dataPointer = (tokens: readonly string[], redactor: Redactor): string | undefined => {
  const steps: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === 'properties') {
      const name = decodeSegment(tokens[index + 1] ?? '');
      if (name === undefined || index + 1 >= tokens.length) {
        return undefined;
      }
      steps.push(escapeToken(safeName(name, redactor)));
      index += 1;
    } else if (token === 'prefixItems' || token === 'patternProperties') {
      // The operand is an index or a pattern, never shown
      steps.push('*');
      index += 1;
    } else if (ANY_ELEMENT.has(token)) {
      steps.push('*');
    } else if (SKIP_OPERAND.has(token)) {
      index += 1;
    } else if (!NO_STEP.has(token)) {
      return undefined;
    }
  }
  const pointer = steps.map((step) => `/${step}`).join('');
  return pointer.length > MAX_PATH ? undefined : pointer;
};

const jsonTypeOf = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
};

// The value at a JSON Pointer in the envelope, for its type only
const valueAt = (envelope: unknown, pointer: string): { found: boolean; value?: unknown } => {
  let current: unknown = envelope;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
};

const typesOf = (error: ErrorObject, envelope: unknown): Partial<SchemaMismatch> => {
  const declared = error.params['type'];
  const expected = (Array.isArray(declared) ? declared : [declared]).filter(
    (name): name is string => typeof name === 'string' && JSON_TYPES.has(name),
  );
  const at = valueAt(envelope, error.instancePath);
  return {
    ...(expected.length === 0 ? {} : { expected: expected.join('|') }),
    ...(at.found ? { observed: jsonTypeOf(at.value) } : {}),
  };
};

// `branch` is the index of the envelope's oneOf branch the response's status
// and media type selected; only that branch's errors under `data` explain
// the refusal
export const describeMismatch = (
  errors: readonly ErrorObject[],
  branch: number,
  envelope: unknown,
  redactor: Redactor,
): SchemaMismatch => {
  const prefix = `#/oneOf/${String(branch)}/properties/data`;
  const bounded = errors.slice(0, MAX_ERRORS);
  const direct = bounded.find(
    (candidate) => candidate.schemaPath === prefix || candidate.schemaPath.startsWith(`${prefix}/`),
  );
  // Through a `$ref`, Ajv reports the schema path inside `$defs`: the keyword
  // and the types still hold, the location does not. Other branches fail on
  // their `status` const before they reach a reference.
  const error =
    direct ??
    bounded.find(
      (candidate) =>
        candidate.instancePath.startsWith('/data') && !candidate.schemaPath.startsWith('#/oneOf/'),
    );
  if (error === undefined) {
    return { category: 'schema' };
  }
  const keyword = KEYWORDS.has(error.keyword) ? error.keyword : 'other';
  const tokens = error.schemaPath.slice(prefix.length).split('/').slice(1, -1);
  let path = direct === undefined ? undefined : dataPointer(tokens, redactor);
  const missing = error.params['missingProperty'];
  if (path !== undefined && keyword === 'required') {
    // The required list is the schema's own, so the name is spec text
    path =
      typeof missing === 'string'
        ? `${path}/${escapeToken(safeName(missing, redactor))}`
        : undefined;
  }
  return {
    category: 'schema',
    keyword,
    ...(path === undefined || path.length > MAX_PATH ? {} : { path }),
    ...(keyword === 'type' ? typesOf(error, envelope) : {}),
  };
};

// Carried beside the outcome, like the call-log tags: nothing a client sees
const mismatches = new WeakMap<ToolCallOutcome, SchemaMismatch>();

export const withMismatch = (
  outcome: ToolCallOutcome,
  mismatch: SchemaMismatch | undefined,
): ToolCallOutcome => {
  if (mismatch !== undefined) {
    mismatches.set(outcome, mismatch);
  }
  return outcome;
};

export const mismatchOf = (outcome: ToolCallOutcome): SchemaMismatch | undefined =>
  mismatches.get(outcome);
