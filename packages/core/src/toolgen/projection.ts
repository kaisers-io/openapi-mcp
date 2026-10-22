import { z } from 'zod';
import type { OperationRecord } from '../spec/normalize.ts';
import { isJsonEssence, parseMediaType } from './media-type.ts';

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

const isValidPointer = (pointer: string): boolean =>
  pointer.length <= MAX_POINTER_LENGTH &&
  POINTER_RE.test(pointer) &&
  segmentsOf(pointer).length <= MAX_SEGMENTS;

// Repeated on every projectable tool, and tools/list size is paid in every
// session: the wire schema is kept minimal (one-line description; the
// pointer grammar is checked by a refinement, which is not serialized) and
// the grammar is explained ONCE, in the server instructions (PROJECTION_GUIDE).
export const PROJECTION_FIELDS_SCHEMA = z
  .array(
    z
      .string()
      .refine(isValidPointer, { message: 'not a valid JSON Pointer (see server instructions)' }),
  )
  .min(1)
  .max(MAX_POINTERS)
  .describe('Return only these JSON Pointers (see server instructions).');

// Package-authored, static: added to the server instructions when any tool
// takes `_fields`.
export const PROJECTION_GUIDE =
  'Tools with a JSON response accept an optional `_fields` argument: up to 32 RFC 6901 JSON ' +
  'Pointers (e.g. ["/items/*/id", "/next_cursor"]; `*` maps over an array). The result then ' +
  'carries only `projection`, an object keyed by pointer; a missing path is null.';

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

// Appended to a truncated result of a projectable tool. A structured result
// is complete in structuredContent (only its text copy is cut), so the two
// cases are worded differently: never suggest data was lost when it was not.
export const PROJECTION_HINT_TEXT =
  '(the response text above was truncated; call again with _fields (JSON Pointers) to get only the fields you need)';
export const PROJECTION_HINT_STRUCTURED =
  '(only this text copy is truncated; structuredContent has the complete result. To receive less, call again with _fields)';

// Projection applies to JSON bodies only: a tool gets `_fields` when any of
// its success responses declares a JSON media type, by the shared media-type
// classifier (media-type.ts) — parameters allowed, malformed keys ignored.
export const declaresJsonSuccess = (operation: OperationRecord): boolean =>
  Object.entries(operation.responses).some(
    ([status, response]) =>
      /^2(?:\d\d|xx)$/iu.test(status) &&
      isRecord(response) &&
      isRecord(response['content']) &&
      Object.keys(response['content']).some((type) => {
        const parsed = parseMediaType(type);
        return parsed !== undefined && isJsonEssence(parsed.essence);
      }),
  );
