import { describe, expect, it } from 'vitest';
import { factorRepeatedSubschemas } from '../src/toolgen/compact-schema.ts';
import { compactOutputSchema } from '../src/toolgen/output-schema.ts';
import { compileEnvelopeValidator } from '../src/index.ts';
import type { EnvelopeValidator } from '../src/index.ts';

// Issue #9: --output-schema defs emits repeated subschemas once under
// `$defs`. The compact form must validate exactly what the inline one does.

type Node = Record<string, unknown>;

// Resolves every `#/$defs/...` reference back into place
const inline = (node: unknown, defs: Node): unknown => {
  if (Array.isArray(node)) {
    return node.map((item) => inline(item, defs));
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Node;
    const ref = record['$ref'];
    if (typeof ref === 'string' && Object.keys(record).length === 1) {
      return inline(defs[ref.slice('#/$defs/'.length)], defs);
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== '$defs')
        .map(([key, value]) => [key, inline(value, defs)]),
    );
  }
  return node;
};

const address = (): Node => ({
  type: 'object',
  properties: {
    street: { type: 'string', description: 'Street and number' },
    city: { type: 'string', description: 'City name' },
    zip: { type: 'string', pattern: '^[0-9]{5}$' },
  },
  required: ['street', 'city'],
});

const customer = (): Node => ({
  type: 'object',
  properties: {
    id: { type: 'integer' },
    billing: address(),
    shipping: address(),
    previous: { type: 'array', items: address() },
  },
  required: ['id', 'billing'],
});

describe('factorRepeatedSubschemas', () => {
  it('returns the input itself when nothing repeats', () => {
    const schema = { type: 'object', properties: { id: { type: 'integer' } } };
    expect(factorRepeatedSubschemas(schema)).toBe(schema);
  });

  it('emits a repeated subschema once and references it', () => {
    const schema = customer();
    const compact = factorRepeatedSubschemas(schema);
    expect(Object.keys(compact['$defs'] as Node)).toEqual(['d0']);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(schema).length);
    expect(JSON.stringify(compact).match(/"\$ref":"#\/\$defs\/d0"/gu)).toHaveLength(3);
    expect(inline(compact, compact['$defs'] as Node)).toEqual(schema);
  });

  it('validates exactly like the inline schema', () => {
    const envelope = (data: Node): Node => ({
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: { status: { const: 200 }, contentType: { const: 'application/json' }, data },
          required: ['status', 'contentType', 'data'],
          additionalProperties: false,
        },
      ],
    });
    const schema = envelope(customer());
    const inlineValidate = compileEnvelopeValidator(schema) as EnvelopeValidator;
    const compactValidate = compileEnvelopeValidator(
      factorRepeatedSubschemas(schema),
    ) as EnvelopeValidator;
    const place = { street: 'Main 1', city: 'X', zip: '12345' };
    const samples = [
      { id: 1, billing: place },
      { id: 1, billing: place, shipping: place, previous: [place, place] },
      { id: 1, billing: { street: 'Main 1' } },
      { id: 1, billing: place, previous: [{ ...place, zip: 'abc' }] },
      { billing: place },
    ];
    for (const data of samples) {
      const value = { status: 200, contentType: 'application/json', data };
      expect(compactValidate(value)).toBe(inlineValidate(value));
    }
  });

  it('never rewrites instance values under enum, const, default or examples', () => {
    const value = address();
    const schema = {
      type: 'object',
      properties: {
        a: address(),
        b: address(),
        c: { enum: [value] },
        d: { const: value },
        e: { type: 'object', default: value, examples: [value] },
      },
    };
    const compact = factorRepeatedSubschemas(schema);
    const properties = compact['properties'] as Record<string, Node>;
    expect(properties['a']).toEqual({ $ref: '#/$defs/d0' });
    expect(properties['c']).toEqual({ enum: [value] });
    expect(properties['d']).toEqual({ const: value });
    expect(properties['e']).toEqual({ type: 'object', default: value, examples: [value] });
  });

  it('leaves a schema that already uses references or identifiers unchanged', () => {
    for (const extra of [{ $ref: '#/x' }, { $id: 'https://example.test/s' }, { $anchor: 'a' }]) {
      const schema = {
        ...customer(),
        properties: { ...(customer()['properties'] as Node), x: extra },
      };
      expect(factorRepeatedSubschemas(schema)).toBe(schema);
    }
  });

  it('keeps pinned nodes inline and defines only what is referenced at least twice', () => {
    const first = address();
    const schema = { type: 'object', properties: { a: first, b: address() } };
    expect(factorRepeatedSubschemas(schema, new Set([first]))).toBe(schema);
    // Address repeats only inside the repeated customer: one definition, not two
    const nested = { type: 'object', properties: { x: customer(), y: customer() } };
    const compact = factorRepeatedSubschemas(nested);
    expect(inline(compact, compact['$defs'] as Node)).toEqual(nested);
    const text = JSON.stringify(compact);
    for (const name of Object.keys(compact['$defs'] as Node)) {
      expect(text.split(`"#/$defs/${name}"`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('compactOutputSchema', () => {
  it('keeps the envelope branches and their status/contentType consts inline', () => {
    const branch = (status: number): Node => ({
      type: 'object',
      properties: {
        status: { const: status },
        contentType: { const: 'application/json' },
        data: customer(),
      },
      required: ['status', 'contentType', 'data'],
      additionalProperties: false,
    });
    const schema = { type: 'object', oneOf: [branch(200), branch(201)] };
    const compact = compactOutputSchema(schema);
    const branches = compact['oneOf'] as Node[];
    for (const [index, status] of [200, 201].entries()) {
      const properties = branches[index]?.['properties'] as Node;
      expect(properties['status']).toEqual({ const: status });
      expect(properties['contentType']).toEqual({ const: 'application/json' });
      expect(properties['data']).toEqual({ $ref: '#/$defs/d0' });
    }
    expect(inline(compact, compact['$defs'] as Node)).toEqual(schema);
  });
});
