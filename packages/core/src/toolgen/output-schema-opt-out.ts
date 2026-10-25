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
import type { GeneratedTool } from './build.ts';
import { assignToolNames } from './naming.ts';

export type OutputSchemaOptOut = {
  tools: readonly GeneratedTool[];
  deadPatterns: readonly DeadPattern[];
  // Patterns that match only tools without an output schema, so they change
  // nothing (review of #13). Not dead: the tools exist.
  ineffectivePatterns: readonly string[];
  caseCollisions: readonly CaseCollision[];
};

// The derived output schema and the markers that describe it go; the
// description stays, so it does not depend on the opt-out
const withoutOutputSchema = (tool: GeneratedTool): GeneratedTool => {
  if (tool.outputSchema === undefined) {
    return tool;
  }
  const {
    outputSchema: _outputSchema,
    outputSchemaAdmitsNullFields: _admitsNullFields,
    outputSchemaAssumesDefaultIsError: _assumesDefaultIsError,
    ...rest
  } = tool;
  return { ...rest, outputSchemaOptedOut: true };
};

// --omit-output-schema (issue #13): the generated tools whose output schema
// the operator opted out of, for an API whose responses do not match its
// spec. Without one their results are returned as text, like a tool whose
// responses cannot be described. The patterns use the --allow/--deny grammar,
// so a method neither standard nor declared in the spec is a usage error
// here too. A pattern is dead when it matches no generated tool:
// it runs after the filters and toolgen, so an operation they leave out (a
// filtered or unrepresentable one) cannot be named.
export const applyOutputSchemaOptOut = (
  tools: readonly GeneratedTool[],
  patterns: readonly FilterPattern[],
  spec: Pick<NormalizedSpec, 'operations' | 'omitted'>,
  budget: MatchBudget = createMatchBudget(),
): OutputSchemaOptOut => {
  if (patterns.length === 0) {
    return { tools, deadPatterns: [], ineffectivePatterns: [], caseCollisions: [] };
  }
  // A method is also declared by an operation normalization omitted (an
  // OpenAPI 3.2 `SEARCH` with a `servers` override, say), so naming it is a
  // dead pattern below rather than a usage error
  const omitted = omittedTargets(spec.omitted);
  assertKnownMethods(patterns, [...spec.operations, ...omitted]);
  // Tool names are assigned on the whole inventory, as the pipeline does
  const inventory = assignToolNames(spec.operations).map((named) => targetOf(named));
  const targets = tools.map((tool) =>
    targetOf({ operation: tool.operation, toolName: tool.toolName }),
  );
  const optedOut = tools.map((tool, index) => {
    const target = targets[index];
    return target !== undefined &&
      patterns.some((pattern) => matchesOperation(pattern, target, budget))
      ? withoutOutputSchema(tool)
      : tool;
  });
  // Every pattern is checked on its own, so one that overlaps an earlier
  // match is not reported dead. A pattern naming an operation that is not
  // exposed (filtered out, or omitted with its provenance) gets that reason
  // instead of a suggestion, which would point at an unrelated tool.
  const deadPatterns = deadPatternsWithOmitted(
    patterns,
    'omit-output-schema',
    targets,
    [...inventory, ...omitted],
    budget,
  );
  const ineffectivePatterns = patterns
    .filter((pattern) => {
      const matched = tools.filter((_tool, index) => {
        const target = targets[index];
        return target !== undefined && matchesOperation(pattern, target, budget);
      });
      return matched.length > 0 && matched.every((tool) => tool.outputSchema === undefined);
    })
    .map((pattern) => pattern.raw);
  const caseCollisions = caseCollisionsFor(patterns, 'omit-output-schema', targets, budget);
  return { tools: optedOut, deadPatterns, ineffectivePatterns, caseCollisions };
};
