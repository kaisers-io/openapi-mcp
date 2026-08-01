import { validationError } from '../errors.ts';
import { SPEC_BUDGETS } from './budgets.ts';

const decodeSegment = (rawSegment: string, ref: string): string => {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw validationError(`$ref "${ref}" contains an invalid URI escape`);
  }
};

const resolvePointer = (document: Record<string, unknown>, ref: string): unknown => {
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

export const dereference = (document: Record<string, unknown>): Record<string, unknown> => {
  // Imperative on purpose: nodeCount is a running total shared across every
  // recursive `walk` call (a single budget for the whole expansion, not a
  // per-branch one), incremented as a side effect so the budget check fires
  // the instant the total is exceeded. Threading it through return values
  // instead would mean every return path of `walk` — including the
  // pass-through/cycle short-circuits — carries a count, entangling the
  // dereferencing result type with budget bookkeeping for no behavioural gain.
  let nodeCount = 0;

  const countNode = (): void => {
    nodeCount += 1;
    if (nodeCount > SPEC_BUDGETS.maxSchemaNodes) {
      // Incremental abort: raised during expansion, before further allocation
      throw validationError(
        `dereferenced spec exceeds the ${SPEC_BUDGETS.maxSchemaNodes}-node budget`,
      );
    }
  };

  const ensureCapacity = (immediateChildren: number): void => {
    if (nodeCount + immediateChildren > SPEC_BUDGETS.maxSchemaNodes) {
      // Preflight a container's immediate allocation against the remaining
      // budget: a wide array must fail BEFORE the destination array is
      // allocated, not after its children are individually counted
      throw validationError(
        `dereferenced spec exceeds the ${SPEC_BUDGETS.maxSchemaNodes}-node budget`,
      );
    }
  };

  const walk = (node: unknown, refStack: readonly string[]): unknown => {
    countNode();
    if (Array.isArray(node)) {
      ensureCapacity(node.length);
      return node.map((item) => walk(item, refStack));
    }
    if (node === null || typeof node !== 'object') {
      return node;
    }
    const record = node as Record<string, unknown>;
    const ref = record['$ref'];
    if (typeof ref === 'string') {
      if (!ref.startsWith('#')) {
        // SSRF/injection surface — external documents are rejected outright
        throw validationError(
          `external $ref "${ref}" is not supported — inline external documents before serving`,
        );
      }
      if (refStack.includes(ref)) {
        // Cycle: keep an opaque marker; consumers decide representability
        return { $ref: ref };
      }
      if (refStack.length >= SPEC_BUDGETS.maxRefDepth) {
        throw validationError(
          `$ref expansion exceeds the maximum depth of ${SPEC_BUDGETS.maxRefDepth}`,
        );
      }
      const target = resolvePointer(document, ref);
      if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
        const passThroughRef = (target as Record<string, unknown>)['$ref'];
        // The target is itself a bare $ref (a pure pass-through indirection).
        // If following it would immediately close a cycle already in
        // progress, stop here instead of silently expanding one extra,
        // misleading level before the marker appears (mutual-cycle case).
        if (typeof passThroughRef === 'string' && refStack.includes(passThroughRef)) {
          return { $ref: ref };
        }
      }
      // Sibling keys next to $ref are dropped (documented v1 simplification)
      return walk(target, [...refStack, ref]);
    }
    const entries = Object.entries(record);
    ensureCapacity(entries.length);
    // Null-prototype accumulator: an own `__proto__` key (produced by JSON.parse)
    // must survive as a real key, not pollute the prototype and vanish. Every
    // consumer reads via Object.entries / bracket access / JSON.stringify, all of
    // which handle a null-prototype object unchanged.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of entries) {
      result[key] = walk(value, refStack);
    }
    return result;
  };

  try {
    return walk(document, []) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RangeError) {
      // Backstop: structural depth is budget-capped upstream, but fail closed anyway
      throw validationError('spec dereference aborted: nesting too deep');
    }
    throw error;
  }
};
