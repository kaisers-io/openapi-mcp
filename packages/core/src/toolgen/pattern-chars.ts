import { skipEscape, UNICODE_ESCAPE_RE, unicodeEscape } from './pattern-syntax.ts';

// Character sets for the response pattern checks (pattern-ambiguity.ts), as
// sorted code point ranges.
//
// The sets are a superset of what JavaScript matches: `.`, `\p{...}`,
// backreferences and anything unknown match every character, and a class with
// many ranges is widened to one range. Wider sets only refuse more patterns.

export type CharSet = readonly (readonly [number, number])[];

const MAX_CODE_POINT = 0x10_ff_ff;
export const ANY: CharSet = [[0, MAX_CODE_POINT]];
export const NONE: CharSet = [];
const MAX_RANGES = 16;

const DIGIT: CharSet = [[0x30, 0x39]];
const WORD: CharSet = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
// JavaScript's `\s`: WhiteSpace and LineTerminator
const SPACE: CharSet = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x16_80, 0x16_80],
  [0x20_00, 0x20_0a],
  [0x20_28, 0x20_29],
  [0x20_2f, 0x20_2f],
  [0x20_5f, 0x20_5f],
  [0x30_00, 0x30_00],
  [0xfe_ff, 0xfe_ff],
];

// Sorted, merged, and widened to one range past MAX_RANGES, so every set
// operation stays cheap however long the pattern is.
const normalize = (set: CharSet): CharSet => {
  const merged: [number, number][] = [];
  for (const [low, high] of [...set].toSorted((left, right) => left[0] - right[0])) {
    const previous = merged.at(-1);
    if (previous !== undefined && low <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], high);
    } else {
      merged.push([low, high]);
    }
  }
  const [first] = merged;
  const last = merged.at(-1);
  return merged.length > MAX_RANGES && first !== undefined && last !== undefined
    ? [[first[0], last[1]]]
    : merged;
};

export const union = (left: CharSet, right: CharSet): CharSet => normalize([...left, ...right]);

const complement = (set: CharSet): CharSet => {
  const result: [number, number][] = [];
  let next = 0;
  for (const [low, high] of normalize(set)) {
    if (low > next) {
      result.push([next, low - 1]);
    }
    next = high + 1;
  }
  if (next <= MAX_CODE_POINT) {
    result.push([next, MAX_CODE_POINT]);
  }
  return normalize(result);
};

export const overlaps = (left: CharSet, right: CharSet): boolean =>
  left.some(([low, high]) => right.some(([from, to]) => low <= to && from <= high));

export const single = (code: number): CharSet => [[code, code]];

const ESCAPES: ReadonlyMap<string, CharSet> = new Map([
  ['n', single(0x0a)],
  ['r', single(0x0d)],
  ['t', single(0x09)],
  ['v', single(0x0b)],
  ['f', single(0x0c)],
  ['0', single(0x00)],
  ['d', DIGIT],
  ['D', complement(DIGIT)],
  ['w', WORD],
  ['W', complement(WORD)],
  ['s', SPACE],
  ['S', complement(SPACE)],
]);

// One escape: its characters (`undefined` for a zero-width `\b` or `\B`
// outside a class) and the index just past it.
export const readEscape = (
  pattern: string,
  index: number,
  inClass: boolean,
): { chars: CharSet | undefined; end: number } => {
  const name = pattern[index + 1] ?? '';
  UNICODE_ESCAPE_RE.lastIndex = index;
  const unicode = UNICODE_ESCAPE_RE.exec(pattern);
  if (unicode !== null) {
    return { chars: single(unicodeEscape(unicode)), end: index + unicode[0].length };
  }
  const hex = /^x[\da-fA-F]{2}/u.exec(pattern.slice(index + 1, index + 4));
  if (hex !== null) {
    return { chars: single(Number.parseInt(hex[0].slice(1), 16)), end: index + 4 };
  }
  const end = skipEscape(pattern, index);
  if ((name === 'b' || name === 'B') && !inClass) {
    return { chars: undefined, end };
  }
  const known = ESCAPES.get(name);
  if (known !== undefined) {
    return { chars: known, end };
  }
  // `\p{...}`, `\cX`, `\k<name>`, a backreference: assume any character
  if (/[pPck1-9b]/u.test(name)) {
    return { chars: ANY, end };
  }
  const code = pattern.codePointAt(index + 1);
  return { chars: code === undefined ? ANY : single(code), end };
};

// A class's characters and the index just past it. A range bound that is not
// one character (`[\d-z]`) leaves `-` and the bound as members.
export const readClass = (pattern: string, index: number): { chars: CharSet; end: number } => {
  const negated = pattern[index + 1] === '^';
  let cursor = negated ? index + 2 : index + 1;
  let chars: CharSet = NONE;
  let previous: number | undefined;
  while (cursor < pattern.length && pattern[cursor] !== ']') {
    let member: CharSet;
    if (pattern[cursor] === '\\') {
      const escape = readEscape(pattern, cursor, true);
      member = escape.chars ?? ANY;
      cursor = escape.end;
    } else {
      const code = pattern.codePointAt(cursor) ?? 0;
      member = single(code);
      cursor += String.fromCodePoint(code).length;
    }
    const [only] = member;
    const bound = member.length === 1 && only !== undefined && only[0] === only[1];
    if (previous !== undefined) {
      member =
        bound && only !== undefined
          ? [[Math.min(previous, only[0]), Math.max(previous, only[0])]]
          : [...member, [previous, previous], [0x2d, 0x2d]];
      previous = undefined;
    } else if (bound && pattern[cursor] === '-' && pattern[cursor + 1] !== ']') {
      previous = only?.[0];
      cursor += 1;
      continue;
    }
    chars = union(chars, member);
  }
  return { chars: negated ? complement(chars) : chars, end: Math.min(cursor + 1, pattern.length) };
};
