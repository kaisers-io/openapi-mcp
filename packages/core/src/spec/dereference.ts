import { validationError } from '../errors.ts';
import { SPEC_BUDGETS } from './budgets.ts';

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
  let current: unknown = document;
  for (const rawSegment of pointer.slice(1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw validationError(`$ref "${ref}" contains an invalid URI escape`);
    }
    segment = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw validationError(`$ref "${ref}" does not resolve (bad array index "${segment}")`);
      }
      current = current[index];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw validationError(`$ref "${ref}" does not resolve`);
    }
  }
  return current;
};

export const dereference = (document: Record<string, unknown>): Record<string, unknown> => {
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
      // allocated, not after its children are individually counted (§4.1)
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
        // SSRF/injection surface — spec §4 rejects external documents outright
        throw validationError(
          `external $ref "${ref}" is not supported — inline external documents before serving`,
        );
      }
      if (refStack.includes(ref)) {
        // Cycle: keep an opaque marker; consumers decide representability (D3)
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
      // Sibling keys next to $ref are dropped (documented v1 simplification, D3)
      return walk(target, [...refStack, ref]);
    }
    const entries = Object.entries(record);
    ensureCapacity(entries.length);
    const result: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      result[key] = walk(value, refStack);
    }
    return result;
  };

  try {
    return walk(document, []) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof RangeError) {
      // Backstop: structural depth is budget-capped upstream, but fail closed anyway
      throw validationError('spec dereference aborted: nesting too deep');
    }
    throw err;
  }
};
