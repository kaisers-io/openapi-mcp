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
  multiApiSearchInputSchema,
  SEARCH_INPUT_SCHEMA,
  SEARCH_OUTPUT_SCHEMA,
} from './discovery-schemas.ts';
import type { DescribeInput } from './discovery-schemas.ts';
import type { OperationEntry, SnapshotTool, ToolMode, WireTool } from './types.ts';
import { outputFieldsOf } from './output-fields.ts';
import { presentedOutputSchema } from './wire-tools.ts';
import type { OutputSchemaForm } from './wire-tools.ts';
import { withEffect } from './effect.ts';

// Discovery tool mode (issue kaisers-io/openapi-mcp-archive#38): instead of one
// MCP tool per operation, tools/list carries three package-authored tools that
// find, describe and call the exposed operations. tools/list then stays a few
// KB whatever the operation count, at the cost of one or two extra tool calls
// per task — the progressive-disclosure pattern behind model-provider tool
// search, Speakeasy's dynamic toolsets and Stainless' `--tools=dynamic`.
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

// `--tool-mode auto` also switches to discover when the tool definitions a
// model sees (name, description and input schema; hosts keep the output
// schema from the model) take more bytes than this. Measured over 194
// public specs (issue #61): a median definition takes 646 bytes, so 64
// operations take about 40 KB, and 20 of 278 configurations with at most 64
// operations took more, up to 439 KB. A guard against outliers derived from
// the operation threshold, not a measured optimum.
export const AUTO_DISCOVER_DEFINITION_BYTES = 40_000;

type DefinedTool = { toolName: string; description: string; wireSchema: unknown };

// The UTF-8 bytes of the definitions a model sees for these tools
export const definitionBytes = (tools: readonly DefinedTool[]): number =>
  tools.reduce(
    (sum, tool) =>
      sum +
      Buffer.byteLength(
        JSON.stringify({
          name: tool.toolName,
          description: tool.description,
          inputSchema: tool.wireSchema,
        }),
      ),
    0,
  );

export type ToolModeChoice = { toolMode: ToolMode; reason?: 'count' | 'size' };

// `sizeOf` is only called for auto at or below the operation threshold
export const chooseToolMode = (
  requested: RequestedToolMode,
  exposedCount: number,
  sizeOf: () => number,
): ToolModeChoice => {
  if (requested !== 'auto') {
    return { toolMode: requested };
  }
  if (exposedCount > AUTO_DISCOVER_THRESHOLD) {
    return { toolMode: 'discover', reason: 'count' };
  }
  return sizeOf() > AUTO_DISCOVER_DEFINITION_BYTES
    ? { toolMode: 'discover', reason: 'size' }
    : { toolMode: 'per-operation' };
};

export const resolveToolMode = (requested: RequestedToolMode, exposedCount: number): ToolMode =>
  chooseToolMode(requested, exposedCount, () => 0).toolMode;

// Startup warning: under discover, a host that approves per
// tool sees ONE approval surface, call_operation, for every exposed
// operation. "Always allow call_operation" then also allows every write the
// filters expose. Undefined when every exposed operation is read-only (the
// default filter) or the mode is per-operation, where each tool is approved
// on its own. Names are spec-derived, so they are sanitized and capped.
const APPROVAL_WARNING_NAMES = 3;

export const discoverApprovalWarning = (
  toolMode: ToolMode,
  operations: readonly OperationEntry[],
): string | undefined => {
  if (toolMode !== 'discover') {
    return undefined;
  }
  const writes = operations.filter((entry) => entry.annotations.readOnlyHint !== true);
  if (writes.length === 0) {
    return undefined;
  }
  const named = writes
    .slice(0, APPROVAL_WARNING_NAMES)
    .map((tool) => sanitizeSpecText(tool.name, REFLECTED_NAME_MAX))
    .join(', ');
  const more = writes.length > APPROVAL_WARNING_NAMES ? ', ...' : '';
  return `--tool-mode discover exposes ${String(writes.length)} non-read-only operation(s) (${named}${more}) through the single call_operation tool: a host approval of call_operation covers all of them, writes included. Narrow --allow to read-only operations, or use --tool-mode per-operation to approve each operation separately`;
};

// The call_operation tool stands for every exposed operation, so it cannot
// carry one operation's hints. It reports the least safe combination among
// them: read-only only when EVERY exposed operation is (the default
// read-only filter makes that the common case), destructive when ANY is,
// idempotent only when all are. Hints stay advisory (toolgen/annotations.ts);
// the filters are the enforcement. A host that gates approval per tool sees
// one approval surface for every operation in this mode, as
// docs/configuration.md states.
const callAnnotations = (operations: readonly OperationEntry[]): Record<string, unknown> => {
  const hints = operations.map((entry) => entry.annotations);
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
const searchSchemaFor = (apiNames?: readonly [string, ...string[]]): z.ZodType =>
  apiNames === undefined ? SEARCH_INPUT_SCHEMA : multiApiSearchInputSchema(apiNames);

// `apiNames`: several APIs behind one server (issue #16), so a search can
// name one of them
export const buildDiscoveryTools = (
  operations: readonly OperationEntry[],
  apiNames?: readonly [string, ...string[]],
): SnapshotTool[] => [
  discoveryTool(SEARCH_TOOL_NAME, 'search', searchSchemaFor(apiNames), {
    description:
      apiNames === undefined
        ? "Search this API's operations by keyword. Returns operation names (best match first) to pass to describe_operation and call_operation. Only operations this server exposes are searchable."
        : "Search the operations of this server's APIs by keyword. Returns operation names, each starting with its API's name (best match first), to pass to describe_operation and call_operation. Only operations this server exposes are searchable.",
    inputSchema: z.toJSONSchema(searchSchemaFor(apiNames)),
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    // Reads the in-memory index only; it never reaches the API.
    annotations: { readOnlyHint: true, openWorldHint: false },
  }),
  discoveryTool(DESCRIBE_TOOL_NAME, 'describe', DESCRIBE_INPUT_SCHEMA, {
    description:
      "Return one operation's definition: description, inputSchema (the shape of call_operation's `arguments`), annotations and, if include_output_schema is true, outputSchema. An operation that accepts `_fields` lists its result fields as `<pointer>: <type>` in outputFields.",
    inputSchema: z.toJSONSchema(DESCRIBE_INPUT_SCHEMA),
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
  withEffect(
    textOutcome(
      `unknown operation "${sanitizeSpecText(name, REFLECTED_NAME_MAX)}" — use search_operations to find an operation name`,
      true,
    ),
    'not_sent',
  );

export const lookupOperation = (
  operationsByName: Readonly<Record<string, OperationEntry | undefined>>,
  name: string,
): OperationEntry | undefined =>
  Object.hasOwn(operationsByName, name) ? operationsByName[name] : undefined;

// The whole tool of an exposed operation, or a tool error when its output
// side could not be built (issue #47). Nothing is sent in that case.
export const resolveOperation = (
  operationsByName: Readonly<Record<string, OperationEntry | undefined>>,
  name: string,
): { tool: SnapshotTool } | { outcome: ToolCallOutcome } => {
  const entry = lookupOperation(operationsByName, name);
  if (entry === undefined) {
    return { outcome: unknownOperationOutcome(name) };
  }
  try {
    return { tool: entry.resolve() };
  } catch {
    return {
      outcome: withEffect(
        textOutcome(
          `operation "${sanitizeSpecText(name, REFLECTED_NAME_MAX)}" is unavailable: its definition could not be built`,
          true,
        ),
        'not_sent',
      ),
    };
  }
};

const INLINE_FORM: OutputSchemaForm = { compact: false, descriptions: true };

// Returns the wire tool the per-operation mode lists for this operation (the
// same sanitized description, schemas and annotations), with its
// outputSchema only when asked for (see below).
// `data` was already validated against DESCRIBE_INPUT_SCHEMA.
export const describeOperation = (
  operationsByName: Readonly<Record<string, OperationEntry | undefined>>,
  data: unknown,
  form: OutputSchemaForm = INLINE_FORM,
): ToolCallOutcome => {
  const { name, include_output_schema: requested } = data as DescribeInput;
  const resolved = resolveOperation(operationsByName, name);
  if ('outcome' in resolved) {
    return resolved.outcome;
  }
  const { tool } = resolved;
  // Output schemas are most of the definitions (79% of the per-operation
  // tools/list for the GitHub REST description), and calling needs only the
  // inputSchema: the server validates the result either way (issue #9).
  const { outputSchema, ...definition } = tool.wireTool;
  // An operation that accepts `_fields` lists its result fields instead
  // (issue #49): the paths for `_fields` at a few percent of the schema.
  const listFields = requested === undefined && tool.generated?.projection === true;
  let payload: Record<string, unknown> = definition;
  if (outputSchema !== undefined) {
    payload =
      requested === true
        ? { ...definition, outputSchema: presentedOutputSchema(outputSchema, form) }
        : {
            ...definition,
            outputSchemaOmitted: true,
            ...(listFields ? { outputFields: outputFieldsOf(outputSchema) } : {}),
          };
  }
  return structuredOutcome(JSON.stringify(payload), payload);
};
