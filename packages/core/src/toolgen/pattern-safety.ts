// Response `pattern` safety (kaisers-io/openapi-mcp-archive#39). An output
// schema is compiled by Ajv, which runs every `pattern` as a JavaScript RegExp,
// synchronously, on upstream data — after the request timeout has stopped
// applying. A backtracking pattern such as `^(a+)+$` can then block the event
// loop for seconds on a short, near-matching string. The policy is fail-closed
// at tool generation: a response schema carrying a pattern with NESTED
// QUANTIFIERS (star height > 1, the heuristic popularised by safe-regex) is
// unrepresentable, so the tool gets no outputSchema and returns its result as
// text — the pattern is never run.
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
