import { assertKnownMethods, deadPatternsFor, matchesOperation } from '../filter/engine.ts';
import type { DeadPattern } from '../filter/engine.ts';
import { createMatchBudget } from '../filter/pattern.ts';
import type { FilterPattern, MatchBudget } from '../filter/pattern.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import type { GeneratedTool } from './build.ts';

export type OutputSchemaOptOut = {
  tools: readonly GeneratedTool[];
  deadPatterns: readonly DeadPattern[];
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
// so a method neither standard nor declared in the spec's `inventory` is a
// usage error here too. A pattern is dead when it matches no generated tool:
// it runs after the filters and toolgen, so an operation they leave out (a
// filtered or unrepresentable one) cannot be named.
export const applyOutputSchemaOptOut = (
  tools: readonly GeneratedTool[],
  patterns: readonly FilterPattern[],
  inventory: readonly OperationRecord[],
  budget: MatchBudget = createMatchBudget(),
): OutputSchemaOptOut => {
  if (patterns.length === 0) {
    return { tools, deadPatterns: [] };
  }
  assertKnownMethods(patterns, inventory);
  const optedOut = tools.map((tool) =>
    patterns.some((pattern) => matchesOperation(pattern, tool.operation, budget))
      ? withoutOutputSchema(tool)
      : tool,
  );
  // Every pattern is checked on its own, so one that overlaps an earlier
  // match is not reported dead
  const records = tools.map((tool) => tool.operation);
  const deadPatterns = deadPatternsFor(patterns, 'omit-output-schema', records, budget);
  return { tools: optedOut, deadPatterns };
};
