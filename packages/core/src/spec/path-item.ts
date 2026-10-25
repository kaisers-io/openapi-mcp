import { SPEC_BUDGETS } from './budgets.ts';
import { assertInternal, isRecord, resolvePointer } from './refs.ts';

// A Path Item with a `$ref` may declare fields next to it (OAS 3.1.1 §4.8.9:
// "In case a Path Item Object field appears both in the defined object and the
// referenced object, the behavior is undefined"). Following the `$ref` alone
// dropped every sibling operation without a trace (issue #40), so the two are
// merged here. A field declared on both sides has no defined meaning: it is
// reported as a conflict, and normalize omits the operations it affects
// instead of guessing which side wins.
export type PathItemView = {
  item: Record<string, unknown> | undefined;
  // `get`, `parameters`, `servers`, ... or `additionalOperations/<NAME>`
  conflicts: ReadonlySet<string>;
};

// Plain documentation: the local text wins, as for a Reference Object
const LOCAL_WINS: ReadonlySet<string> = new Set(['summary', 'description']);
const ADDITIONAL = 'additionalOperations';

const mergeAdditional = (
  local: Record<string, unknown>,
  target: Record<string, unknown>,
  conflicts: Set<string>,
): Record<string, unknown> => {
  const fromTarget = Object.entries(target);
  const fromLocal = Object.entries(local).filter(([name]) => {
    const clash = Object.hasOwn(target, name);
    if (clash) {
      conflicts.add(`${ADDITIONAL}/${name}`);
    }
    return !clash;
  });
  // Object.fromEntries defines own properties, so a `__proto__` key stays data
  return Object.fromEntries([...fromTarget, ...fromLocal]);
};

const merge = (
  local: Record<string, unknown>,
  target: Record<string, unknown>,
  conflicts: Set<string>,
): Record<string, unknown> => {
  const entries = new Map(Object.entries(target));
  for (const [key, value] of Object.entries(local)) {
    const existing = entries.get(key);
    if (key === '$ref') {
      continue;
    }
    if (!entries.has(key) || LOCAL_WINS.has(key)) {
      entries.set(key, value);
    } else if (key === ADDITIONAL && isRecord(value) && isRecord(existing)) {
      entries.set(key, mergeAdditional(value, existing, conflicts));
    } else {
      conflicts.add(key);
    }
  }
  return Object.fromEntries(entries);
};

const resolveWithin = (
  document: Record<string, unknown>,
  node: Record<string, unknown>,
  seen: ReadonlySet<string>,
  conflicts: Set<string>,
): Record<string, unknown> => {
  const ref = node['$ref'];
  if (typeof ref !== 'string') {
    return node;
  }
  // A cycle adds nothing new: every Path Item on it is merged already. A
  // chain that is too deep, does not resolve or ends in something other
  // than an object would leave a partial Path
  // Item, without the `servers` or `parameters` further down, so it is
  // reported as `$ref` and every operation of the path is omitted.
  if (seen.has(ref)) {
    return merge(node, {}, conflicts);
  }
  let target: Record<string, unknown> = {};
  try {
    if (seen.size >= SPEC_BUDGETS.maxRefDepth) {
      throw new RangeError('Path Item $ref chain too deep');
    }
    assertInternal(ref);
    const resolved = resolvePointer(document, ref);
    if (!isRecord(resolved)) {
      throw new TypeError('Path Item $ref target is not an object');
    }
    target = resolveWithin(document, resolved, new Set([...seen, ref]), conflicts);
  } catch {
    conflicts.add('$ref');
  }
  return merge(node, target, conflicts);
};

export const resolvePathItem = (document: Record<string, unknown>, node: unknown): PathItemView => {
  if (!isRecord(node)) {
    return { item: undefined, conflicts: new Set() };
  }
  const conflicts = new Set<string>();
  return { item: resolveWithin(document, node, new Set(), conflicts), conflicts };
};

// Why an operation of a Path Item with conflicts is omitted, or undefined.
// `parameters` or `servers` on both sides affects every operation of the
// item; an operation key affects only that operation.
export const conflictReason = (conflicts: ReadonlySet<string>, key: string): string | undefined => {
  if (conflicts.has('$ref')) {
    return 'its Path Item $ref chain is too deep or does not resolve';
  }
  const itemWide = ['parameters', 'servers'].find((field) => conflicts.has(field));
  if (itemWide !== undefined) {
    return `the Path Item and its $ref both declare "${itemWide}"`;
  }
  return conflicts.has(key) ? 'declared both in the Path Item and in its $ref' : undefined;
};
