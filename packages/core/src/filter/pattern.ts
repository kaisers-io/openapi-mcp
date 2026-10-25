import { usageError, validationError } from '../errors.ts';
import { HTTP_METHODS } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OperationMethod } from '../spec/normalize.ts';

// Patterns are operator input from argv, not spec content, but they are still
// bounded: the cap keeps the token programme short and the Levenshtein
// suggestion in engine.ts's closestMatch cheap
export const FILTER_PATTERN_MAX_LENGTH = 256;

// A SANITY bound, not a safety property. The matcher is a non-backtracking
// state-set simulation whose cost is strictly O(tokens x length), so a
// wildcard count cannot produce exponential blowup, and this cap is not what
// makes matching safe. Safety comes from two mechanisms: the non-backtracking
// Thompson simulation itself (no input-dependent blowup) and the aggregate
// step budget (FILTER_MAX_MATCH_STEPS). The cap survives only because no real
// filter pattern comes close to 10 and rejecting absurd input early is cheap.
// Enforced inside compileGlob so every caller inherits it, not only argv.
export const FILTER_PATTERN_MAX_WILDCARDS = 10;

// Per-flag occurrence cap, enforced by parseFilterPatterns below. Filtering is
// O(patterns x operations), so both factors are bounded. The bound belongs on
// the list parser rather than at the command boundary: it is a property of a
// list, and every caller that has one inherits it here.
export const FILTER_PATTERN_MAX_COUNT = 128;

// The upper-case form of an exposable method: one of HTTP_METHODS, or a
// method an OpenAPI 3.2 spec declares under `additionalOperations` (issue
// #33). The parser cannot know the latter, so applyFilters (engine.ts)
// rejects a pattern whose method is neither standard nor declared by an
// operation: a misspelled method stays a startup error.
export type FilterMethod = Uppercase<OperationMethod>;

// An explicit selector (issue #42): `method:`, `path:`, `route:`,
// `operationId:`, `name:` or `tag:`. Every one matches regardless of case.
// The compiled programme travels with the pattern, so a pattern is compiled
// exactly once at parse time rather than once per candidate string.
export type FilterNameKind = 'operationId' | 'name' | 'tag';
export type FilterPattern =
  | { kind: 'method'; method: FilterMethod; raw: string }
  | { kind: 'path'; glob: string; raw: string; compiled: CompiledGlob }
  | {
      kind: 'route';
      method: FilterMethod;
      glob: string;
      raw: string;
      compiled: CompiledGlob;
    }
  | { kind: FilterNameKind; glob: string; raw: string; compiled: CompiledGlob };

export const STANDARD_FILTER_METHODS: ReadonlySet<string> = new Set(
  HTTP_METHODS.map((method) => method.toUpperCase()),
);

// RFC 9110 §9.1 token in upper case. OPTIONS, TRACE, CONNECT and TRACK are
// never exposed, so a pattern naming one is rejected rather than left dead.
const FILTER_METHOD_RE = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/u;
const NEVER_EXPOSED_FILTER_METHODS: ReadonlySet<string> = new Set([
  'OPTIONS',
  'TRACE',
  'CONNECT',
  'TRACK',
]);

const isFilterMethod = (value: string): value is FilterMethod =>
  FILTER_METHOD_RE.test(value) && !NEVER_EXPOSED_FILTER_METHODS.has(value);

// The token programme. A pattern lowers to literal code points plus two
// wildcard kinds, and matching is a state-set simulation over it — there is no
// RegExp on the production path at all. The compiled RegExp survives only in the
// test suite, as the oracle the differential fuzz test compares against.
export const STAR = 1; // Zero or more code points other than "/"
export const GLOBSTAR = 2; // Zero or more code points, "/" included

export type GlobToken = string | typeof STAR | typeof GLOBSTAR;

export type CompiledGlob = {
  tokens: readonly GlobToken[];
  // Prefilters. Each is a cheap necessary condition, so a non-match usually
  // costs O(1) instead of a full simulation.
  minLength: number;
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
};

// `segmented`: a path glob, where `*` stays within one segment and `**`
// crosses them. In an operationId, tool name or tag `*` matches any
// characters, `/` included (GitHub's operationIds read `repos/get`). The glob
// is matched regardless of case: it is compiled in lower case, and a value is
// lowered before it is matched (engine.ts). There is no escape for a literal
// `*`.
export const compileGlob = (glob: string, segmented = true, fold = true): CompiledGlob => {
  if (glob.length > FILTER_PATTERN_MAX_LENGTH) {
    throw usageError(`a filter pattern must be at most ${FILTER_PATTERN_MAX_LENGTH} characters`);
  }
  // Tokenize by CODE POINT, not by UTF-16 code unit: indexing `glob[index]`
  // would walk code units while the matcher iterates `for...of` (code
  // points), so a literal astral character would compile to two surrogate
  // tokens that no single code point could ever equal. Code points are also
  // the unit the /u-flag RegExp oracle (used as the differential-fuzz
  // reference) works in, so this is what keeps the two representations
  // equivalent.
  const points = [...(fold ? glob.toLowerCase() : glob)];
  const tokens: GlobToken[] = [];
  // Imperative on purpose: a "*" run consumes a variable number of code
  // points in one step (so the index can jump by more than one), and the
  // wildcard cap must be checked at the moment a run is counted — neither is
  // expressible as a map over a fixed-size array without reintroducing this
  // same index-tracking state.
  let index = 0;
  let wildcards = 0;
  while (index < points.length) {
    const ch = points[index];
    if (ch === '*') {
      // Consume the whole run at once: "***" is identical to "**", and one run
      // counts as ONE wildcard against the cap
      let end = index;
      while (points[end] === '*') {
        end += 1;
      }
      wildcards += 1;
      if (wildcards > FILTER_PATTERN_MAX_WILDCARDS) {
        throw usageError(
          `a filter pattern may contain at most ${FILTER_PATTERN_MAX_WILDCARDS} wildcards`,
        );
      }
      tokens.push(end - index === 1 && segmented ? STAR : GLOBSTAR);
      index = end;
      continue;
    }
    // Every other code point is a literal, including regex syntax. There is no
    // escaping step because nothing is ever handed to a RegExp constructor —
    // which also means an unbalanced metacharacter cannot throw.
    tokens.push(ch as string);
    index += 1;
  }
  const minLength = tokens.filter((token) => token !== STAR && token !== GLOBSTAR).length;
  // The prefix is every literal token before the FIRST wildcard; slicing to
  // that index and joining is the pure equivalent of concatenating until the
  // break, and `join('')` on the literal-only slice concatenates exactly like
  // the `+=` loop did (no separator, no wildcard tokens can be present in it).
  const firstWildcard = tokens.findIndex((token) => token === STAR || token === GLOBSTAR);
  const prefix = (firstWildcard === -1 ? tokens : tokens.slice(0, firstWildcard)).join('');
  // The suffix is every literal token after the LAST wildcard, in original
  // (left-to-right) order — the backward loop rebuilt that order by
  // prepending; slicing from just past the last wildcard and joining forward
  // produces the identical string without needing the prepend.
  const lastWildcard = tokens.findLastIndex((token) => token === STAR || token === GLOBSTAR);
  const suffix = tokens.slice(lastWildcard + 1).join('');
  return {
    tokens,
    minLength,
    prefix,
    suffix,
    hasWildcard: tokens.some((token) => token === STAR || token === GLOBSTAR),
  };
};

// A non-backtracking matcher removes the exponential class but NOT the
// aggregate: at the maximum admitted dimensions, a short pathological pattern
// still costs 22.5 s against long values, because patterns x operations x
// tokens x length is large even when every factor is polynomial. One budget
// covers a whole applyFilters run. The step count is a pure function of the
// inputs, so it is a deterministic proxy for cost where wall-clock time would
// not be.
//
// The step counter charges every input-dependent cost (code-point
// materialization, affix comparisons, state-array initialization). At the
// admitted maxima (patterns x operations x tokens x length), a realistic
// maximal configuration measures 33.1M steps, so this cap gives it 6.0x
// headroom while a pathological pattern still runs for about 1.4 s before
// being cut off. That trade is deliberate: refusing a legitimate filter set
// is a worse failure than a slow refusal of a hostile one.
//
// Since the tool budget moved after filtering (issue
// kaisers-io/openapi-mcp-archive#32), filters run over up to
// SPEC_BUDGETS.maxOperationCount (4096) operations rather than 512. A worst
// realistic configuration there (256 patterns of four selectors, none
// matching early, plus the dead-pattern and case-collision passes) measures
// 18.0M steps, 9% of this cap, since a value the affixes rule out is no
// longer read whole; the cap and with it the hostile cut-off time stay
// unchanged (filter-engine.test.ts pins the headroom).
export const FILTER_MAX_MATCH_STEPS = 200_000_000;

export type MatchBudget = {
  remaining: number;
};

export const createMatchBudget = (limit: number = FILTER_MAX_MATCH_STEPS): MatchBudget => ({
  remaining: limit,
});

// Shared by globMatches below and closestMatch's boundedDistance in
// engine.ts — both spend against the same aggregate step budget, so this
// message covers either exhaustion path and the two cannot drift apart by
// each defining their own.
export const FILTER_WORK_BUDGET_EXCEEDED_MESSAGE =
  'filter matching exceeded its work budget — reduce the number of --allow/--deny patterns, the number of wildcards in them, or the size of the spec';

// Thompson state-set simulation. Every input code unit advances each live state
// at most once, so the cost is strictly O(tokens x length) with no
// input-dependent blowup: the shape that cost 134 ms as a RegExp costs 0.004 ms
// here, and stays flat out to a 65,536-character value.
export const globMatches = (
  compiled: CompiledGlob,
  value: string,
  budget: MatchBudget,
): boolean => {
  const { tokens, minLength, prefix, suffix, hasWildcard } = compiled;
  const spend = (steps: number): void => {
    budget.remaining -= steps;
    if (budget.remaining < 0) {
      throw validationError(FILTER_WORK_BUDGET_EXCEEDED_MESSAGE);
    }
  };
  // The counter charges EVERY input-dependent cost, in the order the work
  // happens: materializing the value's code points, running
  // startsWith/endsWith, and allocating two Int32Arrays all scale with value
  // or pattern length, so a flat per-call charge would not describe the work
  // performed.
  //
  // A prefix/suffix comparison is bounded by the affix length, so that is what
  // it costs — charged before the comparison rather than after it, so an
  // exhausted budget stops the work instead of merely reporting it. Both run
  // before the value is materialized, so a value the affixes rule out never
  // pays for its length (most patterns against most operations).
  if (prefix !== '') {
    spend(prefix.length);
    if (!value.startsWith(prefix)) {
      return false;
    }
  }
  if (suffix !== '') {
    spend(suffix.length);
    if (!value.endsWith(suffix)) {
      return false;
    }
  }
  // Materializing the code points is O(value length)
  spend(value.length);
  const points = [...value];
  if (points.length < minLength) {
    return false;
  }
  if (!hasWildcard) {
    spend(prefix.length);
    return value === prefix;
  }
  const tokenCount = tokens.length;
  // The two state arrays are allocated and filled per match: O(tokens) each
  spend(2 * (tokenCount + 1));
  // Generation stamps replace a Uint8Array cleared per input unit:
  // `next.fill(0)` costs O(tokens) for EVERY character, which a pattern
  // keeping many states live would turn into O(tokens x length) real work
  // while charging only O(length) steps. Stamping removes the clearing loop
  // entirely, so the only input-dependent loops left are the transition scan
  // and the epsilon closure — and both are charged below.
  let currentStamp = new Int32Array(tokenCount + 1).fill(-1);
  let nextStamp = new Int32Array(tokenCount + 1).fill(-1);
  let currentList: number[] = [];
  // Epsilon-closure: a wildcard is zero-or-more, so a state may skip past it
  const addState = (stamp: Int32Array, list: number[], generation: number, start: number): void => {
    let pos = start;
    for (;;) {
      spend(1);
      if (stamp[pos] === generation) {
        return;
      }
      stamp[pos] = generation;
      list.push(pos);
      const token = tokens[pos];
      if (pos < tokenCount && (token === STAR || token === GLOBSTAR)) {
        pos += 1;
        continue;
      }
      return;
    }
  };
  addState(currentStamp, currentList, 0, 0);
  for (let index = 0; index < points.length; index += 1) {
    const ch = points[index];
    const nextList: number[] = [];
    // Only live states are visited, and each visit is charged
    for (const pos of currentList) {
      spend(1);
      if (pos >= tokenCount) {
        continue;
      }
      const token = tokens[pos];
      if (token === GLOBSTAR) {
        addState(nextStamp, nextList, index + 1, pos);
      } else if (token === STAR) {
        // A single star never crosses a path separator
        if (ch !== '/') {
          addState(nextStamp, nextList, index + 1, pos);
        }
      } else if (token === ch) {
        addState(nextStamp, nextList, index + 1, pos + 1);
      }
    }
    if (nextList.length === 0) {
      return false;
    }
    const swapStamp = currentStamp;
    currentStamp = nextStamp;
    nextStamp = swapStamp;
    currentList = nextList;
  }
  return currentStamp[tokenCount] === points.length;
};

const SELECTORS = ['method', 'path', 'route', 'operationId', 'name', 'tag'] as const;
type Selector = (typeof SELECTORS)[number];
const SELECTOR_LIST = SELECTORS.map((selector) => `${selector}:`).join(', ');

// What a pattern written without a selector most likely meant, as the
// explicit form. Operator input, so it is shown sanitized and bounded.
const replacementFor = (raw: string): string => {
  const space = raw.indexOf(' ');
  if (space !== -1) {
    return `"route:${raw.slice(0, space).toUpperCase()}${raw.slice(space)}"`;
  }
  if (/^\*+$/u.test(raw)) {
    return '"path:/**" (every operation) or "operationId:*" (every operationId)';
  }
  if (STANDARD_FILTER_METHODS.has(raw.toUpperCase())) {
    return `"method:${raw.toLowerCase()}" (the method) or "operationId:${raw}"`;
  }
  return `"operationId:${raw}"`;
};

const selectorError = (raw: string, problem: string): Error =>
  usageError(
    `${problem}; write ${sanitizeSpecText(replacementFor(raw), FILTER_PATTERN_MAX_LENGTH)}. Selectors: ${SELECTOR_LIST}`,
  );

const methodOf = (value: string, selector: string): FilterMethod => {
  const method = value.toUpperCase();
  if (!isFilterMethod(method)) {
    throw usageError(
      `a "${selector}" filter pattern needs an HTTP method: one of ${[...STANDARD_FILTER_METHODS].join(', ')}, or one the spec declares under additionalOperations`,
    );
  }
  return method;
};

const pathGlobOf = (glob: string, selector: string): string => {
  if (!glob.startsWith('/') && !glob.startsWith('*')) {
    throw usageError(
      `a "${selector}" filter pattern needs a path that starts with "/" or "*", for example "${selector}${selector === 'route:' ? 'GET ' : ''}/orders/**"`,
    );
  }
  return glob;
};

const parseSelector = (selector: Selector, value: string, raw: string): FilterPattern => {
  if (selector === 'method') {
    return { kind: 'method', method: methodOf(value, 'method:'), raw };
  }
  if (selector === 'route') {
    const space = value.indexOf(' ');
    const glob = pathGlobOf(space === -1 ? '' : value.slice(space + 1), 'route:');
    const method = methodOf(space === -1 ? value : value.slice(0, space), 'route:');
    return { kind: 'route', method, glob, raw, compiled: compileGlob(glob) };
  }
  if (selector === 'path') {
    const glob = pathGlobOf(value, 'path:');
    return { kind: 'path', glob, raw, compiled: compileGlob(glob) };
  }
  if (value === '') {
    throw usageError(
      `a "${selector}:" filter pattern needs a value, for example "${selector}:Orders*"`,
    );
  }
  return { kind: selector, glob: value, raw, compiled: compileGlob(value, false) };
};

export const parseFilterPattern = (raw: string): FilterPattern => {
  if (raw === '') {
    throw usageError('a filter pattern must not be empty');
  }
  if (raw.length > FILTER_PATTERN_MAX_LENGTH) {
    throw usageError(`a filter pattern must be at most ${FILTER_PATTERN_MAX_LENGTH} characters`);
  }
  // Split at the first colon only, so a value may hold more (`tag:a:b`). A
  // space before any colon is the old `METHOD /path` form, whose path may
  // contain a colon of its own.
  const colon = raw.indexOf(':');
  const space = raw.indexOf(' ');
  if (colon === -1 || (space !== -1 && space < colon)) {
    throw selectorError(raw, 'a filter pattern needs a selector');
  }
  const keyword = raw.slice(0, colon).toLowerCase();
  const selector = SELECTORS.find((known) => known.toLowerCase() === keyword);
  if (selector === undefined) {
    throw selectorError(raw, 'unknown filter selector');
  }
  return parseSelector(selector, raw.slice(colon + 1), raw);
};

// One flag's worth of patterns. The count cap is checked before a single
// pattern is compiled, so an over-long list costs one comparison rather than
// 129 pattern compilations, and every caller with a list inherits the bound
// instead of restating it at its own boundary.
export const parseFilterPatterns = (raws: readonly string[]): readonly FilterPattern[] => {
  if (raws.length > FILTER_PATTERN_MAX_COUNT) {
    throw usageError(
      `too many filter patterns — at most ${FILTER_PATTERN_MAX_COUNT} patterns are accepted per flag`,
    );
  }
  return raws.map((raw) => parseFilterPattern(raw));
};
