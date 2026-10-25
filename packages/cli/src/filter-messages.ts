import { sanitizeSpecText } from '@kaisers-io/openapi-mcp-core';
import type { CaseCollision, DeadPattern } from '@kaisers-io/openapi-mcp-core';

// As in spec-options, which re-exports this module
const PATH_DISPLAY_MAX = 512;
const PATTERN_DISPLAY_MAX = 256;

// Example wording: --allow "readPets" matches no operation; closest: readPetById
// The flag comes from the engine, which knows which list the pattern came from.
// Shared by `tools` and `serve` so a dead-pattern warning is sanitized and
// worded identically regardless of which command produced it.
export const deadPatternMessage = (dead: DeadPattern): string => {
  const raw = sanitizeSpecText(dead.raw, PATTERN_DISPLAY_MAX);
  // --omit-output-schema acts on the exposed tools only (issue #13)
  const scope = dead.flag === 'omit-output-schema' ? 'exposed operation' : 'operation';
  const base = `--${dead.flag} "${raw}" matches no ${scope}`;
  if (dead.notExposed === true) {
    // --allow and --deny see every operation the filters decide on, so for
    // them only one omitted as not supported is not exposed (issue #41)
    return dead.flag === 'omit-output-schema'
      ? `${base}; it names only operations that are filtered out or omitted`
      : `${base}; it names only operations that are omitted as not supported`;
  }
  return dead.suggestion === undefined
    ? base
    : `${base}; closest: ${sanitizeSpecText(dead.suggestion, PATTERN_DISPLAY_MAX)}`;
};

// Selectors match regardless of case (issue #42): a pattern that takes
// values differing only by case may take more than the operator meant
const COLLISION_DISPLAY_MAX = 5;
const bounded = (items: readonly string[], quote: boolean): string => {
  const shown = items
    .slice(0, COLLISION_DISPLAY_MAX)
    .map((item) => sanitizeSpecText(item, PATH_DISPLAY_MAX))
    .map((item) => (quote ? `"${item}"` : item));
  const more = items.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`;
};
export const caseCollisionMessage = (collision: CaseCollision): string =>
  `--${collision.flag} "${sanitizeSpecText(collision.raw, PATTERN_DISPLAY_MAX)}" matches values that differ only by case: ${bounded(collision.values, true)} (${bounded(collision.operations, false)})`;

// The filter diagnostics of a pipeline run: dead patterns and case
// collisions. A warning each, or under --strict-filters an error (exit 3).
export const filterMessages = (result: {
  deadPatterns: readonly DeadPattern[];
  caseCollisions: readonly CaseCollision[];
}): string[] => [
  ...result.deadPatterns.map((dead) => deadPatternMessage(dead)),
  ...result.caseCollisions.map((collision) => caseCollisionMessage(collision)),
];
