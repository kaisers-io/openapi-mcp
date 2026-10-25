import type { CallRequest, DispatcherDeps } from './dispatch.ts';
import { describeOperation, lookupOperation, unknownOperationOutcome } from './discovery.ts';
import { executeWithEffect } from './effect.ts';
import type { CallInput } from './discovery-schemas.ts';
import { textOutcome } from './result.ts';
import type { ToolCallOutcome } from './result.ts';
import { searchOperations } from './search-index.ts';
import type { CallTelemetry } from './telemetry.ts';
import type { SnapshotTool } from './types.ts';
import { validateAndExecute } from './validation.ts';

// Routing for the three discover-mode tools
// (kaisers-io/openapi-mcp-archive#38), split out of dispatch.ts.

// The call_operation path: resolve the target among the snapshot's EXPOSED
// operations only (an operation a filter excluded was never built, so it is
// unknown here exactly as it is to a direct call), then run the target
// through the same validate-then-execute tail as a direct call of that tool.
// The rate limit was already charged once for this call_operation call by
// createDispatcher.call and is not charged again; the dispatch-boundary
// redaction runs once, on the outcome returned from there.
const callOperation = (
  deps: DispatcherDeps,
  data: unknown,
  { signal, trace, report }: CallRequest,
): Promise<ToolCallOutcome> => {
  const input = data as CallInput;
  const target = lookupOperation(deps.snapshot.operationsByName, input.name);
  if (target === undefined) {
    return Promise.resolve(unknownOperationOutcome(input.name));
  }
  // The call record names the operation that ran, not `call_operation`.
  const reportTarget =
    report === undefined
      ? undefined
      : (telemetry: CallTelemetry): void => {
          report({ ...telemetry, tool: target.name });
        };
  return validateAndExecute(target, input.arguments, (targetData) =>
    executeWithEffect(target, () => deps.executor(target, targetData, signal, trace, reportTarget)),
  );
};

export const runDiscoveryTool = (
  deps: DispatcherDeps,
  tool: SnapshotTool,
  data: unknown,
  request: CallRequest,
): Promise<ToolCallOutcome> => {
  switch (tool.discovery) {
    case 'search': {
      return deps.snapshot.searchIndex === undefined
        ? Promise.resolve(textOutcome('tool execution failed unexpectedly', true))
        : Promise.resolve(searchOperations(deps.snapshot.searchIndex, data));
    }
    case 'describe': {
      return Promise.resolve(
        describeOperation(
          deps.snapshot.operationsByName,
          data,
          deps.snapshot.compactOutputSchemas === true,
        ),
      );
    }
    case 'call': {
      return callOperation(deps, data, request);
    }
    default: {
      return Promise.resolve(textOutcome('tool execution failed unexpectedly', true));
    }
  }
};
