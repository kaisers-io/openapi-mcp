import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { GeneratedTool } from '../toolgen/build.ts';
import type { SnapshotTool } from './types.ts';

// Display helpers for the listed tools: the human-readable title and the
// stable list order.

// Clients show `title` in tool pickers and approval prompts, so it is kept
// short. `summary` already went through normalizeSpec's sanitizeSpecText;
// it is re-capped here for display.
const TITLE_MAX = 80;
export const titleOf = (generated: GeneratedTool): string | undefined => {
  const { summary } = generated.operation;
  const title = summary === undefined ? '' : sanitizeSpecText(summary, TITLE_MAX);
  return title === '' ? undefined : title;
};

// Code-point order (never locale-dependent): `<` on strings compares UTF-16
// code units, identical everywhere.
export const byToolName = (first: SnapshotTool, second: SnapshotTool): number => {
  if (first.name === second.name) {
    return 0;
  }
  return first.name < second.name ? -1 : 1;
};
