import { describe, expect, it } from 'vitest';
import { createMatcher, replaceSpans } from '../src/redact-match.ts';

// Enough distinct 8+ char needles to switch createMatcher to the hashed path.
const filler = Array.from({ length: 70 }, (_value, index) => `filler-needle-${String(index)}`);
const longestFirst = (needles: readonly string[]): string[] =>
  needles.toSorted((first, second) => second.length - first.length);
const paths = [
  ['per-needle (indexOf) path', longestFirst(['abababab'])],
  ['hashed path', longestFirst(['abababab', ...filler])],
] as const;

describe('createMatcher — self-overlapping needles', () => {
  // A needle that overlaps itself ("abababab" occurs at every even offset of
  // "abab…") used to yield one span per occurrence, i.e. O(body) tuples for a
  // body that repeats it. Overlapping hits now extend one run instead.
  const body = 'ab'.repeat(50_000);

  it.each(paths)('reports one span per overlapping run on the %s', (_path, needles) => {
    const spans = createMatcher(needles)(body, false);
    expect(spans).toStrictEqual([[0, body.length]]);
    expect(replaceSpans(body, spans, '[redacted]')).toBe('[redacted]');
  });

  it.each(paths)('keeps adjacent and separate runs apart on the %s', (_path, needles) => {
    const value = 'ababababababab-abababab abababab';
    const spans = createMatcher(needles)(value, false);
    expect(spans).toHaveLength(3);
    expect(replaceSpans(value, spans, '[redacted]')).toBe('[redacted]-[redacted] [redacted]');
  });

  it.each(paths)('still stops at the first hit when asked to on the %s', (_path, needles) => {
    expect(createMatcher(needles)(body, true)).toStrictEqual([[0, 8]]);
  });
});
