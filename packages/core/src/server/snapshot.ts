import { z } from 'zod';
import { validationError } from '../errors.ts';
import type { DeadPattern } from '../filter/engine.ts';
import type { OmittedOperation } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { BuildToolsResult, GeneratedTool } from '../toolgen/build.ts';
import type { MetaSummary, ServerSnapshot, SnapshotTool, WireTool } from './types.ts';

export const META_TOOL_NAME = 'openapi_mcp_status';

// Bounds the omitted-reason list carried in the meta summary — the omitted
// COUNT is always exact; the reason list is a diagnostic sample, capped so a
// pathological spec cannot inflate the in-memory snapshot.
const OMITTED_REASONS_CAP = 50;

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

const META_INPUT_SCHEMA = z.strictObject({});

const META_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    specTitle: { type: 'string' },
    specVersion: { type: 'string' },
    displaySource: { type: 'string' },
    toolCount: { type: 'integer' },
    omittedCount: { type: 'integer' },
    omittedReasons: {
      type: 'array',
      maxItems: OMITTED_REASONS_CAP,
      items: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          path: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['method', 'path', 'reason'],
        additionalProperties: false,
      },
    },
    acceptedContentHash: { type: 'string' },
    deadPatternCount: { type: 'integer' },
    // Present only when start-up could not record the spec revalidation
    // because another process holds the cache lock (#65). Host users rarely
    // see stderr, so the stuck case is surfaced here too.
    cacheLock: {
      type: 'string',
      enum: ['held', 'stale'],
      description:
        'Cache metadata not updated at start-up. stale: a dead process left the cache lock; the operator should run "openapi-mcp cache unlock". Tools still work.',
    },
  },
  required: [
    'specTitle',
    'specVersion',
    'displaySource',
    'toolCount',
    'omittedCount',
    'omittedReasons',
    'acceptedContentHash',
    'deadPatternCount',
  ],
  additionalProperties: false,
};

const metaWireTool = (): WireTool => ({
  name: META_TOOL_NAME,
  description:
    "Report this server's accepted spec, tool inventory, and omissions. Read-only, package-authored — never spec-derived.",
  inputSchema: z.toJSONSchema(META_INPUT_SCHEMA) as Record<string, unknown>,
  outputSchema: META_OUTPUT_SCHEMA,
  // Not the OpenAPI-method heuristic (this is our own tool, not a wrapped
  // operation): explicitly read-only and NOT open-world — it only reads local
  // process state, it never talks to an external system.
  annotations: { readOnlyHint: true, openWorldHint: false },
});

const wireToolOf = (generated: GeneratedTool): WireTool => ({
  name: generated.toolName,
  description: generated.description,
  inputSchema: generated.wireSchema as Record<string, unknown>,
  ...(generated.outputSchema === undefined ? {} : { outputSchema: generated.outputSchema }),
  annotations: generated.annotations as unknown as Record<string, unknown>,
});

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

export const buildSnapshot = (
  built: BuildToolsResult,
  pipeline: SnapshotPipelineInput,
): ServerSnapshot => {
  const upstreamTools: SnapshotTool[] = built.tools.map((generated) => ({
    kind: 'upstream',
    name: generated.toolName,
    wireTool: wireToolOf(generated),
    inputSchema: generated.inputSchema,
    generated,
  }));
  const metaTool: SnapshotTool = {
    kind: 'meta',
    name: META_TOOL_NAME,
    wireTool: metaWireTool(),
    inputSchema: META_INPUT_SCHEMA,
  };
  // Meta tool first: a stable, predictable tools/list order that does not
  // depend on operation ordering in the spec.
  const all = [metaTool, ...upstreamTools];
  // Null-prototype: tool names are sanitized identifiers already, but a null
  // prototype is the safe default regardless — `__proto__`/`constructor` are
  // just ordinary own keys here, never a prototype-pollution vector, and
  // `Object.hasOwn` below never needs to distinguish an own key from an
  // inherited one.
  const toolsByName: Record<string, SnapshotTool | undefined> = Object.create(null) as Record<
    string,
    SnapshotTool | undefined
  >;
  // Imperative on purpose: this is validate-then-write, not a plain
  // accumulation — `Object.fromEntries`/`reduce` would either silently let a
  // later duplicate name overwrite an earlier tool (losing the throw
  // entirely) or need the same hasOwn-then-throw check re-embedded in a
  // reducer callback for no readability gain over the loop below.
  for (const tool of all) {
    if (Object.hasOwn(toolsByName, tool.name)) {
      throw validationError(`duplicate tool name "${tool.name}" in the server snapshot`);
    }
    toolsByName[tool.name] = tool;
  }
  for (const tool of all) {
    assertObjectRoot(tool.name, 'inputSchema', tool.wireTool.inputSchema);
    if (tool.wireTool.outputSchema !== undefined) {
      assertObjectRoot(tool.name, 'outputSchema', tool.wireTool.outputSchema);
    }
  }
  // Merge BOTH omission sources (normalization-level + toolgen-level) before
  // capping/sanitizing — the COUNT below is the exact TOTAL across both; the
  // REASONS list is a capped, sanitized diagnostic sample of that total.
  const mergedOmitted: OmittedOperation[] = [...pipeline.spec.omitted, ...built.omitted];
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
  return deepFreeze({ tools: all, toolsByName, meta });
};
