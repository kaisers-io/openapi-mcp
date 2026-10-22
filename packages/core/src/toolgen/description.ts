import { SPEC_BUDGETS } from '../spec/budgets.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';

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
    .map(([status, response]) => {
      const description =
        isRecord(response) && typeof response['description'] === 'string'
          ? response['description']
          : undefined;
      return description === undefined ? status : `${status}: ${description}`;
    });

// `note` is fixed server text (never spec text) about the tool itself, e.g.
// why it has no output schema (#39). It is listed right after `[DEPRECATED]`,
// before the cap, so a long spec description cannot truncate it away.
export const composeDescription = (operation: OperationRecord, note?: string): string => {
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
    operation.summary,
    operation.description === operation.summary ? undefined : operation.description,
    errors.length > 0 ? `Errors: ${errors.join('; ')}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return sanitizeSpecText(parts.join(' '), SPEC_BUDGETS.maxTextLength);
};
