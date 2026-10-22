import { z } from 'zod';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import { structuredOutcome, textOutcome } from './result.ts';
import type { ToolCallOutcome } from './result.ts';
import {
  CALL_INPUT_SCHEMA,
  CALL_WIRE_INPUT_SCHEMA,
  DESCRIBE_INPUT_SCHEMA,
  DESCRIBE_OUTPUT_SCHEMA,
  REFLECTED_NAME_MAX,
  SEARCH_INPUT_SCHEMA,
  SEARCH_OUTPUT_SCHEMA,
} from './discovery-schemas.ts';
import type { DescribeInput } from './discovery-schemas.ts';
import type { SnapshotTool, ToolMode, WireTool } from './types.ts';

// Discovery tool mode (issue #38): instead of one MCP tool per operation,
// tools/list carries three package-authored tools that find, describe and call
// the exposed operations. tools/list then stays a few KB whatever the
// operation count, at the cost of one or two extra tool calls per task — the
// progressive-disclosure pattern behind model-provider tool search, Speakeasy's
// dynamic toolsets and Stainless' `--tools=dynamic`.
//
// Nothing in this module is a second policy path. The operations it sees are
// exactly the snapshot's exposed (post-filter) set, and call_operation runs
// the target through the dispatcher's own validation and executor
// (dispatch.ts) — never through anything defined here.

export const SEARCH_TOOL_NAME = 'search_operations';
export const DESCRIBE_TOOL_NAME = 'describe_operation';
export const CALL_TOOL_NAME = 'call_operation';

export type DiscoveryToolName = 'search' | 'describe' | 'call';

// `--tool-mode auto` switches to discover above this many exposed operations.
// A fixed constant, not a setting: published tool search guidance reports
// tool-selection accuracy degrading past 30–50 tools, and Stainless enables
// its dynamic mode by default above 50 endpoints. 64 sits just above both, so
// small and medium APIs keep their direct tools.
export const AUTO_DISCOVER_THRESHOLD = 64;

export const TOOL_MODES = ['per-operation', 'discover', 'auto'] as const;
export type RequestedToolMode = (typeof TOOL_MODES)[number];

export const resolveToolMode = (requested: RequestedToolMode, exposedCount: number): ToolMode => {
  if (requested === 'auto') {
    return exposedCount > AUTO_DISCOVER_THRESHOLD ? 'discover' : 'per-operation';
  }
  return requested;
};

// The call_operation tool stands for every exposed operation, so it cannot
// carry one operation's hints. It reports the least safe combination among
// them: read-only only when EVERY exposed operation is (the default
// read-only filter makes that the common case), destructive when ANY is,
// idempotent only when all are. Hints stay advisory (toolgen/annotations.ts);
// the filters are the enforcement. A host that gates approval per tool sees
// one approval surface for every operation in this mode, as
// docs/configuration.md states.
const callAnnotations = (operations: readonly SnapshotTool[]): Record<string, unknown> => {
  const hints = operations.map((tool) => tool.generated?.annotations ?? {});
  if (hints.every((hint) => hint.readOnlyHint === true)) {
    return { readOnlyHint: true, openWorldHint: true };
  }
  return {
    readOnlyHint: false,
    destructiveHint: hints.some((hint) => hint.destructiveHint === true),
    idempotentHint: hints.every(
      (hint) => hint.readOnlyHint === true || hint.idempotentHint === true,
    ),
    openWorldHint: true,
  };
};

const discoveryTool = (
  name: string,
  discovery: DiscoveryToolName,
  inputSchema: z.ZodType,
  wireTool: Omit<WireTool, 'name'>,
): SnapshotTool => ({
  kind: 'discovery',
  name,
  discovery,
  inputSchema,
  wireTool: { name, ...wireTool },
});

// Package-authored, static text: no description below interpolates anything
// from the spec (the same rule as the server instructions in protocol.ts).
// Only call_operation's annotations depend on the exposed set.
export const buildDiscoveryTools = (operations: readonly SnapshotTool[]): SnapshotTool[] => [
  discoveryTool(SEARCH_TOOL_NAME, 'search', SEARCH_INPUT_SCHEMA, {
    description:
      "Search this API's operations by keyword. Returns operation names (best match first) to pass to describe_operation and call_operation. Only operations this server exposes are searchable.",
    inputSchema: z.toJSONSchema(SEARCH_INPUT_SCHEMA) as Record<string, unknown>,
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    // Reads the in-memory index only; it never reaches the API.
    annotations: { readOnlyHint: true, openWorldHint: false },
  }),
  discoveryTool(DESCRIBE_TOOL_NAME, 'describe', DESCRIBE_INPUT_SCHEMA, {
    description:
      "Return one operation's full definition: its description, inputSchema (the shape of call_operation's `arguments`), outputSchema and annotations.",
    inputSchema: z.toJSONSchema(DESCRIBE_INPUT_SCHEMA) as Record<string, unknown>,
    outputSchema: DESCRIBE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }),
  discoveryTool(CALL_TOOL_NAME, 'call', CALL_INPUT_SCHEMA, {
    description:
      "Call one operation by name. `arguments` must match the inputSchema describe_operation returns; it is validated exactly as a direct tool call would be, and the result is that operation's result.",
    inputSchema: CALL_WIRE_INPUT_SCHEMA,
    annotations: callAnnotations(operations),
  }),
];

// A tool execution error (isError), not a protocol error: the model named an
// operation that is not exposed, and can recover by searching. The name is
// caller-supplied, so it is sanitized and capped before it is reflected.
export const unknownOperationOutcome = (name: string): ToolCallOutcome =>
  textOutcome(
    `unknown operation "${sanitizeSpecText(name, REFLECTED_NAME_MAX)}" — use search_operations to find an operation name`,
    true,
  );

export const lookupOperation = (
  operationsByName: Readonly<Record<string, SnapshotTool | undefined>>,
  name: string,
): SnapshotTool | undefined =>
  Object.hasOwn(operationsByName, name) ? operationsByName[name] : undefined;

// Returns exactly the wire tool the per-operation mode lists for this
// operation: the same sanitized description, schemas and annotations.
// `data` was already validated against DESCRIBE_INPUT_SCHEMA.
export const describeOperation = (
  operationsByName: Readonly<Record<string, SnapshotTool | undefined>>,
  data: unknown,
): ToolCallOutcome => {
  const { name } = data as DescribeInput;
  const tool = lookupOperation(operationsByName, name);
  if (tool === undefined) {
    return unknownOperationOutcome(name);
  }
  const payload: Record<string, unknown> = { ...tool.wireTool };
  return structuredOutcome(JSON.stringify(payload), payload);
};
