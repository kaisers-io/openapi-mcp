import { validationError } from '../errors.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import type { NamedOperation } from '../toolgen/naming.ts';
import {
  FILTER_WORK_BUDGET_EXCEEDED_MESSAGE,
  type FilterPattern,
  type MatchBudget,
  createMatchBudget,
  globMatches,
} from './pattern.ts';

// Spec §3.2 rule 3: with no --allow, only these methods are exposed
const READ_ONLY_METHODS = new Set(['get', 'head']);

// Suggestions are advisory: a pattern or candidate longer than this is skipped
// rather than paid for, which bounds the O(n*m) matrix at 65k cells
const SUGGESTION_MAX_LENGTH = 256;

// A floor so that short patterns ("gt" for "get") still get a suggestion
const MIN_SUGGESTION_DISTANCE = 2;

export interface DeadPattern {
  raw: string;
  // Which flag supplied the pattern, so the CLI never has to rebuild a
  // raw-string-to-flag map — a pattern given to both flags appears twice
  flag: 'allow' | 'deny';
  suggestion?: string | undefined;
}

export interface FilterDecision {
  exposed: readonly NamedOperation[];
  deadPatterns: readonly DeadPattern[];
}

// D15: the budget is threaded through rather than created per call, because the
// bound that matters is the aggregate over patterns x operations x candidate
// lengths. It defaults so that a direct caller (and every existing test) gets a
// full budget without having to construct one.
export const matchesOperation = (
  pattern: FilterPattern,
  op: OperationRecord,
  budget: MatchBudget = createMatchBudget(),
): boolean => {
  // D8: every comparison uses the raw normalized spec value. Sanitizing first
  // would collapse two distinct operations onto one decision and would let a
  // deny pattern silently miss its target; diagnostics sanitize at the print site.
  // The pattern carries its compiled programme, so nothing is compiled here.
  if (pattern.kind === 'tag') {
    return op.tags.some((tag) => globMatches(pattern.compiled, tag, budget));
  }
  if (pattern.kind === 'methodPath') {
    // Normalize stores the method lowercase; the pattern carries it uppercase.
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
// Final review, high-severity finding 1: this used to take no
// budget at all, so the suggestion phase escaped the D15 aggregate that
// matchesOperation/globMatches enforce — measured at 35,917 ms of CPU at
// admitted dimensions (128 dead patterns x 512 candidates x 256-char
// identifiers). Charged per row, before that row's cells are computed, so an
// exhausted budget stops the work rather than completing it — mirroring
// globMatches's spend discipline in pattern.ts exactly, sharing its message.
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
  let previous: number[] = [];
  for (let column = 0; column <= right.length; column += 1) {
    previous.push(column);
  }
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

// D15: the budget defaults exactly as matchesOperation's does, so the 14
// existing two-argument callers (and any other direct caller) keep working
// unchanged and get a full budget when no shared one is threaded in.
export const closestMatch = (
  raw: string,
  candidates: readonly string[],
  budget: MatchBudget = createMatchBudget(),
): string | undefined => {
  if (raw === '' || raw.length > SUGGESTION_MAX_LENGTH) {
    return undefined;
  }
  // Admission bound: half the typed pattern, floored at 2. Spec §8's own worked
  // example needs it this loose — "readPets" -> "readPetById" is distance 4 over
  // 8 characters, so a tighter proportion yields no suggestion in the
  // documented case. The floor keeps short patterns ("gt" -> "get") suggestible.
  const threshold = Math.max(MIN_SUGGESTION_DISTANCE, Math.ceil(raw.length / 2));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRatio = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.length > SUGGESTION_MAX_LENGTH) {
      continue;
    }
    const distance = boundedDistance(raw, candidate, threshold, budget);
    if (distance > threshold) {
      continue;
    }
    // Round-8 finding 5: ranking is LEXICOGRAPHIC — edit distance is primary,
    // and the length-relative ratio breaks ties only among candidates at equal
    // distance. The round-8 draft ranked on ratio alone and claimed "a strictly
    // nearer candidate still wins", justifying it with the single example
    // 1/8 < 4/11. That claim is false in general, and the plan's own contract
    // (see the Ranking note above) asserted the opposite of what the code did.
    // Counterexample, verified by execution: against "abcdefgh", the candidate
    // "abcdeXYZ" is 3 edits (3/8 = 0.375) while "abcdefghWXYZ" is 4 edits
    // (4/12 = 0.333) — both admitted, and ratio-alone returns the FARTHER one.
    //
    // Distance-first still produces every documented outcome, because §8's
    // example is an equal-distance tie that the ratio resolves: "readPets" is 4
    // edits from both "listPets" (4/8) and "readPetById" (4/11), so the ratio
    // picks "readPetById" exactly as the spec documents. Re-measured against
    // the whole closestMatch suite: distance-first passes all 14 existing cases
    // plus the counterexample; ratio-alone passes 14 and fails the 15th.
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
  operations: readonly OperationRecord[],
): readonly string[] => {
  const candidates = new Set<string>();
  for (const op of operations) {
    if (pattern.kind === 'tag') {
      for (const tag of op.tags) {
        candidates.add(tag);
      }
    } else if (pattern.kind === 'methodPath') {
      candidates.add(`${op.method.toUpperCase()} ${op.path}`);
    } else if (op.operationId !== undefined) {
      candidates.add(op.operationId);
    }
  }
  return [...candidates];
};

// A tag pattern's raw form carries the "tag:" prefix, which the candidates do
// not, so the prefix would inflate every distance by four
const suggestionInput = (pattern: FilterPattern): string =>
  pattern.kind === 'tag' ? pattern.glob : pattern.raw;

const deadPatternsFor = (
  patterns: readonly FilterPattern[],
  flag: 'allow' | 'deny',
  operations: readonly OperationRecord[],
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

// D15: ONE budget for the whole run — exposure and dead-pattern detection alike.
// Scoping it per match would bound nothing: the reachable cost is the aggregate
// over patterns x operations x candidate lengths, which is what measured 22.5 s
// at the maximum admitted dimensions even with a non-backtracking matcher.
export const applyFilters = (
  operations: readonly NamedOperation[],
  allow: readonly FilterPattern[],
  deny: readonly FilterPattern[],
  budget: MatchBudget = createMatchBudget(),
): FilterDecision => {
  const records = operations.map((entry) => entry.operation);
  const exposed = operations.filter(({ operation }) => {
    // Rule 1: --deny always wins over --allow, no exceptions
    if (deny.some((pattern) => matchesOperation(pattern, operation, budget))) {
      return false;
    }
    if (allow.length > 0) {
      // Rule 2: an explicit allow replaces the default entirely, so a matching
      // write operation present at startup is exposed
      return allow.some((pattern) => matchesOperation(pattern, operation, budget));
    }
    // Rule 3: read-only default
    return READ_ONLY_METHODS.has(operation.method);
  });
  // Spec §8: a pattern is dead when it matches zero operations in the ENTIRE
  // normalized inventory, evaluated before exposure. Deliberately not "zero
  // exposed operations" — a deny pattern that removes everything an allow
  // pattern selected is doing its job, not misspelled, and a pattern naming a
  // write operation hidden by the read-only default matched perfectly well.
  const deadPatterns = [
    ...deadPatternsFor(allow, 'allow', records, budget),
    ...deadPatternsFor(deny, 'deny', records, budget),
  ];
  return { exposed, deadPatterns };
};
