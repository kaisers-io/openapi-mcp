import { TRUNCATION_MARKER } from './sanitize.ts';

// Bounds for the framed error body. Deterministic aggregate cap: at most
// FRAME_MAX_LINES logical lines, each capped to FRAME_PER_LINE_MAX display CELLS
// before wrapping, so total output cannot be inflated by a hostile spec.
export const FRAME_PER_LINE_MAX = 256;
export const FRAME_MAX_LINES = 40;
// Content-width floor used ONLY when the raw budget (terminal width minus
// gutter length) is non-positive, i.e. the gutter is as wide as or wider than
// the terminal; a small-but-positive budget is honoured as-is. The
// `current !== ''` guard in chunkByCells is what actually prevents a
// zero-width chunk. On a terminal narrower than the gutter plus one atom, a
// guttered physical line can still exceed the viewport — a pathologically-narrow
// residual, accepted.
export const FRAME_MIN_CONTENT_WIDTH = 8;

export interface GutterFrameOptions {
  gutter: string;
  terminalWidth: number | undefined;
  perLineMax: number;
  maxLines: number;
}

export interface GutteredBody {
  lines: readonly string[];
  logicalShown: number;
  truncated: boolean;
}

// Conservative terminal cell width. A dumb terminal renders a wide (CJK,
// fullwidth, most astral) code point in TWO cells; anything non-ASCII is
// treated as two so we NEVER under-count and let hostile text soft-wrap past
// the gutter (an over-count only wraps a hair early — safe and cosmetic). C0/C1
// and bidi are already stripped upstream, so they never reach here.
const cellWidth = (codePoint: number): number => (codePoint < 0x7f ? 1 : 2);

// Chunk by DISPLAY CELLS, iterating code POINTS (for..of), so a surrogate pair
// is never split and no physical line exceeds the cell budget.
const chunkByCells = (text: string, cellBudget: number): string[] => {
  const out: string[] = [];
  let current = '';
  let cells = 0;
  for (const ch of text) {
    const width = cellWidth(ch.codePointAt(0) ?? 0);
    if (cells + width > cellBudget && current !== '') {
      out.push(current);
      current = '';
      cells = 0;
    }
    current += ch;
    cells += width;
  }
  if (current !== '' || out.length === 0) {
    out.push(current);
  }
  return out;
};

// Truncate to at most maxCells display cells, iterating code POINTS so an astral
// pair is never split. Returns [text, capped]; the marker is appended when
// anything was dropped (a small marker overrun is harmless — chunkByCells wraps
// the result afterward). This is cell-aware, unlike sanitize's length-based cap.
const truncateCells = (text: string, maxCells: number): [string, boolean] => {
  let cells = 0;
  let out = '';
  for (const ch of text) {
    const width = cellWidth(ch.codePointAt(0) ?? 0);
    if (cells + width > maxCells) {
      return [`${out}${TRUNCATION_MARKER}`, true];
    }
    out += ch;
    cells += width;
  }
  return [out, false];
};

export const gutterFrame = (
  logicalLines: readonly string[],
  opts: GutterFrameOptions,
): GutteredBody => {
  const shown = logicalLines.slice(0, opts.maxLines);
  // Truncated flags BOTH dropped logical lines AND any per-line cell cut, so the
  // footer's "DETAILS TRUNCATED" is honest for either.
  let truncated = logicalLines.length > shown.length;
  // The gutter is ASCII, so its cell width equals its code-unit length. Only a
  // non-positive raw budget (gutter as wide as or wider than the terminal) is
  // floored to FRAME_MIN_CONTENT_WIDTH; a small-but-positive budget (e.g. a
  // narrow-but-usable terminal) is honoured as-is.
  let cellBudget: number | undefined;
  if (opts.terminalWidth === undefined) {
    cellBudget = undefined;
  } else {
    const rawBudget = opts.terminalWidth - opts.gutter.length;
    cellBudget = rawBudget > 0 ? rawBudget : FRAME_MIN_CONTENT_WIDTH;
  }
  const lines: string[] = [];
  for (const logical of shown) {
    const [capped, wasCut] = truncateCells(logical, opts.perLineMax);
    if (wasCut) {
      truncated = true;
    }
    const pieces = cellBudget === undefined ? [capped] : chunkByCells(capped, cellBudget);
    for (const piece of pieces) {
      lines.push(`${opts.gutter}${piece}`);
    }
  }
  return { lines, logicalShown: shown.length, truncated };
};

// Total display cells a string occupies (code-point aware). Used by emitError to
// decide compact vs framed: a single line that fits the width in CELLS is safe.
export const displayCells = (text: string): number => {
  let cells = 0;
  for (const ch of text) {
    cells += cellWidth(ch.codePointAt(0) ?? 0);
  }
  return cells;
};
