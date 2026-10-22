import { describe, expect, it } from 'vitest';
import {
  OpenapiMcpError,
  SPEC_BUDGETS,
  SYSTEM_HEADERS,
  assignToolNames,
  buildTools,
  checkRefs,
  createCycleDetector,
  createDereferencer,
  dereference,
  MAX_EXPANDED_NODES,
  normalizeSpec,
  resolveShallow,
} from '../src/index.ts';

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

  it('drops sibling keys next to $ref under OpenAPI 3.0 (and without a version)', () => {
    const doc = {
      a: { $ref: '#/target', description: 'sibling that is dropped' },
      target: { kept: true },
    };
    expect(dereference(doc)['a']).toEqual({ kept: true });
    expect(dereference(doc, '3.0')['a']).toEqual({ kept: true });
  });

  it('applies sibling keys next to $ref under OpenAPI 3.1 (issue #63)', () => {
    const doc = {
      components: { schemas: { Name: { type: 'string', description: 'shared' } } },
      a: { schema: { $ref: '#/components/schemas/Name', maxLength: 5, description: 'own' } },
      b: { $ref: '#/target', description: 'override', required: true },
      target: { name: 'x', in: 'query', description: 'shared' },
    };
    const out = dereference(doc, '3.1') as Record<string, Record<string, unknown>>;
    expect(out['a']?.['schema']).toEqual({ type: 'string', maxLength: 5, description: 'own' });
    // A Reference Object outside schemas: only summary/description apply
    expect(out['b']).toEqual({ name: 'x', in: 'query', description: 'override' });
    // The shared target itself is untouched
    expect(out['components']).toEqual(doc.components);
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
    } catch (error) {
      expect((error as OpenapiMcpError).code).toBe('validation');
      expect((error as OpenapiMcpError).message).toContain('external');
    }
  });

  it('fails on an unresolvable pointer', () => {
    expect(() => dereference({ a: { $ref: '#/does/not/exist' } })).toThrow(/does not resolve/u);
  });

  it('fails on a bad array index', () => {
    expect(() => dereference({ a: { $ref: '#/list/9' }, list: [1] })).toThrow(/does not resolve/u);
  });

  it('fails on a non-pointer fragment', () => {
    expect(() => dereference({ a: { $ref: '#components' } })).toThrow(OpenapiMcpError);
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
    expect(() => dereference(doc)).toThrow(/expansion/u);
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
    } catch (error) {
      expect((error as OpenapiMcpError).code).toBe('validation');
      expect((error as OpenapiMcpError).message).toContain('node budget');
    }
  });

  it('preflights wide arrays against the remaining node budget (no pre-allocation)', () => {
    // A single array wider than the whole budget must fail in the capacity
    // preflight, before the destination array is allocated
    const wide = Array.from({ length: SPEC_BUDGETS.maxSchemaNodes + 10 }, () => 0);
    expect(() => dereference({ wide })).toThrow(/node budget/u);
  });

  it('preserves an own __proto__ key instead of polluting the accumulator', () => {
    // JSON.parse produces __proto__ as an OWN key; a plain {} accumulator would
    // pollute and drop it. A null-proto accumulator keeps it as a real key so the
    // toolgen dangerous-key guard can reject the operation downstream.
    const input = JSON.parse('{"a":1,"__proto__":{"x":2}}') as Record<string, unknown>;
    const out = dereference(input);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(out['a']).toBe(1);
    // The __proto__ value landed as a real own key, not as out's prototype: a
    // plain {} accumulator would have set getPrototypeOf(out) to the {x:2} value
    // and dropped the own key. The null-proto accumulator keeps the prototype
    // null. (Checking an unrelated second object for an inherited `x` proves
    // nothing — `obj['__proto__'] = v` never pollutes Object.prototype, so a
    // separate object would lack an own `x` either way.)
    expect(Object.getPrototypeOf(out)).toBeNull();
  });

  it('drops a __proto__ body property end-to-end (dereference preserves it, toolgen omits the op)', () => {
    // JSON round-trip so __proto__ is a real own key, exactly as a fetched spec parses.
    const specText = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    // __proto__ is ONLY under properties (never in `required`): so
                    // without the null-proto accumulator it is dropped upstream,
                    // the body becomes a clean object, and the op is EMITTED — a
                    // TRUE differential for the fix. Listing it in `required` too
                    // would omit the op via the unrelated required-not-declared
                    // gate even without the fix, making this test vacuous.
                    properties: { ['__proto__']: { type: 'string' } },
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    });
    const parsedSpec = JSON.parse(specText) as Record<string, unknown>;
    const doc = dereference(parsedSpec);
    const spec = normalizeSpec(doc, '3.0');
    const built = buildTools(assignToolNames(spec.operations), {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: spec.openapiVersion,
    });
    expect(built.tools).toEqual([]);
    expect(built.omitted).toHaveLength(1);
    expect(built.omitted[0]!.path).toBe('/x');
  });
});

// The layered schema graph from issue #89: `schemas` schemas in `layers`
// layers, each referencing `refs` schemas of the next layer; `pathCount` paths
// with a GET and a PUT referencing one schema each
const layeredSpec = (
  schemas: number,
  refs: number,
  pathCount: number,
  layers: number,
): Record<string, unknown> => {
  const perLayer = Math.ceil(schemas / layers);
  const components: Record<string, unknown> = {};
  for (let index = 0; index < schemas; index += 1) {
    const layer = Math.floor(index / perLayer);
    const properties: Record<string, unknown> = {
      id: { type: 'string' },
      name: { type: 'string', maxLength: 64 },
    };
    if (layer < layers - 1) {
      for (let ref = 0; ref < refs; ref += 1) {
        const target = Math.min(schemas - 1, (layer + 1) * perLayer + ((index + ref) % perLayer));
        properties[`rel${ref}`] = { $ref: `#/components/schemas/S${target}` };
      }
    }
    components[`S${index}`] = { type: 'object', required: ['id'], properties };
  }
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < pathCount; index += 1) {
    const schema = { $ref: `#/components/schemas/S${index % schemas}` };
    const ok = { 200: { description: 'ok', content: { 'application/json': { schema } } } };
    paths[`/r${index}`] = {
      get: { operationId: `get${index}`, responses: ok },
      put: {
        operationId: `put${index}`,
        requestBody: { content: { 'application/json': { schema } } },
        responses: ok,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'layered', version: '1' },
    paths,
    components: { schemas: components },
  };
};

describe('dereference — memoization (issue #89)', () => {
  it('returns the same output object for every occurrence of an acyclic $ref', () => {
    const doc = {
      a: { $ref: '#/components/schemas/Pet' },
      b: { list: [{ $ref: '#/components/schemas/Pet' }] },
      components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'string' } } } } },
    };
    const out = dereference(doc) as { a: unknown; b: { list: unknown[] } };
    expect(out.a).toBe(out.b.list[0]);
    expect(out.a).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    // Still a copy: the source document is never handed out
    expect(out.a).not.toBe(doc.components.schemas.Pet);
  });

  it('shares objects across resolve calls of one dereferencer', () => {
    const doc = { x: { $ref: '#/t' }, y: { $ref: '#/t' }, t: { kept: true } };
    const dereferencer = createDereferencer(doc);
    expect(dereferencer.resolve(doc.x)).toBe(dereferencer.resolve(doc.y));
  });

  it('places cycle markers exactly as before when one target is reached under different ancestor stacks', () => {
    // B and C form a cycle; A reaches C directly and through B. Each
    // occurrence must close at the ref that is in progress on ITS stack, so a
    // memoized expansion of a cyclic target would be wrong here.
    const doc = {
      a: { b: { $ref: '#/B' }, c: { $ref: '#/C' } },
      B: { toC: { $ref: '#/C' } },
      C: { toB: { $ref: '#/B' } },
    };
    const out = dereference(doc) as Record<string, Record<string, unknown>>;
    expect(out['a']).toEqual({
      b: { toC: { toB: { $ref: '#/B' } } },
      c: { toB: { toC: { $ref: '#/C' } } },
    });
  });

  it('keeps re-expanding a cyclic target reached twice inside one cycle', () => {
    const doc = {
      B: { left: { $ref: '#/C' }, right: { $ref: '#/C' } },
      C: { back: { $ref: '#/B' }, self: { $ref: '#/C' } },
    };
    const out = dereference(doc) as Record<string, unknown>;
    // The top-level B is a plain key, not a $ref in progress, so the walk
    // from it expands B once more inside C before both close
    const expandedC = {
      back: { left: { $ref: '#/C' }, right: { $ref: '#/C' } },
      self: { $ref: '#/C' },
    };
    // Same output as the unmemoized implementation
    expect(out['B']).toEqual({ left: expandedC, right: expandedC });
  });

  it('keeps self and pass-through cycle markers unchanged', () => {
    const doc = {
      a: { $ref: '#/b' },
      b: { $ref: '#/c' },
      c: { inner: { $ref: '#/b' } },
      node: { next: { $ref: '#/node' } },
    };
    const out = dereference(doc) as Record<string, unknown>;
    expect(out['a']).toEqual({ inner: { $ref: '#/b' } });
    expect(out['node']).toEqual({ next: { next: { $ref: '#/node' } } });
  });

  it('still fails the depth budget when a memoized target is reused deeper than it was first expanded', () => {
    // X0 -> ... -> X39 is first expanded at the top (fits), then reached again
    // through a 30-deep chain, where the full expansion crosses 64 levels
    const doc: Record<string, unknown> = { first: { $ref: '#/X0' }, second: { $ref: '#/Y0' } };
    for (let index = 0; index < 40; index += 1) {
      doc[`X${index}`] = { next: { $ref: `#/X${index + 1}` } };
      doc[`Y${index}`] = { next: { $ref: index < 29 ? `#/Y${index + 1}` : '#/X0' } };
    }
    doc['X40'] = { leaf: true };
    expect(() => dereference(doc)).toThrow(/maximum depth of 64/u);
  });

  it('counts the node budget per unique output node, so shared models no longer trip it', () => {
    // 200 schemas x 2 refs x 8 layers: about 11,000 source nodes, but well
    // over 500,000 once every occurrence is copied — refused before #89
    const spec = layeredSpec(200, 2, 200, 8);
    expect(() => dereference(spec)).not.toThrow();
  });

  it('refuses an exponential DAG by its expanded size without walking it', () => {
    const layers: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) {
      layers[`L${index}`] = {
        left: { $ref: `#/layers/L${index + 1}` },
        right: { $ref: `#/layers/L${index + 1}` },
      };
    }
    layers['L40'] = { leaf: true };
    const started = performance.now();
    expect(() => dereference({ root: { $ref: '#/layers/L0' }, layers })).toThrow(
      `the ${MAX_EXPANDED_NODES}-node budget once shared`,
    );
    // Generous bound: the memoized walk touches about 120 nodes
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('checkRefs and resolveShallow', () => {
  it('accepts a document whose refs all resolve, without expanding anything', () => {
    expect(() => checkRefs(layeredSpec(20, 2, 5, 4))).not.toThrow();
  });

  it('refuses dangling and external refs anywhere in the document, exposed or not', () => {
    expect(() => checkRefs({ unused: { deep: { $ref: '#/missing' } } })).toThrow(
      /does not resolve/u,
    );
    expect(() => checkRefs({ unused: { $ref: 'https://example.com/x.json' } })).toThrow(
      /external/u,
    );
  });

  it('follows a chain of indirections only to the first real node', () => {
    const doc = {
      p: { $ref: '#/q' },
      q: { $ref: '#/r' },
      r: { name: 'id', schema: { $ref: '#/s' } },
      s: { type: 'string' },
      loop: { $ref: '#/loop' },
    };
    expect(resolveShallow(doc, doc.p)).toBe(doc.r);
    expect(resolveShallow(doc, doc.loop)).toEqual({ $ref: '#/loop' });
  });
});

describe('createCycleDetector and collapseCycles', () => {
  it('flags refs on self, mutual and pass-through cycles, and nothing else', () => {
    const doc = {
      self: { next: { $ref: '#/self' } },
      a: { toB: { $ref: '#/b' } },
      b: { toA: { $ref: '#/a' } },
      p: { $ref: '#/q' },
      q: { $ref: '#/p' },
      leaf: { type: 'string' },
      user: { a: { $ref: '#/a' }, leaf: { $ref: '#/leaf' } },
    };
    const isCyclic = createCycleDetector(doc);
    expect(['#/self', '#/a', '#/b', '#/p', '#/q'].map((ref) => isCyclic(ref))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(isCyclic('#/leaf')).toBe(false);
    expect(isCyclic('#/user')).toBe(false);
  });

  it('collapses a cyclic target to its marker at the first occurrence', () => {
    const doc = {
      root: { node: { $ref: '#/Node' }, leaf: { $ref: '#/Leaf' } },
      Node: { next: { $ref: '#/Node' }, leaf: { $ref: '#/Leaf' } },
      Leaf: { type: 'string' },
    };
    const out = createDereferencer(doc, { collapseCycles: true }).resolve(doc.root);
    expect(out).toEqual({ node: { $ref: '#/Node' }, leaf: { type: 'string' } });
  });

  it('keeps a densely cyclic model bounded, where full expansion is exponential', () => {
    // Ten schemas that all reference each other: every path closes a cycle
    // eventually, but expanding until it does visits on the order of 10! nodes
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < 10; index += 1) {
      const properties: Record<string, unknown> = {};
      for (let other = 0; other < 10; other += 1) {
        properties[`to${other}`] = { $ref: `#/components/schemas/S${other}` };
      }
      schemas[`S${index}`] = { type: 'object', properties };
    }
    const doc = { root: { $ref: '#/components/schemas/S0' }, components: { schemas } };
    expect(() => createDereferencer(doc).resolve(doc.root)).toThrow(/node budget/u);
    expect(createDereferencer(doc, { collapseCycles: true }).resolve(doc.root)).toEqual({
      $ref: '#/components/schemas/S0',
    });
  });
});
