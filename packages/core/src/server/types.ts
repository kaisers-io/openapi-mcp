import type { z } from 'zod';
import type { GeneratedTool } from '../toolgen/build.ts';
import type { OmittedOperation } from '../spec/normalize.ts';

// The MCP wire-format tool object: a plain JSON-serializable shape, NOT an
// SDK type. server/sdk-v1/protocol.ts casts this to the SDK's `Tool` type at
// the one boundary that needs it — every other module stays SDK-neutral.
// Every field is `readonly` (a STATIC guard — see snapshot.ts's `deepFreeze`
// for the RUNTIME guard that actually enforces it: TS `readonly` alone is
// erased at compile time and does nothing at runtime).
export interface WireTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

export type SnapshotToolKind = 'meta' | 'upstream';

export interface SnapshotTool {
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
}

// Read-only, package-authored status content (§6.7). specTitle/specVersion
// already passed through normalizeSpec's own sanitizeSpecText call;
// displaySource and every omittedReasons path/reason are explicitly
// re-sanitized+capped by buildSnapshot below — see snapshot.ts's
// `sanitizeOmission`/the displaySource line — because both can carry RAW
// spec-derived text (a path segment, an unrepresentable-parameter name in a
// `reason` string, or a local absolute file path) that normalizeSpec never
// touches (§6.4 untrusted-text rule).
export interface MetaSummary {
  readonly specTitle: string;
  readonly specVersion: string;
  readonly displaySource: string;
  readonly toolCount: number;
  readonly omittedCount: number;
  readonly omittedReasons: readonly OmittedOperation[];
  readonly acceptedContentHash: string;
  readonly deadPatternCount: number;
}

export interface ServerSnapshot {
  readonly tools: readonly SnapshotTool[];
  // A frozen, null-prototype lookup record — NOT a `Map` (see snapshot.ts's
  // `buildSnapshot` for why: a `Map`'s entries live outside its own
  // properties, so `Object.freeze` cannot stop `.set()`/`.delete()` on one).
  // The value type ADMITS MISSES (`| undefined`) because a plain index
  // signature on an object always can be read for a key that was never
  // written — reads MUST go through `Object.hasOwn` (see dispatch.ts), never
  // bare indexing, to distinguish "not present" from a stored `undefined`.
  readonly toolsByName: Readonly<Record<string, SnapshotTool | undefined>>;
  readonly meta: MetaSummary;
}
