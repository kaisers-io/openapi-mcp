import { RE2JS } from 're2js';

// Response `pattern` safety (kaisers-io/openapi-mcp-archive#39, issue #104).
// An output schema is compiled by Ajv, which runs every `pattern` on upstream
// data, synchronously, after the request timeout has stopped applying. The
// server's Ajv runs patterns with RE2 (re2js, compileRe2Pattern below), whose
// matching time is linear in the input. The MCP client compiles the advertised
// outputSchema with its own Ajv, a backtracking engine, where a pattern such as
// `^(a+)+$` can take seconds on a short, near-matching string. So a response
// pattern with NESTED QUANTIFIERS (star height > 1, the heuristic popularised
// by safe-regex), or one RE2 cannot run, is not advertised: only the `pattern`
// keyword is dropped, and the node's description carries it as text.
//
// "Nested" means a quantified group that itself contains a quantifier, where
// at least one of the two is unbounded, or both are bounded but wide:
//   - a group repeated more than once (`*`, `+`, `{n,}`, `{n,m}` with m > 1)
//     that contains an UNBOUNDED quantifier (`*`, `+`, `{n,}`): `(a+)+`,
//     `(\w+\s?)*`, `(a*){2}`;
//   - an UNBOUNDED repetition of a group that contains any VARIABLE quantifier
//     (`?`, `{n,m}` with n < m, or unbounded): `(a?)+`, `(\d{1,3})*`;
//   - a BOUNDED repetition (max > 1) of a group that contains a variable
//     quantifier, when the ways to split one match exceed CHOICE_BUDGET:
//     `(a{1,20}){1,20}`, `([a-z0-9]{1,63}\.?){1,8}`. Bounds alone do not keep
//     the cost small: the first has more than 20^20 ways.
// Small bounded nestings stay supported: `(\d{1,3}\.){3}` (IPv4, 3^3 = 27
// ways), `(-[0-9a-f]{4}){3}` (UUID, fixed width).
// Not detected (documented limits of a star-height heuristic): overlapping
// alternation under one quantifier (`(a|a)+`) and backreferences.

// `choices` multiplies the spans (max - min + 1) of the quantifiers in the
// current alternative; `alternatives` sums those of the alternatives before
// it. Both are counts of ways to match, so an overflow to Infinity refuses.
type GroupSummary = {
  unbounded: boolean;
  variable: boolean;
  choices: number;
  alternatives: number;
};

const CHOICE_BUDGET = 64;

const openGroup = (): GroupSummary => ({
  unbounded: false,
  variable: false,
  choices: 1,
  alternatives: 0,
});

type Quantifier = { min: number; max: number };

const BRACE_QUANTIFIER_RE = /^\{(?<min>\d+)(?<range>,(?<max>\d*))?\}/u;

// Reads the quantifier starting at `index`, if any, and its source length.
const readQuantifier = (
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
const skipEscape = (pattern: string, index: number): number => {
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
const skipClass = (pattern: string, index: number): number => {
  let cursor = index + 1;
  while (cursor < pattern.length && pattern[cursor] !== ']') {
    cursor = pattern[cursor] === '\\' ? cursor + 2 : cursor + 1;
  }
  return Math.min(cursor + 1, pattern.length);
};

// Length of a group's opening syntax: `(`, `(?:`, `(?=`, `(?!`, `(?<=`,
// `(?<!`, `(?<name>`.
const groupOpenLength = (pattern: string, index: number): number => {
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

export const hasNestedQuantifier = (pattern: string): boolean => {
  // One summary per open group; index 0 is the whole pattern.
  const stack: GroupSummary[] = [openGroup()];
  // The atom a following quantifier applies to: a closed group's summary, a
  // plain atom (`undefined` summary), or nothing (start of a group / after a
  // quantifier).
  let previous: { group?: GroupSummary } | undefined;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    const top = stack.at(-1) as GroupSummary;
    if (char === '\\') {
      index = skipEscape(pattern, index);
      previous = {};
      continue;
    }
    if (char === '[') {
      index = skipClass(pattern, index);
      previous = {};
      continue;
    }
    if (char === '(') {
      index += groupOpenLength(pattern, index);
      stack.push(openGroup());
      previous = undefined;
      continue;
    }
    if (char === ')' && stack.length > 1) {
      const closed = stack.pop() as GroupSummary;
      const parent = stack.at(-1) as GroupSummary;
      parent.unbounded ||= closed.unbounded;
      parent.variable ||= closed.variable;
      // One occurrence of the group; a following quantifier adds the rest
      closed.choices += closed.alternatives;
      parent.choices *= closed.choices;
      index += 1;
      previous = { group: closed };
      continue;
    }
    const read = readQuantifier(pattern, index);
    if (read === undefined || previous === undefined) {
      if (char === '|') {
        top.alternatives += top.choices;
        top.choices = 1;
      }
      index += 1;
      previous = char === '|' ? undefined : {};
      continue;
    }
    const { min, max } = read.quantifier;
    const unbounded = max === Infinity;
    const variable = min !== max;
    const span = max - min + 1;
    const inner = previous.group;
    const body = inner?.choices ?? 1;
    if (
      inner !== undefined &&
      ((max > 1 && inner.unbounded) ||
        (unbounded && inner.variable) ||
        (max > 1 && inner.variable && body ** max * span > CHOICE_BUDGET))
    ) {
      return true;
    }
    top.unbounded ||= unbounded;
    top.variable ||= variable;
    // The group's first occurrence is already counted. A `{0}` group still
    // counts once, which only errs on the side of refusing. 1 ** Infinity is
    // NaN, which would compare as within budget.
    top.choices *= body === 1 || max === 0 ? span : body ** (max - 1) * span;
    index += read.length;
    // A lazy (`?`) suffix belongs to this quantifier.
    if (pattern[index] === '?') {
      index += 1;
    }
    previous = undefined;
  }
  return false;
};

// RE2 for a JavaScript `u`-mode pattern, or `undefined` when RE2 cannot run it
// with the same meaning (issue #104). RE2 writes `\uXXXX` and `\u{X}` as
// `\x{X}`; a surrogate pair is one code point. Two JavaScript forms are valid
// RE2 with another meaning, so they are refused: a class that starts with `]`
// (`[]` and `[^]` are complete classes in JavaScript) and `[:` inside a class
// (an RE2 POSIX class such as `[[:alpha:]]`). What RE2 does not support
// (lookaround, backreferences, `\cX`, `[\b]`, `\p{Script=...}`) fails to compile.
// `.`, `\s` and `\S` become JavaScript's sets: server and client agree on values.
const JS_LINE_TERMINATORS = String.raw`\n\r\x{2028}\x{2029}`;
const JS_WHITESPACE = String.raw`\t\n\x{b}\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`;
const JS_NON_WHITESPACE =
  String.raw`\x{0}-\x{8}\x{e}-\x{1f}\x{21}-\x{9f}\x{a1}-\x{167f}\x{1681}-\x{1fff}\x{200b}-\x{2027}` +
  String.raw`\x{202a}-\x{202e}\x{2030}-\x{205e}\x{2060}-\x{2fff}\x{3001}-\x{fefe}\x{ff00}-\x{10ffff}`;

const UNICODE_ESCAPE_RE =
  /\\u(?:(?<pair>[dD][89abAB][\da-fA-F]{2}\\u[dD][c-fC-F][\da-fA-F]{2})|\{(?<braced>[\da-fA-F]+)\}|(?<single>[\da-fA-F]{4}))/uy;

const unicodeEscape = (match: RegExpExecArray): number => {
  const { pair, braced, single } = match.groups ?? {};
  if (pair !== undefined) {
    const lead = Number.parseInt(pair.slice(0, 4), 16);
    const trail = Number.parseInt(pair.slice(6), 16);
    return (lead - 0xd8_00) * 0x4_00 + (trail - 0xdc_00) + 0x1_00_00;
  }
  return Number.parseInt(braced ?? single ?? '', 16);
};

const re2Source = (pattern: string): string | undefined => {
  let source = '';
  let inClass = false;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char === '\\') {
      UNICODE_ESCAPE_RE.lastIndex = index;
      const match = UNICODE_ESCAPE_RE.exec(pattern);
      const escaped = pattern[index + 1];
      if (match === null && (escaped === 's' || escaped === 'S')) {
        const set = escaped === 's' ? JS_WHITESPACE : JS_NON_WHITESPACE;
        source += inClass ? set : `[${set}]`;
        index += 2;
      } else if (match === null) {
        source += pattern.slice(index, index + 2);
        index += 2;
      } else {
        source += `\\x{${unicodeEscape(match).toString(16)}}`;
        index += match[0].length;
      }
      continue;
    }
    if (inClass) {
      if (char === '[' && pattern[index + 1] === ':') {
        return undefined;
      }
      inClass = char !== ']';
    } else if (char === '[') {
      const first = pattern[index + 1] === '^' ? index + 2 : index + 1;
      if (pattern[first] === ']') {
        return undefined;
      }
      inClass = true;
      source += pattern.slice(index, first);
      index = first;
      continue;
    }
    source += !inClass && char === '.' ? `[^${JS_LINE_TERMINATORS}]` : char;
    index += 1;
  }
  return source;
};

export const compileRe2Pattern = (pattern: string): RE2JS | undefined => {
  const source = re2Source(pattern);
  if (source === undefined) {
    return undefined;
  }
  try {
    return RE2JS.compile(source);
  } catch {
    return undefined;
  }
};

// Whether a response `pattern` stays in the advertised output schema: valid
// JavaScript (the client's Ajv compiles it with the `u` flag), without nested
// quantifiers (the client's engine backtracks), and runnable by RE2 (the
// server's engine). Compiling a RegExp does not run it.
const isJavaScriptPattern = (pattern: string): boolean => {
  try {
    return new RegExp(pattern, 'u') instanceof RegExp;
  } catch {
    return false;
  }
};

export const isEnforceablePattern = (pattern: string): boolean =>
  isJavaScriptPattern(pattern) &&
  !hasNestedQuantifier(pattern) &&
  compileRe2Pattern(pattern) !== undefined;
