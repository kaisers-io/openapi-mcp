import { SPEC_BUDGETS } from '../spec/budgets.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import { sanitizeSpecText, stripMarkdownLinks } from '../spec/sanitize.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Bounds how many documented error responses are folded in before
// sanitizeSpecText's own length cap would have trimmed them anyway — defense
// in depth against a response map declaring thousands of status codes.
const MAX_ERROR_ENTRIES = 20;

const isErrorStatus = (key: string): boolean => {
  const code = Number(key);
  return Number.isInteger(code) && code >= 400 && code < 600;
};

// An error entry that only restates what its status means anyway ("401:
// Unauthorized", "404: The resource was not found.", "500: Server error.")
// tells the agent nothing it does not learn from the status at call time, and
// a spec repeats it on almost every operation: 8% of the visible tool list for
// DigitalOcean (issue #49). It is generic when every word is filler or a word
// of that status's own meaning. Any other word ("Validation failed", "409:
// authentication required"), any number ("Rate limit: 100 requests") or a
// status not listed here keeps it, in any script.
const FILLER_WORDS = 'a an the is was has been not no resource resources error errors request';
const STATUS_WORDS: Readonly<Record<string, string>> = {
  '400': 'bad invalid',
  '401': 'unauthorized unauthorised authentication authenticated required requires',
  '403': 'forbidden allowed permission denied access',
  '404': 'found',
  '405': 'method allowed',
  '409': 'conflict',
  '410': 'gone',
  '413': 'payload entity too large',
  '415': 'unsupported media type',
  '422': 'unprocessable entity',
  '429': 'too many requests rate limit exceeded api',
  '500': 'internal server',
  '502': 'bad gateway',
  '503': 'service unavailable',
  '504': 'gateway timeout',
};
const GENERIC_WORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(STATUS_WORDS).map(([status, words]) => [
    status,
    new Set(`${FILLER_WORDS} ${words}`.split(' ')),
  ]),
);

const isGenericError = (status: string, description: string): boolean => {
  const words = GENERIC_WORDS.get(status);
  return (
    words !== undefined &&
    (description.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every((word) => words.has(word))
  );
};

// Response descriptions are RAW dereferenced spec text: normalizeSpec only
// sanitizes operation.summary/description, never the responses map. Every
// piece folded in here is sanitized in the single final pass below before
// this function returns any of it — so a hostile response `description` can
// never reach a tool description unsanitized. Object.entries iterates numeric
// string keys ("400", "404", ...) in ascending numeric order per the
// ECMAScript own-property-key-order spec, so no explicit sort is needed for
// the common case; non-numeric keys ("default") sort after, which is fine
// since they are filtered out by isErrorStatus anyway.
// Filter-then-slice, in that order, preserves the original loop's semantics
// exactly: the cap counts qualifying (error-status) entries only, not raw
// entries, and Object.entries' ascending-numeric-then-insertion order is
// unaffected by either step.
const documentedErrors = (responses: Record<string, unknown>): string[] =>
  Object.entries(responses)
    .filter(([status]) => isErrorStatus(status))
    .slice(0, MAX_ERROR_ENTRIES)
    .flatMap(([status, response]) => {
      const description =
        isRecord(response) && typeof response['description'] === 'string'
          ? response['description']
          : undefined;
      return description === undefined || isGenericError(status, description)
        ? []
        : [`${status}: ${description}`];
    });

// The optional parameters left out (issue #67), named so the agent does not
// look for them: fixed text around spec names, which the final pass below
// sanitizes with the rest. A few names, each bounded, so a spec cannot
// crowd out the operation's own description with them.
const LEFT_OUT_NAMES_MAX = 8;
const LEFT_OUT_NAME_MAX = 64;
const leftOutNote = (leftOut: readonly { name: string }[]): string | undefined => {
  if (leftOut.length === 0) {
    return undefined;
  }
  const names = leftOut
    .slice(0, LEFT_OUT_NAMES_MAX)
    .map((parameter) => sanitizeSpecText(parameter.name, LEFT_OUT_NAME_MAX));
  const more = leftOut.length - names.length;
  return `[Parameters not available here: ${names.join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}.]`;
};

// `note` is fixed server text (never spec text) about the tool itself, e.g.
// why it has no output schema (kaisers-io/openapi-mcp-archive#39). It is listed
// right after `[DEPRECATED]`, before the cap, so a long spec description cannot
// truncate it away.
export const composeDescription = (
  operation: OperationRecord,
  note?: string,
  leftOut: readonly { name: string }[] = [],
): string => {
  const errors = documentedErrors(operation.responses);
  // `[DEPRECATED]` is listed FIRST, before sanitizeSpecText's cap runs below —
  // appending it after the cap (the original bug) could push the composed
  // description past SPEC_BUDGETS.maxTextLength. Listing it as its own
  // element (rather than string-concatenating it onto the eventual result)
  // also means an operation with no summary/description/errors yields a
  // clean "[DEPRECATED]" with no trailing space, since parts.join(' ') never
  // inserts a separator after the last element.
  const parts = [
    operation.deprecated ? '[DEPRECATED]' : undefined,
    note,
    leftOutNote(leftOut),
    operation.summary,
    operation.description === operation.summary ? undefined : operation.description,
    errors.length > 0 ? `Errors: ${errors.join('; ')}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return sanitizeSpecText(stripMarkdownLinks(parts.join(' ')), SPEC_BUDGETS.maxTextLength);
};
