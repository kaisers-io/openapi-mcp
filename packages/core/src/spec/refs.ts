// $ref plumbing shared by the dereferencer and normalization: JSON-pointer
// resolution, the external-ref refusal, and the two checks that read refs
// without expanding anything.
import { validationError } from '../errors.ts';
import { SPEC_BUDGETS } from './budgets.ts';

const decodeSegment = (rawSegment: string, ref: string): string => {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw validationError(`$ref "${ref}" contains an invalid URI escape`);
  }
};

export const resolvePointer = (document: Record<string, unknown>, ref: string): unknown => {
  const pointer = ref.slice(1);
  if (pointer === '') {
    return document;
  }
  if (!pointer.startsWith('/')) {
    throw validationError(
      `unsupported $ref "${ref}" — only JSON-pointer fragments ("#/...") are supported`,
    );
  }
  // Fold left-to-right over the pointer's segments, same order and same
  // per-segment throw points as the original loop — each step still resolves
  // exactly one array index or object key before the next segment is read.
  return pointer
    .slice(1)
    .split('/')
    .reduce<unknown>((current, rawSegment) => {
      const segment = decodeSegment(rawSegment, ref).replaceAll('~1', '/').replaceAll('~0', '~');
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) {
          throw validationError(`$ref "${ref}" does not resolve (bad array index "${segment}")`);
        }
        return current[index];
      }
      if (current !== null && typeof current === 'object' && Object.hasOwn(current, segment)) {
        return (current as Record<string, unknown>)[segment];
      }
      throw validationError(`$ref "${ref}" does not resolve`);
    }, document);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// SSRF/injection surface — external documents are rejected outright
export const assertInternal = (ref: string): void => {
  if (!ref.startsWith('#')) {
    throw validationError(
      `external $ref "${ref}" is not supported — inline external documents before serving`,
    );
  }
};

// Queues a container's children one by one. A variadic push(...children)
// passes every element as a call argument, which throws a RangeError past
// V8's argument limit (~120k) — well inside the spec budgets, so a wide but
// valid array or object would otherwise crash the walk.
const pushChildren = (pending: unknown[], children: readonly unknown[]): void => {
  for (const child of children) {
    pending.push(child);
  }
};

// Validates every $ref in the document WITHOUT expanding anything: each must
// be an internal JSON pointer that resolves. Dereferencing itself is deferred
// until the operations to expose are known (issue
// kaisers-io/openapi-mcp-archive#89), but a spec with a dangling or external
// reference is still refused as a whole, before it can reach the cache — the
// same verdict a full expansion gave. Iterative and O(document): the parse
// depth budget bounds the stack, and each distinct ref string is resolved once.
export const checkRefs = (document: Record<string, unknown>): void => {
  const checked = new Set<string>();
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pushChildren(pending, node);
    } else if (isRecord(node)) {
      const ref = node['$ref'];
      if (typeof ref === 'string' && !checked.has(ref)) {
        assertInternal(ref);
        resolvePointer(document, ref);
        checked.add(ref);
      }
      pushChildren(pending, Object.values(node));
    }
  }
};

// Follows a chain of bare `{ $ref }` indirections to the first node that is
// not one, WITHOUT expanding its contents — what normalization needs to read a
// path item's methods or a parameter's name/in. A chain that loops back on
// itself returns the `{ $ref }` marker where the loop closes, which callers
// treat as unresolvable, exactly like a cycle marker from a full expansion.
export const resolveShallow = (document: Record<string, unknown>, node: unknown): unknown => {
  const seen = new Set<string>();
  let current = node;
  while (isRecord(current) && typeof current['$ref'] === 'string') {
    const ref = current['$ref'];
    if (seen.has(ref)) {
      return { $ref: ref };
    }
    if (seen.size >= SPEC_BUDGETS.maxRefDepth) {
      throw validationError(
        `$ref expansion exceeds the maximum depth of ${SPEC_BUDGETS.maxRefDepth}`,
      );
    }
    assertInternal(ref);
    seen.add(ref);
    current = resolvePointer(document, ref);
  }
  return current;
};

// Every $ref string under `root`, its own and nested ones, without following any
const refsUnder = (root: unknown): string[] => {
  const found: string[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pushChildren(pending, node);
    } else if (isRecord(node)) {
      const ref = node['$ref'];
      if (typeof ref === 'string') {
        found.push(ref);
      }
      pushChildren(pending, Object.values(node));
    }
  }
  return found;
};

type TarjanFrame = { node: string; next: number };

// Answers "is this $ref on a reference cycle?" — a strongly connected
// component of more than one target, or a target that references itself.
// Tarjan's algorithm over the ref graph (one node per distinct $ref, an edge
// to every $ref inside its target), run lazily: a query for an unvisited ref
// starts a search from it, which classifies everything reachable from it, and
// later queries reuse that. So only the part of the graph the exposed
// operations reach is ever walked, and nothing is expanded. Iterative, so a
// deep graph cannot overflow the stack.
export const createCycleDetector = (
  document: Record<string, unknown>,
): ((ref: string) => boolean) => {
  // Imperative on purpose: Tarjan's index/lowlink bookkeeping is inherently a
  // set of mutable maps advanced by one shared counter, kept across queries
  const edges = new Map<string, readonly string[]>();
  const cyclic = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const edgesOf = (ref: string): readonly string[] => {
    const known = edges.get(ref);
    if (known !== undefined) {
      return known;
    }
    assertInternal(ref);
    const found = refsUnder(resolvePointer(document, ref));
    edges.set(ref, found);
    return found;
  };
  const visit = (node: string, frames: TarjanFrame[]): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    frames.push({ node, next: 0 });
  };
  const lowOf = (node: string): number => low.get(node) ?? 0;
  // Pops the component rooted at `head`; more than one member is a cycle
  const closeComponent = (head: string): void => {
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
    } while (member !== head);
    if (component.length > 1) {
      for (const ref of component) {
        cyclic.add(ref);
      }
    }
  };
  const search = (start: string): void => {
    const frames: TarjanFrame[] = [];
    visit(start, frames);
    while (frames.length > 0) {
      const frame = frames.at(-1) as TarjanFrame;
      const targets = edgesOf(frame.node);
      if (frame.next < targets.length) {
        const target = targets[frame.next] as string;
        frame.next += 1;
        if (target === frame.node) {
          cyclic.add(target);
        }
        if (!index.has(target)) {
          visit(target, frames);
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(lowOf(frame.node), index.get(target) ?? 0));
        }
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        low.set(parent.node, Math.min(lowOf(parent.node), lowOf(frame.node)));
      }
      if (lowOf(frame.node) === index.get(frame.node)) {
        closeComponent(frame.node);
      }
    }
  };
  return (ref) => {
    if (!index.has(ref)) {
      search(ref);
    }
    return cyclic.has(ref);
  };
};

// For normalization: a reference that does not resolve is left as the
// `{ $ref }` it is, which callers already omit as unresolvable. The pipeline
// rejects dangling references before normalizing (checkRefs); this only keeps
// a hand-built or already-dereferenced document (cycle markers) from throwing.
export const resolveShallowOrSelf = (document: Record<string, unknown>, node: unknown): unknown => {
  try {
    return resolveShallow(document, node);
  } catch {
    return node;
  }
};

// Set helpers for the dereferencer's open-cycle bookkeeping; undefined is
// the empty set, so the common no-cycle case allocates nothing
export const unionRefs = (
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

export const withoutRef = (
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
