import { describe, expect, it } from 'vitest';
import {
  FILTER_MAX_MATCH_STEPS,
  createMatchBudget,
  applyFilters,
  assignToolNames,
  closestMatch,
  matchesOperation,
  parseFilterPattern,
  type FilterPattern,
  type HttpMethod,
  type NamedOperation,
  type OperationRecord,
} from '../src/index.ts';

const record = (
  method: HttpMethod,
  path: string,
  operationId?: string,
  tags: readonly string[] = [],
): OperationRecord => ({
  method,
  path,
  ...(operationId === undefined ? {} : { operationId }),
  tags,
  deprecated: false,
  parameters: [],
  responses: {},
});

const named = (operations: readonly OperationRecord[]): readonly NamedOperation[] =>
  assignToolNames(operations);

const patterns = (...raw: readonly string[]): readonly FilterPattern[] =>
  raw.map((one) => parseFilterPattern(one));

const exposedIds = (decision: { exposed: readonly NamedOperation[] }): readonly string[] =>
  decision.exposed.map((entry) => entry.toolName);

// Deliberately realistic: "headPets" is a plausible name for a HEAD operation
// and sits 1 edit from "readPets", which is what makes the ranking assertions
// below meaningful rather than shaped to a desired answer
const fixture = [
  record('get', '/pets', 'listPets', ['pets', 'public']),
  record('get', '/pets/{petId}', 'readPetById', ['pets']),
  record('head', '/pets', 'headPets', ['pets']),
  record('post', '/pets', 'createPet', ['pets', 'admin']),
  record('delete', '/pets/{petId}', 'deletePet', ['pets', 'admin']),
  record('put', '/admin/config', undefined, ['admin']),
];

describe('matchesOperation', () => {
  it('matches an operationId glob against the raw operationId', () => {
    expect(matchesOperation(parseFilterPattern('read*'), fixture[1]!)).toBe(true);
    expect(matchesOperation(parseFilterPattern('read*'), fixture[0]!)).toBe(false);
  });

  it('never matches an operationId pattern against an operation without one', () => {
    expect(matchesOperation(parseFilterPattern('**'), fixture[5]!)).toBe(false);
  });

  it('matches a methodPath pattern on method and path together', () => {
    const pattern = parseFilterPattern('GET /pets/**');
    expect(matchesOperation(pattern, fixture[1]!)).toBe(true);
    expect(matchesOperation(pattern, fixture[4]!)).toBe(false);
  });

  it('compares the uppercase pattern method against the normalized lowercase method', () => {
    // Normalize stores methods lowercase; patterns carry the uppercase spelling
    expect(matchesOperation(parseFilterPattern('DELETE /pets/*'), fixture[4]!)).toBe(true);
  });

  it('matches a methodPath pattern against the raw path template, braces included (D8)', () => {
    expect(matchesOperation(parseFilterPattern('GET /pets/{petId}'), fixture[1]!)).toBe(true);
  });

  it('matches a tag pattern if any tag matches', () => {
    expect(matchesOperation(parseFilterPattern('tag:admin'), fixture[3]!)).toBe(true);
    expect(matchesOperation(parseFilterPattern('tag:admin'), fixture[0]!)).toBe(false);
    expect(matchesOperation(parseFilterPattern('tag:p*'), fixture[0]!)).toBe(true);
  });

  it('matches nothing for an operation with no tags', () => {
    expect(matchesOperation(parseFilterPattern('tag:**'), record('get', '/x', 'x'))).toBe(false);
  });

  it('matches raw spec values, not sanitized tool names (D8)', () => {
    // AssignToolNames rewrites "list-pets!" to "list-pets_"; the filter must
    // still see the original, or a deny pattern would miss its target
    const op = record('get', '/pets', 'list-pets!');
    expect(named([op])[0]!.toolName).toBe('list-pets_');
    expect(matchesOperation(parseFilterPattern('list-pets!'), op)).toBe(true);
    expect(matchesOperation(parseFilterPattern('list*'), op)).toBe(true);
    expect(matchesOperation(parseFilterPattern('list-pets_'), op)).toBe(false);
  });
});

describe('closestMatch', () => {
  it('reproduces the suggestion documented in spec §8', () => {
    // Explicit candidate list rather than the fixture: §8's example only holds
    // when no nearer candidate exists, and stating it here keeps that visible
    expect(closestMatch('readPets', ['listPets', 'readPetById', 'deletePet'])).toBe('readPetById');
  });

  it('breaks an equal-distance tie by relative distance — this is what §8 turns on', () => {
    // "readPets" is 4 edits from BOTH "listPets" (4/8) and "readPetById"
    // (4/11). The distances tie, so the ratio decides, and it picks the longer,
    // more-shared candidate the spec documents. Without the tiebreak this would
    // return whichever came first and could contradict §8 — hence both orders.
    expect(closestMatch('readPets', ['listPets', 'readPetById'])).toBe('readPetById');
    expect(closestMatch('readPets', ['readPetById', 'listPets'])).toBe('readPetById');
  });

  it('still prefers a strictly nearer short candidate', () => {
    // "headPets" is 1 edit away; the ratio tiebreak must not overrule that
    expect(closestMatch('readPets', ['headPets', 'readPetById'])).toBe('headPets');
  });

  it('never prefers a strictly farther candidate, whatever the ratios say (round-8 finding 5)', () => {
    // The regression case that ratio-only ranking got wrong. "abcdeXYZ" is 3
    // edits (3/8 = 0.375); "abcdefghWXYZ" is 4 (4/12 = 0.333). Both clear the
    // admission bound, and ratio alone returns the distance-4 candidate —
    // contradicting the contract that a strictly nearer candidate wins. Both
    // orders, so a first-wins accident cannot make this pass.
    expect(closestMatch('abcdefgh', ['abcdeXYZ', 'abcdefghWXYZ'])).toBe('abcdeXYZ');
    expect(closestMatch('abcdefgh', ['abcdefghWXYZ', 'abcdeXYZ'])).toBe('abcdeXYZ');
  });

  it('picks the nearest of several candidates', () => {
    expect(closestMatch('creatPet', ['deletePet', 'createPet', 'listPets'])).toBe('createPet');
  });

  it('returns undefined when nothing is within the admission bound', () => {
    expect(closestMatch('zzzzzzzzzzzz', ['listPets', 'createPet'])).toBeUndefined();
  });

  it('returns undefined for an empty candidate list', () => {
    expect(closestMatch('readPets', [])).toBeUndefined();
  });

  it('returns undefined for an empty pattern', () => {
    expect(closestMatch('', ['listPets'])).toBeUndefined();
  });

  it('returns an exact candidate unchanged', () => {
    expect(closestMatch('listPets', ['listPets'])).toBe('listPets');
  });

  it('suggests for a short typo, where a proportional threshold alone would be too tight', () => {
    expect(closestMatch('gt', ['get', 'post'])).toBe('get');
  });

  it('is deterministic on ties — the first candidate in spec order wins', () => {
    expect(closestMatch('ab', ['ax', 'ay'])).toBe('ax');
    expect(closestMatch('ab', ['ay', 'ax'])).toBe('ay');
  });

  it('handles a methodPath candidate space', () => {
    expect(closestMatch('GET /pet', ['GET /pets', 'POST /pets'])).toBe('GET /pets');
  });

  it('stays fast on a large candidate list', () => {
    const candidates = Array.from({ length: 5000 }, (_, index) => `operation${index}`);
    const started = Date.now();
    expect(closestMatch('operation4999', candidates)).toBe('operation4999');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('applyFilters — precedence (spec §3.2)', () => {
  it('rule 3: with no allow, exposes only GET and HEAD', () => {
    const decision = applyFilters(named(fixture), [], []);
    expect(exposedIds(decision)).toEqual(['listPets', 'readPetById', 'headPets']);
  });

  it('rule 3: denied read operations are removed from the default', () => {
    const decision = applyFilters(named(fixture), [], patterns('read*'));
    expect(exposedIds(decision)).toEqual(['listPets', 'headPets']);
  });

  it('rule 2: an explicit allow replaces the default entirely, writes included', () => {
    const decision = applyFilters(named(fixture), patterns('tag:admin'), []);
    expect(exposedIds(decision)).toEqual(['createPet', 'deletePet', 'put_admin_config']);
  });

  it('rule 2: allow does not re-admit anything outside it', () => {
    const decision = applyFilters(named(fixture), patterns('listPets'), []);
    expect(exposedIds(decision)).toEqual(['listPets']);
  });

  it('rule 1: deny wins over an overlapping allow', () => {
    const decision = applyFilters(named(fixture), patterns('tag:pets'), patterns('DELETE /**'));
    expect(exposedIds(decision)).toEqual(['listPets', 'readPetById', 'headPets', 'createPet']);
  });

  it('rule 1: deny wins even when allow names the operation exactly', () => {
    const decision = applyFilters(named(fixture), patterns('deletePet'), patterns('deletePet'));
    expect(exposedIds(decision)).toEqual([]);
  });

  it('unions multiple allow patterns', () => {
    const decision = applyFilters(named(fixture), patterns('listPets', 'createPet'), []);
    expect(exposedIds(decision)).toEqual(['listPets', 'createPet']);
  });

  it('unions multiple deny patterns', () => {
    const decision = applyFilters(named(fixture), [], patterns('listPets', 'headPets'));
    expect(exposedIds(decision)).toEqual(['readPetById']);
  });

  it('preserves spec order in the exposed set', () => {
    const decision = applyFilters(named(fixture), patterns('**', 'tag:**', 'GET /**'), []);
    expect(exposedIds(decision).slice(0, 2)).toEqual(['listPets', 'readPetById']);
  });

  it('returns an empty set for an empty operation list', () => {
    expect(applyFilters([], [], []).exposed).toEqual([]);
  });

  it('exposes an operation with no operationId under a methodPath allow', () => {
    const decision = applyFilters(named(fixture), patterns('PUT /admin/**'), []);
    expect(exposedIds(decision)).toEqual(['put_admin_config']);
  });
});

describe('applyFilters — dead patterns (spec §8)', () => {
  it('reports an allow pattern that matches nothing, flagged and with a suggestion', () => {
    // "headPets" is 1 edit from "readPets" and "readPetById" is 4: the nearer
    // candidate wins, and that is correct even though §8 uses the other one
    // against a candidate list that does not contain "headPets"
    const decision = applyFilters(named(fixture), patterns('readPets'), []);
    expect(decision.deadPatterns).toEqual([
      { raw: 'readPets', flag: 'allow', suggestion: 'headPets' },
    ]);
  });

  it('reports a dead deny pattern with flag "deny"', () => {
    const decision = applyFilters(named(fixture), [], patterns('removeEverything'));
    expect(decision.deadPatterns).toEqual([{ raw: 'removeEverything', flag: 'deny' }]);
  });

  it('omits the suggestion when nothing is within the admission bound', () => {
    const decision = applyFilters(named(fixture), patterns('zzzzzzzzzzzzzz'), []);
    expect(decision.deadPatterns).toEqual([{ raw: 'zzzzzzzzzzzzzz', flag: 'allow' }]);
  });

  it('reports no dead patterns when every pattern matches', () => {
    const decision = applyFilters(named(fixture), patterns('tag:pets'), patterns('deletePet'));
    expect(decision.deadPatterns).toEqual([]);
  });

  it('suggests a METHOD + path candidate for a dead methodPath pattern', () => {
    const decision = applyFilters(named(fixture), patterns('GET /pet'), []);
    expect(decision.deadPatterns).toEqual([
      { raw: 'GET /pet', flag: 'allow', suggestion: 'GET /pets' },
    ]);
  });

  it('suggests a bare tag for a dead tag pattern, ignoring the "tag:" prefix', () => {
    const decision = applyFilters(named(fixture), patterns('tag:admins'), []);
    expect(decision.deadPatterns).toEqual([
      { raw: 'tag:admins', flag: 'allow', suggestion: 'admin' },
    ]);
  });

  it('does not suggest across candidate domains', () => {
    // "listPets" is an operationId, so a tag pattern must never propose it
    const decision = applyFilters(named(fixture), patterns('tag:listPets'), []);
    expect(decision.deadPatterns[0]?.suggestion).not.toBe('listPets');
  });

  it('measures deadness against the whole inventory, not the exposed set', () => {
    // §8 counts patterns matching zero operations in the spec: a deny that
    // removes everything an allow selected is doing its job, not misspelled
    const decision = applyFilters(named(fixture), patterns('deletePet'), patterns('deletePet'));
    expect(decision.deadPatterns).toEqual([]);
  });

  it('is not dead when the read-only default hides the matched operation', () => {
    const decision = applyFilters(named(fixture), [], patterns('createPet'));
    expect(decision.deadPatterns).toEqual([]);
  });

  it('reports allow patterns before deny patterns, each in argv order', () => {
    const decision = applyFilters(
      named(fixture),
      patterns('deadAllowOne', 'deadAllowTwo'),
      patterns('deadDenyOne'),
    );
    expect(decision.deadPatterns.map((dead) => `${dead.flag}:${dead.raw}`)).toEqual([
      'allow:deadAllowOne',
      'allow:deadAllowTwo',
      'deny:deadDenyOne',
    ]);
  });

  it('reports the same raw pattern once per flag it was supplied to', () => {
    const decision = applyFilters(named(fixture), patterns('noSuchThing'), patterns('noSuchThing'));
    expect(decision.deadPatterns.map((dead) => dead.flag)).toEqual(['allow', 'deny']);
  });

  it('reports every pattern as dead against an empty spec', () => {
    const decision = applyFilters([], patterns('anything'), patterns('tag:x'));
    expect(decision.deadPatterns).toEqual([
      { raw: 'anything', flag: 'allow' },
      { raw: 'tag:x', flag: 'deny' },
    ]);
  });
});

describe('applyFilters — aggregate work budget (D15 mechanism 2)', () => {
  it('shares one budget across exposure and dead-pattern detection', () => {
    // Not one budget per match: the reachable cost is the AGGREGATE, which is
    // what still measured 22.5 s at the maximum admitted dimensions even with a
    // non-backtracking matcher
    const budget = createMatchBudget();
    applyFilters(named(fixture), patterns('read*'), patterns('nothingLikeThis'), budget);
    expect(budget.remaining).toBeLessThan(FILTER_MAX_MATCH_STEPS);
  });

  it('spends a deterministic number of steps for a fixed input', () => {
    const spend = (): number => {
      const budget = createMatchBudget();
      applyFilters(named(fixture), patterns('read*'), [], budget);
      return FILTER_MAX_MATCH_STEPS - budget.remaining;
    };
    expect(new Set([spend(), spend(), spend()]).size).toBe(1);
  });

  it('fails closed with a validation error rather than running unbounded', () => {
    const budget = createMatchBudget(5);
    expect(() => applyFilters(named(fixture), patterns('*a*a*a*a*'), [], budget)).toThrowError(
      /work budget/u,
    );
  });

  it('stays far inside the budget for a realistic configuration', () => {
    // Measured for the realistic maximal case (256 patterns x 512 operations,
    // matching operationId, path and two tags each): 33,099,767 steps in 319 ms,
    // 16.5% of the cap, 6.0x headroom. This fixture is far smaller, so it must
    // be a rounding error against it.
    //
    // Round-8 cleanup: this comment previously said 5,618,160 steps and 11%,
    // which was the figure from BEFORE the round-4 recalibration — the count
    // that charged only some of the loops and left D15's own numbers
    // contradicting it. One measured figure, and D15 is where it is derived.
    const budget = createMatchBudget();
    applyFilters(named(fixture), patterns('**'), [], budget);
    expect(FILTER_MAX_MATCH_STEPS - budget.remaining).toBeLessThan(10_000);
  });
});
