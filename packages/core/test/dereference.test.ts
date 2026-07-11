import { describe, expect, it } from 'vitest';
import { OpenapiMcpError, SPEC_BUDGETS, dereference } from '../src/index.ts';

describe('dereference — resolution', () => {
  it('resolves a component ref by structural copy', () => {
    const doc = {
      paths: { '/pets': { get: { schema: { $ref: '#/components/schemas/Pet' } } } },
      components: { schemas: { Pet: { type: 'object' } } },
    };
    const result = dereference(doc);
    expect(result).toEqual({
      paths: { '/pets': { get: { schema: { type: 'object' } } } },
      components: { schemas: { Pet: { type: 'object' } } },
    });
    // Structural copy, not a shared reference into the source document
    expect(
      (result as { paths: { '/pets': { get: { schema: unknown } } } }).paths['/pets'].get.schema,
    ).not.toBe(doc.components.schemas.Pet);
  });

  it('resolves refs to refs', () => {
    const doc = {
      a: { $ref: '#/b' },
      b: { $ref: '#/c' },
      c: { value: 42 },
    };
    expect(dereference(doc)).toEqual({ a: { value: 42 }, b: { value: 42 }, c: { value: 42 } });
  });

  it('resolves refs inside arrays', () => {
    const doc = {
      list: [{ $ref: '#/target' }, { plain: true }],
      target: { hit: true },
    };
    expect(dereference(doc)['list']).toEqual([{ hit: true }, { plain: true }]);
  });

  it('unescapes ~0 and ~1 in pointer segments', () => {
    const doc = {
      a: { $ref: '#/components/schemas/a~1b~0c' },
      components: { schemas: { 'a/b~c': { ok: true } } },
    };
    expect(dereference(doc)['a']).toEqual({ ok: true });
  });

  it('decodes URI-encoded pointer segments', () => {
    const doc = {
      a: { $ref: '#/components/schemas/Pet%20Shop' },
      components: { schemas: { 'Pet Shop': { ok: true } } },
    };
    expect(dereference(doc)['a']).toEqual({ ok: true });
  });

  it('resolves numeric segments into arrays', () => {
    const doc = { a: { $ref: '#/list/1' }, list: ['zero', 'one'] };
    expect(dereference(doc)['a']).toBe('one');
  });

  it('drops sibling keys next to $ref (documented v1 simplification)', () => {
    const doc = {
      a: { $ref: '#/target', description: 'sibling that is dropped' },
      target: { kept: true },
    };
    expect(dereference(doc)['a']).toEqual({ kept: true });
  });

  it('treats a non-string $ref as a plain key', () => {
    const doc = { a: { $ref: 42 } };
    expect(dereference(doc)).toEqual({ a: { $ref: 42 } });
  });
});

describe('dereference — failure modes', () => {
  it.each([
    './other.yaml#/components/schemas/Pet',
    'https://example.com/spec.json#/x',
    'other.json',
  ])('hard-fails on external ref %s', (ref) => {
    try {
      dereference({ a: { $ref: ref } });
      expect.unreachable('expected a validation error');
    } catch (err) {
      expect((err as OpenapiMcpError).code).toBe('validation');
      expect((err as OpenapiMcpError).message).toContain('external');
    }
  });

  it('fails on an unresolvable pointer', () => {
    expect(() => dereference({ a: { $ref: '#/does/not/exist' } })).toThrowError(
      /does not resolve/u,
    );
  });

  it('fails on a bad array index', () => {
    expect(() => dereference({ a: { $ref: '#/list/9' }, list: [1] })).toThrowError(
      /does not resolve/u,
    );
  });

  it('fails on a non-pointer fragment', () => {
    expect(() => dereference({ a: { $ref: '#components' } })).toThrowError(OpenapiMcpError);
  });
});

describe('dereference — cycles and budgets', () => {
  it('keeps a self-referencing cycle as a $ref marker', () => {
    const doc = {
      components: {
        schemas: { Node: { properties: { next: { $ref: '#/components/schemas/Node' } } } },
      },
    };
    const result = dereference(doc) as {
      components: {
        schemas: { Node: { properties: { next: { properties: { next: unknown } } } } };
      };
    };
    // The outer expansion inlines one level; the cycle point keeps the marker
    expect(result.components.schemas.Node.properties.next.properties.next).toEqual({
      $ref: '#/components/schemas/Node',
    });
  });

  it('keeps mutual cycles as markers', () => {
    const doc = {
      a: { $ref: '#/b' },
      b: { inner: { $ref: '#/a' } },
    };
    const result = dereference(doc) as { a: { inner: unknown } };
    expect(result.a.inner).toEqual({ $ref: '#/a' });
  });

  it('fails on ref chains beyond the expansion depth budget', () => {
    const doc: Record<string, unknown> = { start: { $ref: '#/chain0' } };
    for (let index = 0; index < SPEC_BUDGETS.maxRefDepth + 5; index += 1) {
      doc[`chain${index}`] = { $ref: `#/chain${index + 1}` };
    }
    doc[`chain${SPEC_BUDGETS.maxRefDepth + 5}`] = { done: true };
    expect(() => dereference(doc)).toThrowError(/expansion/u);
  });

  it('aborts an expansion bomb incrementally at the node budget', () => {
    // 2^40 nodes if fully expanded — must abort at maxSchemaNodes, fast
    const layers: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) {
      layers[`L${index}`] = {
        left: { $ref: `#/layers/L${index + 1}` },
        right: { $ref: `#/layers/L${index + 1}` },
      };
    }
    layers['L40'] = { leaf: true };
    const doc: Record<string, unknown> = { root: { $ref: '#/layers/L0' }, layers };
    try {
      dereference(doc);
      expect.unreachable('expected a validation error');
    } catch (err) {
      expect((err as OpenapiMcpError).code).toBe('validation');
      expect((err as OpenapiMcpError).message).toContain('node budget');
    }
  });

  it('preflights wide arrays against the remaining node budget (no pre-allocation)', () => {
    // A single array wider than the whole budget must fail in the capacity
    // preflight, before the destination array is allocated
    const wide = Array.from({ length: SPEC_BUDGETS.maxSchemaNodes + 10 }, () => 0);
    expect(() => dereference({ wide })).toThrowError(/node budget/u);
  });
});
