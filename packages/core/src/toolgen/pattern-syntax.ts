// Lexing helpers shared by the response pattern checks (pattern-safety.ts,
// pattern-ambiguity.ts). Patterns are JavaScript `u`-mode sources.

export type Quantifier = { min: number; max: number };

const BRACE_QUANTIFIER_RE = /^\{(?<min>\d+)(?<range>,(?<max>\d*))?\}/u;

// Reads the quantifier starting at `index`, if any, and its source length.
export const readQuantifier = (
  pattern: string,
  index: number,
): { quantifier: Quantifier; length: number } | undefined => {
  const char = pattern[index];
  if (char === '*') {
    return { quantifier: { min: 0, max: Infinity }, length: 1 };
  }
  if (char === '+') {
    return { quantifier: { min: 1, max: Infinity }, length: 1 };
  }
  if (char === '?') {
    return { quantifier: { min: 0, max: 1 }, length: 1 };
  }
  if (char === '{') {
    const match = BRACE_QUANTIFIER_RE.exec(pattern.slice(index));
    if (match === null) {
      return undefined;
    }
    const groups = match.groups ?? {};
    const min = Number(groups['min']);
    const upper = groups['max'];
    // `{n}` is exact, `{n,}` unbounded, `{n,m}` bounded.
    const bounded = upper === undefined || upper === '' ? Infinity : Number(upper);
    const max = groups['range'] === undefined ? min : bounded;
    return { quantifier: { min, max }, length: match[0].length };
  }
  return undefined;
};

// Index just past a `\` escape starting at `index` (`\p{L}`, `\u{1F600}`,
// `\k<name>` consume their braces/brackets so they are not read as quantifiers).
export const skipEscape = (pattern: string, index: number): number => {
  const next = pattern[index + 1];
  const open = pattern[index + 2];
  if ((next === 'p' || next === 'P' || next === 'u') && open === '{') {
    const close = pattern.indexOf('}', index + 3);
    return close === -1 ? pattern.length : close + 1;
  }
  if (next === 'k' && open === '<') {
    const close = pattern.indexOf('>', index + 3);
    return close === -1 ? pattern.length : close + 1;
  }
  return Math.min(index + 2, pattern.length);
};

// Index just past a character class `[...]` starting at `index`.
export const skipClass = (pattern: string, index: number): number => {
  let cursor = index + 1;
  while (cursor < pattern.length && pattern[cursor] !== ']') {
    cursor = pattern[cursor] === '\\' ? cursor + 2 : cursor + 1;
  }
  return Math.min(cursor + 1, pattern.length);
};

// Length of a group's opening syntax: `(`, `(?:`, `(?=`, `(?!`, `(?<=`,
// `(?<!`, `(?<name>`.
export const groupOpenLength = (pattern: string, index: number): number => {
  if (pattern[index + 1] !== '?') {
    return 1;
  }
  const kind = pattern[index + 2];
  if (kind === '<' && pattern[index + 3] !== '=' && pattern[index + 3] !== '!') {
    const close = pattern.indexOf('>', index + 3);
    return close === -1 ? pattern.length - index : close - index + 1;
  }
  return kind === '<' ? 4 : 3;
};

export const UNICODE_ESCAPE_RE =
  /\\u(?:(?<pair>[dD][89abAB][\da-fA-F]{2}\\u[dD][c-fC-F][\da-fA-F]{2})|\{(?<braced>[\da-fA-F]+)\}|(?<single>[\da-fA-F]{4}))/uy;

export const unicodeEscape = (match: RegExpExecArray): number => {
  const { pair, braced, single } = match.groups ?? {};
  if (pair !== undefined) {
    const lead = Number.parseInt(pair.slice(0, 4), 16);
    const trail = Number.parseInt(pair.slice(6), 16);
    return (lead - 0xd8_00) * 0x4_00 + (trail - 0xdc_00) + 0x1_00_00;
  }
  return Number.parseInt(braced ?? single ?? '', 16);
};
