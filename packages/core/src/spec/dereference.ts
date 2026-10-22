import { validationError } from '../errors.ts';
import { SPEC_BUDGETS } from './budgets.ts';
import { assertInternal, createCycleDetector, isRecord, resolvePointer } from './refs.ts';

export { checkRefs, createCycleDetector, resolveShallow } from './refs.ts';

// Hard ceiling on the LOGICAL size of everything a dereferencer hands out:
// the node count of the output read as a tree, i.e. every shared $ref target
// counted once per place it occurs. Unique allocations are bounded by
// SPEC_BUDGETS.maxSchemaNodes below; this bounds what consumers that walk the
// output as a tree (schema conversion, JSON Schema emission, serialization)
// can be made to do. 2^40 occurrences of a 40-level "billion laughs" chain
// are refused from the memoized sizes alone, without walking anything.
export const MAX_EXPANDED_NODES = 10_000_000;

const budgetError = (budget: number, what: string): Error =>
  validationError(`dereferenced spec exceeds the ${budget}-node budget${what}`);

const checkExpanded = (size: number): void => {
  if (size > MAX_EXPANDED_NODES) {
    throw budgetError(MAX_EXPANDED_NODES, ' once shared $ref targets are expanded');
  }
};

type Walked = {
  value: unknown;
  // Logical node count of `value` read as a tree
  size: number;
  // Refs this subtree emitted a cycle marker for that were still in progress
  // (on the ref stack) when the marker was emitted. Undefined means none.
  open: ReadonlySet<string> | undefined;
  // Longest chain of nested (non-marker) refs inside this subtree; decides
  // whether a reused expansion would have crossed SPEC_BUDGETS.maxRefDepth
  height: number;
};

type MemoEntry = { value: unknown; size: number; height: number };

const union = (
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined => {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return new Set([...left, ...right]);
};

const without = (
  set: ReadonlySet<string> | undefined,
  ref: string,
): ReadonlySet<string> | undefined => {
  if (set?.has(ref) !== true) {
    return set;
  }
  const rest = new Set(set);
  rest.delete(ref);
  return rest.size === 0 ? undefined : rest;
};

// A container's summary: itself plus its children
const combine = (value: unknown, children: readonly Walked[]): Walked => {
  let size = 1;
  let open: ReadonlySet<string> | undefined;
  let height = 0;
  for (const child of children) {
    size += child.size;
    open = union(open, child.open);
    height = Math.max(height, child.height);
  }
  checkExpanded(size);
  return { value, size, open, height };
};

export type DereferencerOptions = {
  // Return a `{ $ref }` cycle marker for every $ref that is on a reference
  // cycle, instead of expanding it until the cycle closes. See below.
  collapseCycles?: boolean;
};

export type Dereferencer = {
  // Deep-resolves any node of the document. Repeated calls share one memo and
  // one pair of budgets, so resolving many operations costs each shared $ref
  // target once.
  resolve: (node: unknown) => unknown;
};

// Memoized dereferencing (issue #89). Each $ref target is expanded once and
// the SAME output object is returned for every occurrence, so the output is a
// DAG instead of a tree: memory, the unique-node budget and any consumer that
// memoizes by identity scale with the source, not with the expansion.
//
// Memoization must not change the output. An expansion is reused only if it
// emitted no cycle marker for a ref outside itself (`open` is empty): such a
// target is not on any $ref cycle, and its expansion cannot depend on which
// refs are in progress above it, so it is identical under every ancestor
// stack. Targets on a cycle (their expansion closes back on themselves or an
// ancestor) are re-expanded per occurrence, exactly as before, so cycle
// markers land in the same places for self, mutual and pass-through cycles.
// Even a cyclic subtree reuses every acyclic target inside it.
//
// collapseCycles (what the pipeline uses): a target on a $ref cycle cannot
// be memoized, and expanding it until each path closes is exponential in the
// cycle structure — Stripe's customer model alone passes 10,000,000 nodes. But
// a cycle marker anywhere in a schema makes that schema unrepresentable for
// tool generation (an unknown "$ref" keyword), wherever the marker sits. So
// instead of expanding a cyclic target, the marker is emitted at its first
// occurrence: the consumers reach the same verdict (fail-closed) from a tree
// that no longer grows with the cycles. Without the option, cyclic targets
// are expanded exactly as before.
//
// The output objects are shared, so consumers must never mutate them; none
// does (normalization and tool generation only read, and the server snapshot
// freezes them).
export const createDereferencer = (
  document: Record<string, unknown>,
  options: DereferencerOptions = {},
): Dereferencer => {
  const isCyclic = createCycleDetector(document);
  // Imperative on purpose: both counters are running totals shared across
  // every recursive `walk` and every `resolve` call (one budget for the whole
  // expansion, not a per-branch one), incremented as a side effect so the
  // budget check fires the instant a total is exceeded.
  let uniqueNodes = 0;
  let expandedNodes = 0;
  const memo = new Map<string, MemoEntry>();

  const allocate = (count: number): void => {
    uniqueNodes += count;
    if (uniqueNodes > SPEC_BUDGETS.maxSchemaNodes) {
      // Preflight before the container is allocated: a wide array must fail
      // BEFORE the destination array exists, not after its children are counted
      throw budgetError(SPEC_BUDGETS.maxSchemaNodes, '');
    }
  };

  const walkRef = (ref: string, refStack: readonly string[]): Walked => {
    assertInternal(ref);
    if (refStack.includes(ref)) {
      // Cycle: keep an opaque marker; consumers decide representability
      allocate(1);
      return { value: { $ref: ref }, size: 1, open: new Set([ref]), height: 0 };
    }
    if (options.collapseCycles === true && isCyclic(ref)) {
      allocate(1);
      return { value: { $ref: ref }, size: 1, open: undefined, height: 0 };
    }
    const cached = memo.get(ref);
    if (cached !== undefined) {
      // The deepest ref check inside it ran at stack length height - 1 above
      // this one, and a check fails at stack length >= maxRefDepth
      if (refStack.length + cached.height > SPEC_BUDGETS.maxRefDepth) {
        // The expansion this replaces would have crossed the depth budget here
        throw validationError(
          `$ref expansion exceeds the maximum depth of ${SPEC_BUDGETS.maxRefDepth}`,
        );
      }
      return { value: cached.value, size: cached.size, open: undefined, height: cached.height };
    }
    if (refStack.length >= SPEC_BUDGETS.maxRefDepth) {
      throw validationError(
        `$ref expansion exceeds the maximum depth of ${SPEC_BUDGETS.maxRefDepth}`,
      );
    }
    const target = resolvePointer(document, ref);
    if (isRecord(target)) {
      const passThroughRef = target['$ref'];
      // The target is itself a bare $ref (a pure pass-through indirection).
      // If following it would immediately close a cycle already in progress,
      // stop here instead of silently expanding one extra, misleading level
      // before the marker appears (mutual-cycle case).
      if (typeof passThroughRef === 'string' && refStack.includes(passThroughRef)) {
        allocate(1);
        return { value: { $ref: ref }, size: 1, open: new Set([passThroughRef]), height: 0 };
      }
    }
    // Sibling keys next to $ref are dropped (documented v1 simplification)
    const walked = walk(target, [...refStack, ref]);
    const height = walked.height + 1;
    if (walked.open === undefined) {
      memo.set(ref, { value: walked.value, size: walked.size, height });
    }
    return { value: walked.value, size: walked.size, open: without(walked.open, ref), height };
  };

  const walk = (node: unknown, refStack: readonly string[]): Walked => {
    if (Array.isArray(node)) {
      allocate(1 + node.length);
      // Each element is charged once above and again when walked, so undo
      // the per-element charge: the preflight only has to fail early
      uniqueNodes -= node.length;
      const items = node.map((item) => walk(item, refStack));
      return combine(
        items.map((item) => item.value),
        items,
      );
    }
    if (!isRecord(node)) {
      allocate(1);
      return { value: node, size: 1, open: undefined, height: 0 };
    }
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      return walkRef(ref, refStack);
    }
    const entries = Object.entries(node);
    allocate(1 + entries.length);
    uniqueNodes -= entries.length;
    // Null-prototype accumulator: an own `__proto__` key (produced by JSON.parse)
    // must survive as a real key, not pollute the prototype and vanish. Every
    // consumer reads via Object.entries / bracket access / JSON.stringify, all of
    // which handle a null-prototype object unchanged.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const children = entries.map(([key, value]) => {
      const child = walk(value, refStack);
      result[key] = child.value;
      return child;
    });
    return combine(result, children);
  };

  return {
    resolve: (node) => {
      try {
        const walked = walk(node, []);
        expandedNodes += walked.size;
        checkExpanded(expandedNodes);
        return walked.value;
      } catch (error) {
        if (error instanceof RangeError) {
          // Backstop: structural depth is budget-capped upstream, but fail closed anyway
          throw validationError('spec dereference aborted: nesting too deep');
        }
        throw error;
      }
    },
  };
};

// Expands the whole document (components included). The spec pipeline no
// longer does this — it resolves only the exposed operations (see
// createDereferencer) — but the full form stays available to callers that
// want a self-contained document.
export const dereference = (document: Record<string, unknown>): Record<string, unknown> =>
  createDereferencer(document).resolve(document) as Record<string, unknown>;
