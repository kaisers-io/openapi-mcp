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
  | 'empty_body'
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

// The steps a schema path below `data` takes into the data: a property name,
// or undefined for any element. Undefined as a whole when the path passes
// anything that does not lead into the data (`$defs`, `dependentSchemas`, an
// unknown keyword). `tokens` ends just before the failing keyword.
const schemaSteps = (tokens: readonly string[]): (string | undefined)[] | undefined => {
  const steps: (string | undefined)[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === 'properties') {
      const name = decodeSegment(tokens[index + 1] ?? '');
      if (name === undefined || index + 1 >= tokens.length) {
        return undefined;
      }
      steps.push(name);
      index += 1;
    } else if (token === 'prefixItems' || token === 'patternProperties') {
      // The operand is an index or a pattern, never shown
      steps.push(undefined);
      index += 1;
    } else if (ANY_ELEMENT.has(token)) {
      steps.push(undefined);
    } else if (SKIP_OPERAND.has(token)) {
      index += 1;
    } else if (!NO_STEP.has(token)) {
      return undefined;
    }
  }
  return steps;
};

// The steps are kept only when they lead exactly where the failure is: a
// `$ref` to another schema in the same branch would otherwise name the
// referenced location instead (review of #24). The instance path is
// compared, never shown.
const verifiedSteps = (
  tokens: readonly string[],
  instancePath: string,
): (string | undefined)[] | undefined => {
  const steps = schemaSteps(tokens);
  const instance = instancePath
    .split('/')
    .slice(2)
    .map((raw) => raw.replaceAll('~1', '/').replaceAll('~0', '~'));
  return steps === undefined ||
    (instancePath !== '/data' && !instancePath.startsWith('/data/')) ||
    steps.length !== instance.length ||
    steps.some((step, index) => step !== undefined && step !== instance[index])
    ? undefined
    : steps;
};

// The pointer as shown, or undefined. Never cut: a cut could leave part of a
// secret the redactor no longer recognizes, also one spanning two names
// (review of #24). The whole pointer is redacted; a configured secret across
// names, a name sanitizing would change, or a pointer too long drops it.
const shownPointer = (
  steps: readonly (string | undefined)[],
  redactor: Redactor,
): string | undefined => {
  const joined = steps.map((step) => `/${step ?? '*'}`).join('');
  if (redactor.redactString(joined) !== joined) {
    return undefined;
  }
  const escaped = redactor.redactString(
    steps.map((step) => `/${step === undefined ? '*' : escapeToken(step)}`).join(''),
  );
  // A name with control characters or edge whitespace would come out as
  // another property's name, so it drops the path instead (review of #24)
  return sanitizeSpecText(escaped, escaped.length) !== escaped || escaped.length > MAX_PATH
    ? undefined
    : escaped;
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
  // A oneOf collects one error per branch it tried, so the list is as long as
  // the envelope has branches; the selected branch is searched for, never cut
  // off (review of #24)
  const direct = errors.find(
    (candidate) => candidate.schemaPath === prefix || candidate.schemaPath.startsWith(`${prefix}/`),
  );
  // Through a `$ref`, Ajv reports the schema path inside `$defs`: the keyword
  // and the types still hold, the location does not. Other branches fail on
  // their `status` const before they reach a reference.
  const error =
    direct ??
    errors.find(
      (candidate) =>
        candidate.instancePath.startsWith('/data') && !candidate.schemaPath.startsWith('#/oneOf/'),
    );
  if (error === undefined) {
    return { category: 'schema' };
  }
  const keyword = KEYWORDS.has(error.keyword) ? error.keyword : 'other';
  const tokens = error.schemaPath.slice(prefix.length).split('/').slice(1, -1);
  let steps = direct === undefined ? undefined : verifiedSteps(tokens, error.instancePath);
  const missing = error.params['missingProperty'];
  if (steps !== undefined && keyword === 'required') {
    // The required list is the schema's own, so the name is spec text
    steps = typeof missing === 'string' ? [...steps, missing] : undefined;
  }
  const path = steps === undefined ? undefined : shownPointer(steps, redactor);
  return {
    category: 'schema',
    keyword,
    ...(path === undefined ? {} : { path }),
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
