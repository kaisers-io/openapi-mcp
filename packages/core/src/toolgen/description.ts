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
const documentedErrors = (responses: Record<string, unknown>): string[] => {
  const entries: string[] = [];
  for (const [status, response] of Object.entries(responses)) {
    if (!isErrorStatus(status) || entries.length >= MAX_ERROR_ENTRIES) {
      continue;
    }
    const description =
      isRecord(response) && typeof response['description'] === 'string'
        ? response['description']
        : undefined;
    entries.push(description === undefined ? status : `${status}: ${description}`);
  }
  return entries;
};

export const composeDescription = (operation: OperationRecord): string => {
  const parts: string[] = [];
  // `[DEPRECATED]` is pushed FIRST, before sanitizeSpecText's cap runs below —
  // prefixing after the cap (the original bug) could push the composed
  // description past SPEC_BUDGETS.maxTextLength. Pushing it as its own part
  // (rather than string-concatenating it onto the eventual result) also means
  // an operation with no summary/description/errors yields a clean
  // "[DEPRECATED]" with no trailing space, since parts.join(' ') never
  // inserts a separator after the last element.
  if (operation.deprecated) {
    parts.push('[DEPRECATED]');
  }
  if (operation.summary !== undefined) {
    parts.push(operation.summary);
  }
  if (operation.description !== undefined && operation.description !== operation.summary) {
    parts.push(operation.description);
  }
  const errors = documentedErrors(operation.responses);
  if (errors.length > 0) {
    parts.push(`Errors: ${errors.join('; ')}`);
  }
  return sanitizeSpecText(parts.join(' '), SPEC_BUDGETS.maxTextLength);
};
