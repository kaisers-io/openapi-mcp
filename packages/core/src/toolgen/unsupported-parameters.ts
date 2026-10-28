import {
  assertKnownMethods,
  deadPatternsWithOmitted,
  omittedTargets,
  targetOf,
} from '../filter/apply.ts';
import { caseCollisionsFor } from '../filter/case-collisions.ts';
import type { CaseCollision } from '../filter/case-collisions.ts';
import { matchesOperation } from '../filter/engine.ts';
import type { DeadPattern } from '../filter/engine.ts';
import { createMatchBudget } from '../filter/pattern.ts';
import type { FilterPattern, MatchBudget } from '../filter/pattern.ts';
import type { NormalizedSpec } from '../spec/normalize.ts';
import type { NamedOperation } from './naming.ts';
import { assignToolNames } from './naming.ts';

export type UnsupportedParameterOptIn = {
  // The tool names whose optional parameters this server cannot send are
  // left out instead of omitting the operation
  toolNames: ReadonlySet<string>;
  // The tool names each pattern matches, so a pattern that leaves nothing
  // out can be reported as changing nothing
  matches: readonly { raw: string; toolNames: readonly string[] }[];
  deadPatterns: readonly DeadPattern[];
  caseCollisions: readonly CaseCollision[];
};

// --omit-unsupported-parameters (issue #67): the exposed operations the
// operator opted in, by the --allow/--deny grammar. Leaving out a parameter
// can take a filter or a dry run away from the agent, so it is never the
// default. Matched before the tools are built, on the operations the filters
// expose: a pattern that names none of them is dead.
export const selectUnsupportedParameterOptIn = (
  named: readonly NamedOperation[],
  patterns: readonly FilterPattern[],
  spec: Pick<NormalizedSpec, 'operations' | 'omitted'>,
  budget: MatchBudget = createMatchBudget(),
): UnsupportedParameterOptIn => {
  if (patterns.length === 0) {
    return { toolNames: new Set(), matches: [], deadPatterns: [], caseCollisions: [] };
  }
  const omitted = omittedTargets(spec.omitted);
  assertKnownMethods(patterns, [...spec.operations, ...omitted]);
  const inventory = assignToolNames(spec.operations).map((entry) => targetOf(entry));
  const targets = named.map((entry) => targetOf(entry));
  const matches = patterns.map((pattern) => ({
    raw: pattern.raw,
    toolNames: named
      .filter((_entry, index) => {
        const target = targets[index];
        return target !== undefined && matchesOperation(pattern, target, budget);
      })
      .map((entry) => entry.toolName),
  }));
  return {
    toolNames: new Set(matches.flatMap((match) => match.toolNames)),
    matches,
    deadPatterns: deadPatternsWithOmitted(
      patterns,
      'omit-unsupported-parameters',
      targets,
      [...inventory, ...omitted],
      budget,
    ),
    caseCollisions: caseCollisionsFor(patterns, 'omit-unsupported-parameters', targets, budget),
  };
};
