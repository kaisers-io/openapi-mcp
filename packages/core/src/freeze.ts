import { z } from 'zod';

// Recursively freezes a snapshot subgraph so the exposed ServerSnapshot is
// DEEP-immutable, not just the outer `tools` array — every nested WireTool,
// MetaSummary, omitted-reason entry, and array reachable from a held
// `ServerSnapshot` must reject mutation, matching the `readonly` types in
// types.ts. Zod `ZodType` instances are explicitly left un-walked (see the
// comment on `SnapshotTool.inputSchema` in types.ts) — everything else
// reachable (plain objects, arrays, and the `GeneratedTool`/`mapper`
// function objects) is frozen. A side effect worth naming: `wireToolOf` and
// `runtimeToolOf` copy only the top level of each `GeneratedTool`, so the
// schema objects they share with the caller's `BuildToolsResult.tools[*]`
// are frozen there too — intentional: this snapshot must retain the
// original schema objects unchanged, and freezing is the stronger form of
// that guarantee, not an accidental side channel. `typeof value !== 'object'`
// also skips functions (e.g. `GeneratedTool.mapper`, `typeof` is
// `'function'`, not `'object'`) — deliberately: nothing in this codebase ever
// reassigns a property on a function object, and freezing would not change
// whether the function itself can be CALLED, so there is nothing worth
// protecting there.
// `toolsByName` is deliberately NOT a `Map`: `Object.freeze` on a `Map`
// does not block its `.set()`/`.delete()` methods (a well-known JS
// limitation — freezing only stops own-property reassignment, and a Map's
// entries live outside its own properties), so a frozen Map's routing table
// would still be mutable at runtime even though the TS `ReadonlyMap` type
// stopped a typed caller from calling `.set()` at compile time only.
// `toolsByName` is instead a null-prototype, own-property RECORD (built via
// `Object.create(null)` in operation-entry.ts) — its entries genuinely ARE its own
// properties, so this same `deepFreeze` walk that freezes every other plain
// object in the snapshot also genuinely blocks add/replace/delete on it,
// closing the gap at runtime, not just in the types.
// `seen` may be shared by the walks of one build, so a schema shared by many
// operations is walked once, not once per operation (#47).
export const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
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
