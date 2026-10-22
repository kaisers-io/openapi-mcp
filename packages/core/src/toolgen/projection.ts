import { z } from 'zod';

// Per-call response projection: an optional reserved `_fields` argument,
// a list of RFC 6901 JSON Pointers, selects the parts of a JSON response the
// model actually needs, so a wide list response does not have to enter its
// context in full. One extension: a `*` segment maps over every element of
// an array (`/items/*/id`); on an object, `*` is an ordinary key, as in
// RFC 6901. Deliberately tiny and bounded — no predicates, no expressions.

export const PROJECTION_FIELD = '_fields';

const MAX_POINTERS = 32;
const MAX_POINTER_LENGTH = 256;
const MAX_SEGMENTS = 32;
// RFC 6901: "" or a sequence of "/" + reference-token, where `~` only ever
// appears as the escapes `~0` and `~1`. The empty (whole-document) pointer
// is not accepted: "everything" is what omitting `_fields` means.
const POINTER_RE = /^(?:\/(?:[^~/]|~[01])*)+$/u;

const segmentsOf = (pointer: string): string[] =>
  pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));

export const PROJECTION_FIELDS_SCHEMA = z
  .array(
    z
      .string()
      .max(MAX_POINTER_LENGTH)
      .regex(POINTER_RE)
      .refine((pointer) => segmentsOf(pointer).length <= MAX_SEGMENTS),
  )
  .min(1)
  .max(MAX_POINTERS)
  .describe(
    'Optional. JSON Pointers (RFC 6901) selecting only these parts of the JSON response, e.g. ["/items/*/id", "/next_cursor"]; "*" maps over an array. Missing paths yield null.',
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/u;

// The projection's JSON contract: a path that does not exist is null.
// oxlint-disable-next-line unicorn/no-null -- JSON null is the documented value for a missing path
const MISSING = null;

// Only OWN properties are ever read (never the prototype chain, so a
// `__proto__` or `constructor` segment simply finds nothing), and a path
// that does not exist yields null, deterministically.
const evaluate = (value: unknown, segments: readonly string[]): unknown => {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    if (head === '*') {
      return value.map((item: unknown) => evaluate(item, rest));
    }
    const element: unknown = ARRAY_INDEX_RE.test(head) ? value[Number(head)] : undefined;
    return element === undefined ? MISSING : evaluate(element, rest);
  }
  if (isRecord(value) && Object.hasOwn(value, head)) {
    return evaluate(value[head], rest);
  }
  return MISSING;
};

// `{ "<pointer>": <selected value>, ... }` in the order requested.
export const project = (data: unknown, pointers: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(pointers.map((pointer) => [pointer, evaluate(data, segmentsOf(pointer))]));

export const PROJECTION_HINT =
  '(truncated; pass _fields with JSON Pointers to select specific fields)';
