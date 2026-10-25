import { selectedValues } from './engine.ts';
import type { DeadPatternFlag, FilterTarget } from './engine.ts';
import { validationError } from '../errors.ts';
import { FILTER_WORK_BUDGET_EXCEEDED_MESSAGE, globMatches } from './pattern.ts';
import type { FilterPattern, MatchBudget } from './pattern.ts';

// Selectors match regardless of case (issue #42), so a pattern can select
// operations whose operationIds, tool names, tags or paths differ only by
// case: `path:/orders/**` takes `/orders/{id}` and `/Orders/{id}` alike. That
// is reported, as the operator may have meant only one of them. Distinct
// spellings count, not operations that share one value.
export type CaseCollision = {
  raw: string;
  flag: DeadPatternFlag;
  // The spellings that are equal in lower case
  values: readonly string[];
  // `METHOD path` of the matching operations that carry them
  operations: readonly string[];
};

type Attribute = 'path' | 'operationId' | 'name' | 'tag';
type Variants = { lower: string; spellings: Map<string, FilterTarget[]> };

// The values of one attribute that the spec spells in more than one way.
// Only these can collide, so a pattern is matched against them alone, and a
// spec without such values costs nothing beyond this one pass.
const variantsOf = (
  attribute: Attribute,
  targets: readonly FilterTarget[],
  budget: MatchBudget,
): Variants[] => {
  const byLower = new Map<string, Map<string, FilterTarget[]>>();
  for (const target of targets) {
    for (const value of selectedValues(attribute, target)) {
      // Lowering reads the value once: charged like any matching step
      budget.remaining -= value.length;
      if (budget.remaining < 0) {
        throw validationError(FILTER_WORK_BUDGET_EXCEEDED_MESSAGE);
      }
      const spellings = byLower.get(value.toLowerCase()) ?? new Map<string, FilterTarget[]>();
      const carriers = spellings.get(value) ?? [];
      carriers.push(target);
      spellings.set(value, carriers);
      byLower.set(value.toLowerCase(), spellings);
    }
  }
  return [...byLower.entries()]
    .filter(([, spellings]) => spellings.size > 1)
    .map(([lower, spellings]) => ({ lower, spellings }));
};

export const caseCollisionsFor = (
  patterns: readonly FilterPattern[],
  flag: DeadPatternFlag,
  targets: readonly FilterTarget[],
  budget: MatchBudget,
): CaseCollision[] => {
  const cache = new Map<Attribute, Variants[]>();
  const variants = (attribute: Attribute): Variants[] => {
    const known = cache.get(attribute) ?? variantsOf(attribute, targets, budget);
    cache.set(attribute, known);
    return known;
  };
  return patterns.flatMap((pattern) => {
    if (pattern.kind === 'method') {
      return [];
    }
    const attribute = pattern.kind === 'route' ? 'path' : pattern.kind;
    return variants(attribute).flatMap((group) => {
      // Every spelling lowers to the same text, so the glob takes all or none
      if (!globMatches(pattern.compiled, group.lower, budget)) {
        return [];
      }
      const matched = [...group.spellings].flatMap(([value, carriers]) => {
        const kept = carriers.filter(
          (target) => pattern.kind !== 'route' || target.method.toUpperCase() === pattern.method,
        );
        return kept.length === 0 ? [] : [{ value, kept }];
      });
      if (matched.length < 2) {
        return [];
      }
      return [
        {
          raw: pattern.raw,
          flag,
          values: matched.map((entry) => entry.value),
          operations: [
            ...new Set(
              matched.flatMap((entry) =>
                entry.kept.map((target) => `${target.method.toUpperCase()} ${target.path}`),
              ),
            ),
          ],
        },
      ];
    });
  });
};
