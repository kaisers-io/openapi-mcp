import { validationError } from '../errors.ts';
import { completeTools } from '../toolgen/build.ts';
import type {
  BuildToolsResult,
  DeferredTool,
  DeferredToolsResult,
  GeneratedTool,
} from '../toolgen/build.ts';
import { createConvertMemo, withConvertMemo } from '../toolgen/schema.ts';
import type { ConvertMemo } from '../toolgen/schema.ts';
import { deepFreeze } from '../freeze.ts';
import type { OperationEntry, SnapshotTool, ToolMode, WireTool } from './types.ts';
import { presentedOutputSchema, runtimeOperationOf, runtimeToolOf, titleOf } from './wire-tools.ts';
import type { OutputSchemaForm } from './wire-tools.ts';

// The schema as built; describe_operation presents its own form on demand
const INLINE: OutputSchemaForm = { compact: false, descriptions: true };

// The snapshot's entries for exposed operations (see OperationEntry).

type Facts = Omit<OperationEntry, 'resolve'>;

const factsOf = (tool: Omit<DeferredTool, 'complete'>): Facts => ({
  name: tool.toolName,
  operation: runtimeOperationOf(tool.operation),
  inputSchema: tool.wireSchema,
  annotations: tool.annotations,
  ...(tool.projection === true ? { projection: true as const } : {}),
});

export const resolvedEntry = (generated: GeneratedTool, tool: SnapshotTool): OperationEntry => ({
  ...factsOf(generated),
  resolve: () => tool,
});

// Builds the output side on the first `resolve` and keeps the outcome, a
// tool or an error, so a failure is reported once and repeats unchanged.
// What completion reads is frozen now, so a later change by the caller
// cannot alter it; it is released once the tool is built.
export const deferredEntry = (
  deferred: DeferredTool,
  toTool: (generated: GeneratedTool) => SnapshotTool,
  shared: { memo: ConvertMemo; seen: WeakSet<object> },
  onError?: (toolName: string, error: unknown) => void,
): OperationEntry => {
  const name = deferred.toolName;
  const { memo } = shared;
  let source: DeferredTool | undefined = deepFreeze(deferred, shared.seen);
  let settled: { tool: SnapshotTool } | { error: unknown } | undefined;
  return {
    ...factsOf(deferred),
    resolve: () => {
      if (settled === undefined) {
        const pending = source as DeferredTool;
        source = undefined;
        try {
          // The snapshot's memo: a schema shared by several operations
          // converts once, as in an eager build
          settled = { tool: deepFreeze(toTool(withConvertMemo(() => pending.complete(), memo))) };
        } catch (error) {
          settled = { error };
          onError?.(name, error);
        }
      }
      if ('error' in settled) {
        throw settled.error;
      }
      return settled.tool;
    },
  };
};

const wireToolOf = (generated: GeneratedTool, form: OutputSchemaForm): WireTool => {
  const title = titleOf(generated);
  return {
    name: generated.toolName,
    ...(title === undefined ? {} : { title }),
    description: generated.description,
    inputSchema: generated.wireSchema,
    ...(generated.outputSchema === undefined
      ? {}
      : { outputSchema: presentedOutputSchema(generated.outputSchema, form) }),
    annotations: generated.annotations,
  };
};

export const assertObjectRoot = (
  toolName: string,
  field: string,
  schema: Record<string, unknown>,
): void => {
  if (schema['type'] !== 'object') {
    throw validationError(
      `tool "${toolName}" ${field} is not object-rooted (MCP requires type:"object" at the root)`,
    );
  }
};

const isDeferred = (built: BuildToolsResult | DeferredToolsResult): built is DeferredToolsResult =>
  built.tools.some((tool) => 'complete' in tool);

// One operation as a tool, with its schemas checked
const snapshotToolOf = (generated: GeneratedTool, form: OutputSchemaForm): SnapshotTool => {
  const tool: SnapshotTool = {
    kind: 'upstream',
    name: generated.toolName,
    wireTool: wireToolOf(generated, form),
    inputSchema: generated.inputSchema,
    generated: runtimeToolOf(generated),
  };
  assertObjectRoot(tool.name, 'inputSchema', tool.wireTool.inputSchema);
  if (tool.wireTool.outputSchema !== undefined) {
    assertObjectRoot(tool.name, 'outputSchema', tool.wireTool.outputSchema);
  }
  return tool;
};

// Under `discover` with deferred tools, each operation's output side is
// built on first use (issue #47); otherwise every tool is complete now.
export const entriesOf = (
  built: BuildToolsResult | DeferredToolsResult,
  toolMode: ToolMode,
  options: {
    compactOutputSchemas?: boolean;
    bareOutputSchemas?: boolean;
    onDeferredError?: (toolName: string, error: unknown) => void;
  },
): { entries: OperationEntry[]; tools: SnapshotTool[] } => {
  if (toolMode === 'discover' && isDeferred(built)) {
    // Describe_operation presents a compact schema itself
    const toTool = (generated: GeneratedTool): SnapshotTool => snapshotToolOf(generated, INLINE);
    // One memo for every first use, and one freeze walk at startup
    const shared = { memo: createConvertMemo(), seen: new WeakSet<object>() };
    return {
      entries: built.tools.map((tool) => {
        assertObjectRoot(tool.toolName, 'inputSchema', tool.wireSchema);
        return deferredEntry(tool, toTool, shared, options.onDeferredError);
      }),
      tools: [],
    };
  }
  const complete = isDeferred(built) ? completeTools(built) : built;
  const listed = toolMode === 'per-operation';
  const form = {
    compact: listed && options.compactOutputSchemas === true,
    descriptions: !listed || options.bareOutputSchemas !== true,
  };
  const tools = complete.tools.map((generated) => snapshotToolOf(generated, form));
  return {
    entries: complete.tools.map((generated, index) =>
      resolvedEntry(generated, tools[index] as SnapshotTool),
    ),
    tools,
  };
};

// Null-prototype: tool names are sanitized identifiers already, but a null
// prototype is the safe default regardless — `__proto__`/`constructor` are
// just ordinary own keys here, never a prototype-pollution vector, and
// `Object.hasOwn` never needs to distinguish an own key from an inherited one.
// Imperative on purpose: this is validate-then-write, not a plain
// accumulation — `Object.fromEntries`/`reduce` would either silently let a
// later duplicate name overwrite an earlier tool (losing the throw entirely)
// or need the same hasOwn-then-throw check re-embedded in a reducer callback
// for no readability gain over the loop below.
export const indexByName = <Named extends { readonly name: string }>(
  tools: readonly Named[],
): Record<string, Named | undefined> => {
  const byName = Object.create(null) as Record<string, Named | undefined>;
  for (const tool of tools) {
    if (Object.hasOwn(byName, tool.name)) {
      throw validationError(`duplicate tool name "${tool.name}" in the server snapshot`);
    }
    byName[tool.name] = tool;
  }
  return byName;
};
