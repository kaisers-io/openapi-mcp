import { usageError, validationError } from '../errors.ts';
import { HTTP_METHODS } from '../spec/normalize.ts';
import type { HttpMethod } from '../spec/normalize.ts';

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

const TAG_PREFIX = 'tag:';

// Derived from HTTP_METHODS rather than typed as string: adding or removing an
// exposable method in normalize.ts becomes a compile error here, not drift.
// HTTP_METHODS already excludes OPTIONS and TRACE, which are never exposed in
// v1, so those spellings are rejected for free.
export type FilterMethod = Uppercase<HttpMethod>;

// The compiled programme travels with the pattern, so a pattern is compiled
// exactly once at parse time rather than once per candidate string
export type FilterPattern =
  | { kind: 'operationId'; glob: string; raw: string; compiled: CompiledGlob }
  | {
      kind: 'methodPath';
      method: FilterMethod;
      glob: string;
      raw: string;
      compiled: CompiledGlob;
    }
  | { kind: 'tag'; glob: string; raw: string; compiled: CompiledGlob };

const EXPOSABLE_METHODS: readonly FilterMethod[] = HTTP_METHODS.map(
  (method) => method.toUpperCase() as FilterMethod,
);
const EXPOSABLE_METHOD_SET = new Set<string>(EXPOSABLE_METHODS);

const isFilterMethod = (value: string): value is FilterMethod => EXPOSABLE_METHOD_SET.has(value);

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

export const compileGlob = (glob: string): CompiledGlob => {
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
  const points = [...glob];
  const tokens: GlobToken[] = [];
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
      tokens.push(end - index === 1 ? STAR : GLOBSTAR);
      index = end;
      continue;
    }
    // Every other code point is a literal, including regex syntax. There is no
    // escaping step because nothing is ever handed to a RegExp constructor —
    // which also means an unbalanced metacharacter cannot throw.
    tokens.push(ch as string);
    index += 1;
  }
  let minLength = 0;
  for (const token of tokens) {
    if (token !== STAR && token !== GLOBSTAR) {
      minLength += 1;
    }
  }
  let prefix = '';
  for (const token of tokens) {
    if (token === STAR || token === GLOBSTAR) {
      break;
    }
    prefix += token;
  }
  let suffix = '';
  for (let pos = tokens.length - 1; pos >= 0; pos -= 1) {
    const token = tokens[pos];
    if (token === STAR || token === GLOBSTAR) {
      break;
    }
    suffix = `${token as string}${suffix}`;
  }
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
  // Materializing the code points is O(value length) and happens first.
  spend(value.length);
  const points = [...value];
  if (points.length < minLength) {
    return false;
  }
  // A prefix/suffix comparison is bounded by the affix length, so that is what
  // it costs — charged before the comparison rather than after it, so an
  // exhausted budget stops the work instead of merely reporting it
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

export const parseFilterPattern = (raw: string): FilterPattern => {
  if (raw === '') {
    throw usageError('a filter pattern must not be empty');
  }
  if (raw.length > FILTER_PATTERN_MAX_LENGTH) {
    throw usageError(`a filter pattern must be at most ${FILTER_PATTERN_MAX_LENGTH} characters`);
  }
  if (raw.startsWith(TAG_PREFIX)) {
    const glob = raw.slice(TAG_PREFIX.length);
    if (glob === '') {
      throw usageError('a "tag:" filter pattern needs a tag glob, for example "tag:admin*"');
    }
    // Compiled once at parse time and CARRIED on the pattern: an unusable glob
    // is a startup usage error, and matching never recompiles per candidate
    return { kind: 'tag', glob, raw, compiled: compileGlob(glob) };
  }
  const spaceIndex = raw.indexOf(' ');
  if (spaceIndex !== -1) {
    // A space can only mean the "<METHOD> <path-glob>" form: operationIds never
    // contain one, so this branch reports a precise error rather than silently
    // degrading a typo into an operationId pattern that matches nothing
    const method = raw.slice(0, spaceIndex);
    const glob = raw.slice(spaceIndex + 1);
    if (!isFilterMethod(method)) {
      // The raw value is never echoed: it is operator input of unknown shape
      throw usageError(
        `a "<METHOD> <path>" filter pattern must start with one of ${EXPOSABLE_METHODS.join(', ')}`,
      );
    }
    if (!glob.startsWith('/')) {
      throw usageError(
        'a "<METHOD> <path>" filter pattern needs exactly one space and a path that' +
          ' must start with "/", for example "GET /users/**"',
      );
    }
    return { kind: 'methodPath', method, glob, raw, compiled: compileGlob(glob) };
  }
  return { kind: 'operationId', glob: raw, raw, compiled: compileGlob(raw) };
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
