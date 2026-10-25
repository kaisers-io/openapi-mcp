import type { z } from 'zod';
import type { GeneratedTool } from '../toolgen/build.ts';
import type { NotExposedCounts } from '../filter/inventory.ts';
import type { OmittedOperation } from '../spec/normalize.ts';
import type { DiscoveryToolName } from './discovery.ts';
import type { SearchIndex } from './search-index.ts';

// The MCP wire-format tool object: a plain JSON-serializable shape, NOT an
// SDK type. server/sdk/protocol.ts casts this to the SDK's `Tool` type at
// the one boundary that needs it — every other module stays SDK-neutral.
// Every field is `readonly` (a STATIC guard — see snapshot.ts's `deepFreeze`
// for the RUNTIME guard that actually enforces it: TS `readonly` alone is
// erased at compile time and does nothing at runtime).
export type WireTool = {
  readonly name: string;
  // Human-readable display name (MCP `Tool.title`), from the operation's
  // sanitized `summary`; absent when the spec gives none.
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
};

// `discovery` is one of the three package-authored tools that stand in for
// the per-operation tools under --tool-mode discover (see discovery.ts).
export type SnapshotToolKind = 'meta' | 'upstream' | 'discovery';

// `per-operation`: one MCP tool per exposed operation (the default).
// `discover`: tools/list carries the meta tool plus search_operations,
// describe_operation and call_operation; the operations stay in the snapshot
// and are reached through those three. `auto` is resolved to one of the two
// before a snapshot is built (see resolveToolMode).
export type ToolMode = 'per-operation' | 'discover';

export type SnapshotTool = {
  readonly kind: SnapshotToolKind;
  readonly name: string;
  readonly wireTool: WireTool;
  // The real Zod schema (not the wire JSON Schema) — the dispatcher validates
  // incoming arguments against THIS, never against the wire copy. NOT walked
  // by deepFreeze (a Zod ZodType instance manages its own internal, legitimately
  // mutable caches) — freezing the SnapshotTool object itself already stops
  // this reference from being swapped out for a different schema.
  readonly inputSchema: z.ZodType;
  // Present only for an upstream (OpenAPI-generated) tool; the meta tool has
  // no OpenAPI mapper to execute against.
  readonly generated?: GeneratedTool;
  // Present only for a `discovery` tool: which of the three it is.
  readonly discovery?: DiscoveryToolName;
};

// Read-only, package-authored status content. specTitle/specVersion
// already passed through normalizeSpec's own sanitizeSpecText call;
// displaySource and every omittedReasons path/reason are explicitly
// re-sanitized+capped by buildSnapshot below — see snapshot.ts's
// `sanitizeOmission`/the displaySource line — because both can carry RAW
// spec-derived text (a path segment, an unrepresentable-parameter name in a
// `reason` string, or a local absolute file path) that normalizeSpec never
// touches.
export type MetaSummary = {
  readonly specTitle: string;
  readonly specVersion: string;
  readonly displaySource: string;
  readonly toolCount: number;
  readonly omittedCount: number;
  readonly omittedReasons: readonly OmittedOperation[];
  readonly acceptedContentHash: string;
  readonly deadPatternCount: number;
  readonly notExposedCounts: NotExposedCounts;
  // See META_OUTPUT_SCHEMA in snapshot.ts
  readonly cacheLock?: 'held' | 'stale';
};

export type ServerSnapshot = {
  readonly toolMode: ToolMode;
  // --output-schema defs (issue #9): output schemas are shown in their
  // compact `$defs` form (see presentedOutputSchema).
  readonly compactOutputSchemas?: true;
  // What tools/list returns and tools/call can name. Under `per-operation`
  // this is the meta tool followed by every operation; under `discover` it is
  // the meta tool and the three discovery tools only, so an operation's own
  // name is an unknown TOOL there (it is reachable only via call_operation).
  readonly tools: readonly SnapshotTool[];
  // A frozen, null-prototype lookup record — NOT a `Map` (see snapshot.ts's
  // `buildSnapshot` for why: a `Map`'s entries live outside its own
  // properties, so `Object.freeze` cannot stop `.set()`/`.delete()` on one).
  // The value type ADMITS MISSES (`| undefined`) because a plain index
  // signature on an object always can be read for a key that was never
  // written — reads MUST go through `Object.hasOwn` (see dispatch.ts), never
  // bare indexing, to distinguish "not present" from a stored `undefined`.
  readonly toolsByName: Readonly<Record<string, SnapshotTool | undefined>>;
  // Every exposed (post-filter) upstream operation, in build order, in BOTH
  // modes — the one set call_operation, describe_operation and the search
  // index draw from. An operation --allow/--deny or the read-only default
  // excluded was never built, so it is in neither this list nor the lookup
  // below: there is no second policy path to keep in sync. Same `Object.hasOwn`
  // read rule as toolsByName.
  readonly operations: readonly SnapshotTool[];
  readonly operationsByName: Readonly<Record<string, SnapshotTool | undefined>>;
  // Built once from `operations` under `discover`; absent under
  // `per-operation`, where nothing searches.
  readonly searchIndex?: SearchIndex;
  readonly meta: MetaSummary;
};
