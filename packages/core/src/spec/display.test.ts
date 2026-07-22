import { describe, expect, it } from 'vitest';
import { FRAME_MAX_LINES, FRAME_PER_LINE_MAX, gutterFrame, TRUNCATION_MARKER } from '../index.ts';

const G = 'openapi-mcp: | ';

describe('gutterFrame', () => {
  it('prefixes every logical line with the gutter and reports the count', () => {
    const out = gutterFrame(['a', 'b'], {
      gutter: G,
      terminalWidth: undefined,
      perLineMax: FRAME_PER_LINE_MAX,
      maxLines: FRAME_MAX_LINES,
    });
    expect(out.lines).toEqual([`${G}a`, `${G}b`]);
    expect(out.logicalShown).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('hard-wraps by DISPLAY CELLS, not code units, repeating the gutter', () => {
    // Content cell budget = terminalWidth - gutter length = 20 - 15 = 5
    const out = gutterFrame(['abcdefghij'], {
      gutter: G,
      terminalWidth: G.length + 5,
      perLineMax: FRAME_PER_LINE_MAX,
      maxLines: FRAME_MAX_LINES,
    });
    expect(out.lines).toEqual([`${G}abcde`, `${G}fghij`]);
  });

  it('counts a wide (CJK) code point as two cells and never splits it', () => {
    // '界' is one code unit but two terminal cells; content budget 5 cells
    // fits two of them (4 cells), the third wraps.
    const wide = '界界界';
    const out = gutterFrame([wide], {
      gutter: G,
      terminalWidth: G.length + 5,
      perLineMax: FRAME_PER_LINE_MAX,
      maxLines: FRAME_MAX_LINES,
    });
    expect(out.lines).toEqual([`${G}界界`, `${G}界`]);
  });

  it('never splits an astral (surrogate-pair) code point across a wrap', () => {
    // '\u{1F600}' is a surrogate PAIR (length 2) counted as two cells; at a
    // 2-cell budget it must move whole to the next line, never half.
    const out = gutterFrame([`a\u{1F600}`], {
      gutter: G,
      terminalWidth: G.length + 2,
      perLineMax: FRAME_PER_LINE_MAX,
      maxLines: FRAME_MAX_LINES,
    });
    expect(out.lines).toEqual([`${G}a`, `${G}\u{1F600}`]);
    // The emoji code point survived intact on its own line. slice() here
    // returns a string, not an array; the spread splits it by code point on
    // purpose, but oxlint's static check flags it as a redundant array spread.
    // oxlint-disable-next-line unicorn/no-useless-spread
    expect([...out.lines[1]!.slice(G.length)]).toEqual(['\u{1F600}']);
  });

  it('does not hard-wrap when terminalWidth is undefined (non-TTY)', () => {
    const long = 'x'.repeat(50);
    const out = gutterFrame([long], {
      gutter: G,
      terminalWidth: undefined,
      perLineMax: FRAME_PER_LINE_MAX,
      maxLines: FRAME_MAX_LINES,
    });
    expect(out.lines).toEqual([`${G}${long}`]);
  });

  it('caps a single logical line to perLineMax CELLS and flags truncation', () => {
    // No wrap (terminalWidth undefined): 20 ASCII cells kept, then the marker.
    const out = gutterFrame(['y'.repeat(1000)], {
      gutter: G,
      terminalWidth: undefined,
      perLineMax: 20,
      maxLines: FRAME_MAX_LINES,
    });
    expect(out.lines).toEqual([`${G}${'y'.repeat(20)}${TRUNCATION_MARKER}`]);
    // A per-line cut sets truncated too, so the footer can say DETAILS TRUNCATED
    expect(out.truncated).toBe(true);
  });

  it('caps by CELLS for wide characters and never splits an astral pair at the cap', () => {
    // A perLineMax of 6 cells: three CJK (2 cells each) fit, the rest is dropped.
    const out = gutterFrame(['界'.repeat(50)], {
      gutter: G,
      terminalWidth: undefined,
      perLineMax: 6,
      maxLines: FRAME_MAX_LINES,
    });
    expect(out.lines).toEqual([`${G}界界界${TRUNCATION_MARKER}`]);
    // An astral cap boundary keeps the emoji whole (2 cells at a 3-cell budget:
    // one emoji fits, the second would exceed and is dropped).
    const astral = gutterFrame([`\u{1F600}\u{1F600}`], {
      gutter: G,
      terminalWidth: undefined,
      perLineMax: 3,
      maxLines: FRAME_MAX_LINES,
    });
    expect([...astral.lines[0]!.slice(G.length).replace(TRUNCATION_MARKER, '')]).toEqual([
      '\u{1F600}',
    ]);
  });

  it('caps the logical line count and flags truncation', () => {
    const many = Array.from({ length: 5 }, (_v, i) => `line${i}`);
    const out = gutterFrame(many, {
      gutter: G,
      terminalWidth: undefined,
      perLineMax: FRAME_PER_LINE_MAX,
      maxLines: 3,
    });
    expect(out.logicalShown).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.lines).toEqual([`${G}line0`, `${G}line1`, `${G}line2`]);
  });

  it('keeps a minimum content width on a pathologically narrow terminal', () => {
    // A terminalWidth below gutter length must not produce zero/negative chunks
    const out = gutterFrame(['abcdefghij'], {
      gutter: G,
      terminalWidth: 3,
      perLineMax: FRAME_PER_LINE_MAX,
      maxLines: FRAME_MAX_LINES,
    });
    // Chunked at FRAME_MIN_CONTENT_WIDTH (8): "abcdefgh" then "ij"
    expect(out.lines).toEqual([`${G}abcdefgh`, `${G}ij`]);
  });
});
