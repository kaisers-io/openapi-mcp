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

// A selection can repeat or overlap parts of the response, and `*` over a
// missing key yields one null per element, so 32 pointers could otherwise
// turn a capped body into about 80 times as much output. The result may be at
// most twice the body plus this allowance (room for pointer keys and nulls on
// a small body), counted while it is built: before an array is mapped and
// over each selected value, in the UTF-8 bytes JSON.stringify writes for it.
const BUDGET_ALLOWANCE = 64 * 1024;

export const PROJECTION_TOO_LARGE =
  'tool execution failed: _fields would return more than twice the size of the response; ' +
  'select fewer or narrower fields';

// Thrown to unwind the evaluation, and caught in project()
const OVER_BUDGET = new Error('projection over budget');

const spend = (budget: { left: number }, bytes: number): void => {
  budget.left -= bytes;
  if (budget.left < 0) {
    throw OVER_BUDGET;
  }
};

// \b \t \n \f \r: the control characters JSON writes as a two-byte escape
const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

// UTF-8 bytes of a string as JSON.stringify writes it, quotes included: every
// other control character and every lone surrogate becomes a six-byte \uXXXX,
// so its length alone would undercount the output up to sixfold. One pass,
// no copy.
const jsonStringBytes = (text: string): number => {
  let bytes = 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    if (code > 0xff_ff) {
      bytes += 4;
      index += 1;
    } else if (code < 0x20) {
      bytes += SHORT_ESCAPES.has(code) ? 2 : 6;
    } else if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x8_00) {
      bytes += 2;
    } else {
      bytes += code >= 0xd8_00 && code <= 0xdf_ff ? 6 : 3;
    }
  }
  return bytes;
};

// Iterative, and stops as soon as the budget runs out
const spendOn = (budget: { left: number }, value: unknown): void => {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      spend(budget, 2 + node.length);
      for (const child of node) {
        pending.push(child);
      }
    } else if (isRecord(node)) {
      spend(budget, 2);
      for (const [key, child] of Object.entries(node)) {
        spend(budget, jsonStringBytes(key) + 2);
        pending.push(child);
      }
    } else {
      spend(budget, typeof node === 'string' ? jsonStringBytes(node) : String(node).length);
    }
  }
};

// Only OWN properties are ever read (never the prototype chain, so a
// `__proto__` or `constructor` segment simply finds nothing), and a path
// that does not exist yields null, deterministically.
const evaluate = (
  value: unknown,
  segments: readonly string[],
  budget: { left: number },
): unknown => {
  const [head, ...rest] = segments;
  if (head === undefined) {
    spendOn(budget, value);
    return value;
  }
  if (Array.isArray(value)) {
    if (head === '*') {
      spend(budget, 2 + value.length);
      return value.map((item: unknown) => evaluate(item, rest, budget));
    }
    const element: unknown = ARRAY_INDEX_RE.test(head) ? value[Number(head)] : undefined;
    return element === undefined ? evaluate(MISSING, [], budget) : evaluate(element, rest, budget);
  }
  if (isRecord(value) && Object.hasOwn(value, head)) {
    return evaluate(value[head], rest, budget);
  }
  return evaluate(MISSING, [], budget);
};

// `{ "<pointer>": <selected value>, ... }` in the order requested, or
// undefined when it would exceed the budget for a body of `bodyBytes`.
// A repeated pointer is one key, so it is evaluated once.
export const project = (
  data: unknown,
  pointers: readonly string[],
  bodyBytes: number,
): Record<string, unknown> | undefined => {
  const budget = { left: 2 * bodyBytes + BUDGET_ALLOWANCE };
  try {
    return Object.fromEntries(
      [...new Set(pointers)].map((pointer) => [
        pointer,
        evaluate(data, segmentsOf(pointer), budget),
      ]),
    );
  } catch (error) {
    if (error === OVER_BUDGET) {
      return undefined;
    }
    throw error;
  }
};

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
