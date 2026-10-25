import { validationError } from '../errors.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import { FILTER_WORK_BUDGET_EXCEEDED_MESSAGE, createMatchBudget, globMatches } from './pattern.ts';
import type { FilterPattern, MatchBudget } from './pattern.ts';

// Suggestions are advisory: a pattern or candidate longer than this is skipped
// rather than paid for, which bounds the O(n*m) matrix at 65k cells
const SUGGESTION_MAX_LENGTH = 256;

// A floor so that short patterns ("gt" for "get") still get a suggestion
const MIN_SUGGESTION_DISTANCE = 2;

export type DeadPatternFlag = 'allow' | 'deny' | 'omit-output-schema';

export type DeadPattern = {
  raw: string;
  // Which flag supplied the pattern, so the CLI never has to rebuild a
  // raw-string-to-flag map — a pattern given to both flags appears twice
  flag: DeadPatternFlag;
  suggestion?: string | undefined;
  // The pattern names an operation of the spec that is not exposed, so no
  // suggestion is given: one omitted as not supported (every flag), or for
  // --omit-output-schema also one the filters leave out
  notExposed?: true;
};

// What a pattern is matched against: an operation of the spec, or an
// omitted one with its provenance (issue #41)
export type FilterTarget = Pick<OperationRecord, 'path' | 'operationId' | 'tags'> & {
  method: string;
};

// The budget is threaded through rather than created per call, because the
// bound that matters is the aggregate over patterns x operations x candidate
// lengths. It defaults so that a direct caller gets a full budget without
// having to construct one.
export const matchesOperation = (
  pattern: FilterPattern,
  op: FilterTarget,
  budget: MatchBudget = createMatchBudget(),
): boolean => {
  // Every comparison uses the raw normalized spec value. Sanitizing first
  // would collapse two distinct operations onto one decision and would let a
  // deny pattern silently miss its target; diagnostics sanitize at the print site.
  // The pattern carries its compiled programme, so nothing is compiled here.
  if (pattern.kind === 'tag') {
    return op.tags.some((tag) => globMatches(pattern.compiled, tag, budget));
  }
  if (pattern.kind === 'methodPath') {
    // Normalize stores a standard method lowercase and an additional one as
    // declared (upper case); the pattern carries it uppercase.
    // The method is an equality test, never a glob — and checking it FIRST means
    // a method mismatch costs no matcher steps at all.
    return (
      op.method.toUpperCase() === pattern.method && globMatches(pattern.compiled, op.path, budget)
    );
  }
  return op.operationId !== undefined && globMatches(pattern.compiled, op.operationId, budget);
};

// Levenshtein distance, abandoned as soon as it is known to exceed maxDistance.
// Returns maxDistance + 1 to signal "further than you asked about".
//
// Charged against the same aggregate budget that matchesOperation/globMatches
// enforce: at the admitted dimensions (128 dead patterns x 512 candidates x
// 256-char identifiers), running this phase unbudgeted costs 35,917 ms of
// CPU, so it needs the same guard. Charged per row, before that row's cells
// are computed, so an exhausted budget stops the work rather than completing
// it — mirroring globMatches's spend discipline in pattern.ts exactly,
// sharing its message.
const boundedDistance = (
  left: string,
  right: string,
  maxDistance: number,
  budget: MatchBudget,
): number => {
  const tooFar = maxDistance + 1;
  if (Math.abs(left.length - right.length) > maxDistance) {
    return tooFar;
  }
  const spend = (steps: number): void => {
    budget.remaining -= steps;
    if (budget.remaining < 0) {
      throw validationError(FILTER_WORK_BUDGET_EXCEEDED_MESSAGE);
    }
  };
  // The first row is 0..right.length by definition (deleting the whole
  // prefix of `right`); built directly since it never reads a prior row.
  let previous: number[] = Array.from({ length: right.length + 1 }, (_unused, column) => column);
  // Imperative on purpose: each cell reads BOTH the previous row and the
  // cell just computed to its own left in the same row, so a row cannot be
  // produced by mapping over its own output. The per-row budget spend and
  // early abort below must also run before the next row starts, mirroring
  // globMatches's spend discipline in pattern.ts exactly.
  for (let row = 1; row <= left.length; row += 1) {
    // One unit per cell in the row about to be computed, charged before it
    spend(right.length);
    const current = [row];
    for (let col = 1; col <= right.length; col += 1) {
      const substitution = (previous[col - 1] ?? 0) + (left[row - 1] === right[col - 1] ? 0 : 1);
      const deletion = (previous[col] ?? 0) + 1;
      const insertion = (current[col - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    // Values never decrease as rows advance, so a whole row above the bound
    // means the final cell is above it too
    if (Math.min(...current) > maxDistance) {
      return tooFar;
    }
    previous = current;
  }
  return previous[right.length] ?? tooFar;
};

// The budget defaults exactly as matchesOperation's does, so existing
// two-argument callers (and any other direct caller) keep working unchanged
// and get a full budget when no shared one is threaded in.
export const closestMatch = (
  raw: string,
  candidates: readonly string[],
  budget: MatchBudget = createMatchBudget(),
): string | undefined => {
  if (raw === '' || raw.length > SUGGESTION_MAX_LENGTH) {
    return undefined;
  }
  // Admission bound: half the typed pattern, floored at 2. This ratio needs to
  // be this loose to admit "readPets" -> "readPetById", which is distance 4
  // over 8 characters — a tighter proportion would yield no suggestion for
  // that pair. The floor keeps short patterns ("gt" -> "get") suggestible.
  const threshold = Math.max(MIN_SUGGESTION_DISTANCE, Math.ceil(raw.length / 2));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRatio = Number.POSITIVE_INFINITY;
  // Kept as a loop (not reduce): reduce skips array holes, silently changing
  // behaviour for a sparse candidates array on this exported function; the
  // loop visits every index.
  for (const candidate of candidates) {
    if (candidate.length > SUGGESTION_MAX_LENGTH) {
      continue;
    }
    const distance = boundedDistance(raw, candidate, threshold, budget);
    if (distance > threshold) {
      continue;
    }
    // Ranking is LEXICOGRAPHIC: edit distance is primary, and the
    // length-relative ratio breaks ties only among candidates at equal
    // distance. Ranking on ratio alone does not work: against "abcdefgh", the
    // candidate "abcdeXYZ" is 3 edits (3/8 = 0.375) while "abcdefghWXYZ" is 4
    // edits (4/12 = 0.333) — both admitted, and a ratio-alone rule would
    // return the FARTHER one.
    //
    // Distance-first still produces the correct outcome here too, because this
    // is an equal-distance tie that the ratio resolves: "readPets" is 4 edits
    // from both "listPets" (4/8) and "readPetById" (4/11), so the ratio picks
    // "readPetById".
    const ratio = distance / Math.max(raw.length, candidate.length);
    if (distance < bestDistance || (distance === bestDistance && ratio < bestRatio)) {
      best = candidate;
      bestDistance = distance;
      bestRatio = ratio;
    }
  }
  return best;
};

// The suggestion must come from the domain the pattern addresses: proposing an
// operationId for a dead "tag:" pattern would be actively misleading
const candidateSpace = (
  pattern: FilterPattern,
  operations: readonly FilterTarget[],
): readonly string[] => {
  // Pattern.kind is invariant across the walk, so it is branched on once
  // rather than re-tested per operation; the Set still dedups in the same
  // first-occurrence order the accumulating loop produced.
  if (pattern.kind === 'tag') {
    // Streams into the Set on purpose: tag occurrences are unbounded in a
    // hostile spec; flatMap would materialize every occurrence before
    // deduplication.
    const tags = new Set<string>();
    for (const op of operations) {
      for (const tag of op.tags) {
        tags.add(tag);
      }
    }
    return [...tags];
  }
  if (pattern.kind === 'methodPath') {
    return [...new Set(operations.map((op) => `${op.method.toUpperCase()} ${op.path}`))];
  }
  return [
    ...new Set(operations.flatMap((op) => (op.operationId === undefined ? [] : [op.operationId]))),
  ];
};

// A tag pattern's raw form carries the "tag:" prefix, which the candidates do
// not, so the prefix would inflate every distance by four
const suggestionInput = (pattern: FilterPattern): string =>
  pattern.kind === 'tag' ? pattern.glob : pattern.raw;

export const deadPatternsFor = (
  patterns: readonly FilterPattern[],
  flag: DeadPatternFlag,
  operations: readonly FilterTarget[],
  budget: MatchBudget,
): readonly DeadPattern[] =>
  patterns
    .filter(
      (pattern) => !operations.some((operation) => matchesOperation(pattern, operation, budget)),
    )
    .map((pattern) => {
      const suggestion = closestMatch(
        suggestionInput(pattern),
        candidateSpace(pattern, operations),
        budget,
      );
      return suggestion === undefined
        ? { raw: pattern.raw, flag }
        : { raw: pattern.raw, flag, suggestion };
    });
