import { z } from 'zod';
import { validationError } from '../errors.ts';
import type { DeadPattern } from '../filter/engine.ts';
import type { OmittedOperation } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { BuildToolsResult, GeneratedTool } from '../toolgen/build.ts';
import {
  byToolName,
  META_INPUT_SCHEMA,
  META_TOOL_NAME,
  metaWireTool,
  OMITTED_REASONS_CAP,
  presentedOutputSchema,
  titleOf,
} from './wire-tools.ts';
import { buildDiscoveryTools } from './discovery.ts';
import { buildSearchIndex } from './search-index.ts';
import type { MetaSummary, ServerSnapshot, SnapshotTool, ToolMode, WireTool } from './types.ts';

export { META_TOOL_NAME } from './wire-tools.ts';

// Same display-string bound the `tools` CLI command uses for a spec-derived
// path/reason (packages/cli/src/commands/tools.ts's PATH_DISPLAY_MAX) — kept
// as a plain local constant here rather than a shared export because the two
// call sites (CLI human-readable rows vs. the in-process meta tool payload)
// have no other coupling and shouldn't be forced to share a module for one
// number. `omitted[].path` is always raw spec text (a literal path key from
// the document); `omitted[].reason` CAN also embed raw spec text (e.g. an
// unrepresentable parameter's own name, per layout.ts/schema.ts) even though
// most reason strings are package-authored constants — sanitize both
// unconditionally rather than trying to distinguish the two cases.
const PATH_DISPLAY_MAX = 512;

const sanitizeOmission = (omission: OmittedOperation): OmittedOperation => ({
  method: omission.method,
  path: sanitizeSpecText(omission.path, PATH_DISPLAY_MAX),
  reason: sanitizeSpecText(omission.reason, PATH_DISPLAY_MAX),
});

const wireToolOf = (generated: GeneratedTool, compact: boolean): WireTool => {
  const title = titleOf(generated);
  return {
    name: generated.toolName,
    ...(title === undefined ? {} : { title }),
    description: generated.description,
    inputSchema: generated.wireSchema,
    ...(generated.outputSchema === undefined
      ? {}
      : { outputSchema: presentedOutputSchema(generated.outputSchema, compact) }),
    annotations: generated.annotations,
  };
};

const assertObjectRoot = (
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

// The subset of SpecPipelineResult the meta summary needs — deliberately
// narrower than the full result (no `namedOperations`, no `cacheStatus`, and
// crucially NO `candidateContentHash`): the meta tool reports the ACCEPTED
// baseline only — there is no runtime refresh or candidate-spec field to
// report — so the type itself makes threading a candidate hash through a
// mistake the compiler catches, not just a convention. `spec.omitted` is
// normalizeSpec's OWN omission source (cookie parameters, OPTIONS/TRACE,
// webhooks, path-level `servers` overrides, ...) — a DIFFERENT stage from
// `built.omitted` (buildTools' toolgen-level omissions: unrepresentable
// schemas, reserved-header conflicts). Both are real, distinct "why isn't
// this operation a tool" sources and both must reach the meta tool.
export type SnapshotPipelineInput = {
  spec: { title: string; specVersion: string; omitted: readonly OmittedOperation[] };
  contentHash: string;
  displaySource: string;
  deadPatterns: readonly DeadPattern[];
  // Accepted operations withheld because the pending candidate removed them
  // (kaisers-io/openapi-mcp-archive#60). They are reported with the other
  // omissions, each with its reason, so the meta tool shows exactly why a
  // baseline operation is not a tool.
  withheldOperations?: readonly OmittedOperation[] | undefined;
  cacheLock?: 'held' | 'stale' | undefined;
};

// Recursively freezes a snapshot subgraph so the exposed ServerSnapshot is
// DEEP-immutable, not just the outer `tools` array — every nested WireTool,
// MetaSummary, omitted-reason entry, and array reachable from a held
// `ServerSnapshot` must reject mutation, matching the `readonly` types in
// types.ts. Zod `ZodType` instances are explicitly left un-walked (see the
// comment on `SnapshotTool.inputSchema` in types.ts) — everything else
// reachable (plain objects, arrays, and the `GeneratedTool`/`mapper`
// function objects) is frozen. A side effect worth naming: because
// `wireToolOf`/`SnapshotTool.generated` retain the ORIGINAL `GeneratedTool`
// object references from `built.tools` (never copied) rather than cloning
// them, this also freezes the caller's own `BuildToolsResult.tools[*]`
// objects — intentional: this snapshot must retain the original schema
// objects unchanged, and freezing is the stronger form of that guarantee,
// not an accidental side channel. `typeof value !== 'object'` also skips
// functions (e.g. `GeneratedTool.mapper`, `typeof` is `'function'`, not
// `'object'`) — deliberately: nothing in this codebase ever reassigns a
// property on a function object, and freezing would not change whether the
// function itself can be CALLED, so there is nothing worth protecting there.
// `toolsByName` is deliberately NOT a `Map`: `Object.freeze` on a `Map`
// does not block its `.set()`/`.delete()` methods (a well-known JS
// limitation — freezing only stops own-property reassignment, and a Map's
// entries live outside its own properties), so a frozen Map's routing table
// would still be mutable at runtime even though the TS `ReadonlyMap` type
// stopped a typed caller from calling `.set()` at compile time only.
// `toolsByName` is instead a null-prototype, own-property RECORD (built via
// `Object.create(null)` below) — its entries genuinely ARE its own
// properties, so this same `deepFreeze` walk that freezes every other plain
// object in the snapshot also genuinely blocks add/replace/delete on it,
// closing the gap at runtime, not just in the types.
const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof z.ZodType) {
    return value;
  }
  const asObject = value;
  if (seen.has(asObject)) {
    return value;
  }
  // Imperative on purpose: cycle detection during a recursive walk needs a
  // set that is genuinely mutated as traversal proceeds — a purely
  // functional "seen" set would have to be threaded through and returned
  // from every recursive call instead, which buys nothing here since the set
  // is never observed outside this walk.
  seen.add(asObject);
  for (const key of Object.keys(asObject)) {
    deepFreeze((asObject as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
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
const indexByName = (tools: readonly SnapshotTool[]): Record<string, SnapshotTool | undefined> => {
  const byName = Object.create(null) as Record<string, SnapshotTool | undefined>;
  for (const tool of tools) {
    if (Object.hasOwn(byName, tool.name)) {
      throw validationError(`duplicate tool name "${tool.name}" in the server snapshot`);
    }
    byName[tool.name] = tool;
  }
  return byName;
};

export type SnapshotOptions = {
  // Omitted means `per-operation`, whose snapshot is unchanged by this option.
  toolMode?: ToolMode;
  // --output-schema defs (issue #9): show output schemas in their compact
  // `$defs` form. Under `per-operation` the listed tools carry it; under
  // `discover` describe_operation computes it on demand, so startup does not
  // pay for operations nobody describes.
  compactOutputSchemas?: boolean;
};

export const buildSnapshot = (
  built: BuildToolsResult,
  pipeline: SnapshotPipelineInput,
  options: SnapshotOptions = {},
): ServerSnapshot => {
  const toolMode = options.toolMode ?? 'per-operation';
  const compact = options.compactOutputSchemas === true;
  const upstreamTools: SnapshotTool[] = built.tools.map((generated) => ({
    kind: 'upstream',
    name: generated.toolName,
    wireTool: wireToolOf(generated, compact && toolMode === 'per-operation'),
    inputSchema: generated.inputSchema,
    generated,
  }));
  const metaTool: SnapshotTool = {
    kind: 'meta',
    name: META_TOOL_NAME,
    wireTool: metaWireTool(),
    inputSchema: META_INPUT_SCHEMA,
  };
  // Meta tool first, then the upstream tools sorted by name: the tools/list
  // order (and therefore its bytes, which clients and prompt caches key on)
  // depends only on WHICH operations exist, never on the order of keys in
  // the spec document — a YAML-to-JSON round trip or a registry that
  // re-serializes the spec cannot reorder the list. Under `discover` the
  // operations leave tools/list; the three discovery tools take their place.
  const sorted = upstreamTools.toSorted(byToolName);
  const all =
    toolMode === 'discover' ? [metaTool, ...buildDiscoveryTools(sorted)] : [metaTool, ...sorted];
  // Two separate namespaces under `discover`: an operation that happens to
  // be named `call_operation` is reached as call_operation's `name` argument
  // and never collides with the listed tool of that name.
  const toolsByName = indexByName(all);
  const operationsByName = indexByName(sorted);
  // Every operation's schemas stay checked under `discover` too: they reach
  // the client through describe_operation instead of tools/list.
  for (const tool of toolMode === 'discover' ? [...all, ...sorted] : all) {
    assertObjectRoot(tool.name, 'inputSchema', tool.wireTool.inputSchema);
    if (tool.wireTool.outputSchema !== undefined) {
      assertObjectRoot(tool.name, 'outputSchema', tool.wireTool.outputSchema);
    }
  }
  // Merge BOTH omission sources (normalization-level + toolgen-level) before
  // capping/sanitizing — the COUNT below is the exact TOTAL across both; the
  // REASONS list is a capped, sanitized diagnostic sample of that total.
  const mergedOmitted: OmittedOperation[] = [
    ...pipeline.spec.omitted,
    ...built.omitted,
    ...(pipeline.withheldOperations ?? []),
  ];
  const meta: MetaSummary = {
    specTitle: pipeline.spec.title,
    specVersion: pipeline.spec.specVersion,
    displaySource: sanitizeSpecText(pipeline.displaySource, PATH_DISPLAY_MAX),
    toolCount: upstreamTools.length,
    omittedCount: mergedOmitted.length,
    omittedReasons: mergedOmitted
      .slice(0, OMITTED_REASONS_CAP)
      .map((omission) => sanitizeOmission(omission)),
    acceptedContentHash: pipeline.contentHash,
    deadPatternCount: pipeline.deadPatterns.length,
    ...(pipeline.cacheLock === undefined ? {} : { cacheLock: pipeline.cacheLock }),
  };
  return deepFreeze({
    toolMode,
    ...(compact ? { compactOutputSchemas: true as const } : {}),
    tools: all,
    toolsByName,
    operations: upstreamTools,
    operationsByName,
    ...(toolMode === 'discover' ? { searchIndex: buildSearchIndex(upstreamTools) } : {}),
    meta,
  });
};
