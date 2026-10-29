import type { z } from 'zod';
import type { ToolAnnotations } from '../toolgen/annotations.ts';
import type { GeneratedTool } from '../toolgen/build.ts';
import type { NotExposedCounts } from '../filter/inventory.ts';
import type { OmittedOperation, OperationRecord } from '../spec/normalize.ts';
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

// `discovery` is one of the package-authored tools that stand in for
// the per-operation tools under --tool-mode discover (see discovery.ts).
export type SnapshotToolKind = 'meta' | 'upstream' | 'discovery';

// `per-operation`: one MCP tool per exposed operation (the default).
// `discover`: tools/list carries the meta tool plus search_operations,
// describe_operation and call_operation; the operations stay in the snapshot
// and are reached through those three. `auto` is resolved to one of the two
// before a snapshot is built (see resolveToolMode).
export type ToolMode = 'per-operation' | 'discover';

// What an exposed operation keeps for call time. The parameter, body and
// response schemas are left out: the mapper, the validators and `accept`
// already cover them, and the server would otherwise hold them for its life.
export type RuntimeTool = Omit<GeneratedTool, 'operation'> & {
  readonly operation: Pick<OperationRecord, 'method' | 'path' | 'tags' | 'summary' | 'description'>;
  // The Accept header, derived once from the declared success responses.
  readonly accept: string;
};

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
  readonly generated?: RuntimeTool;
  // Present only for a `discovery` tool: which one it is.
  readonly discovery?: DiscoveryToolName;
};

// An exposed operation as search, listing and startup see it: everything
// but its output side. `resolve` returns the whole tool. Under `discover`
// it builds the output side on first use (issue #47) and throws, every
// time, if that fails, so a caller must resolve before it sends anything.
// A distinct type, so an unresolved operation can never be mistaken for a
// tool that legitimately has no output schema.
export type OperationEntry = {
  readonly name: string;
  readonly operation: RuntimeTool['operation'];
  // The wire input schema (search reads its parameter names)
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
  readonly projection?: true;
  readonly resolve: () => SnapshotTool;
};

// Read-only, package-authored status content. specTitle/specVersion
// already passed through normalizeSpec's own sanitizeSpecText call;
// displaySource and every omittedReasons path/reason are explicitly
// re-sanitized+capped by buildSnapshot below — see snapshot.ts's
// `sanitizeOmission`/the displaySource line — because both can carry RAW
// spec-derived text (a path segment, an unrepresentable-parameter name in a
// `reason` string, or a local absolute file path) that normalizeSpec never
// touches.
// One API of several behind one server (issue #16), as the status tool
// reports it
export type ApiSummary = {
  readonly name: string;
  readonly specTitle: string;
  readonly specVersion: string;
  readonly displaySource: string;
  readonly toolCount: number;
  readonly omittedCount: number;
  readonly acceptedContentHash: string;
  readonly deadPatternCount: number;
  readonly notExposedCounts: NotExposedCounts;
};

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
  // With several APIs (issue #16): each one; the fields above are their sums
  readonly apis?: readonly ApiSummary[];
};

export type ServerSnapshot = {
  readonly toolMode: ToolMode;
  // --output-schema defs (issue #9): output schemas are shown in their
  // compact `$defs` form (see presentedOutputSchema).
  readonly compactOutputSchemas?: true;
  // --no-output-schema-descriptions (issue #49): output schemas are shown
  // without their `description` keywords.
  readonly bareOutputSchemas?: true;
  // What tools/list returns and tools/call can name. Under `per-operation`
  // this is the meta tool followed by every operation; under `discover` it is
  // the meta tool and the discovery tools only, so an operation's own
  // name is an unknown TOOL there (it is reachable only via call_operation
  // and execute_code).
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
  readonly operations: readonly OperationEntry[];
  readonly operationsByName: Readonly<Record<string, OperationEntry | undefined>>;
  // Built once from `operations` under `discover`; absent under
  // `per-operation`, where nothing searches.
  readonly searchIndex?: SearchIndex;
  readonly meta: MetaSummary;
};
