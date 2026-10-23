import { describe, expect, it } from 'vitest';
import { admitNullProperties } from '../src/toolgen/nullable-fields.ts';
import { compileEnvelopeValidator } from '../src/index.ts';
import type { EnvelopeValidator } from '../src/index.ts';

// Issue #3: the JSON Schema transform behind --nullable-response-fields, on
// hand-written schemas covering keywords the converter does not emit today
// (`$defs`/`$ref`, tuples, `if`, boolean schemas), so the walk stays sound if
// it ever does.

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const validatorOf = (schema: Record<string, unknown>): EnvelopeValidator =>
  compileEnvelopeValidator(admitNullProperties(deepFreeze(schema))) as EnvelopeValidator;

describe('admitNullProperties', () => {
  it('returns the input itself when there is nothing to widen', () => {
    const schema = deepFreeze({ type: 'array', items: { type: 'string' } });
    expect(admitNullProperties(schema)).toBe(schema);
  });

  it('never mutates its (frozen) input and caches by source node', () => {
    const shared = { type: 'object', properties: { url: { type: 'string' } } };
    const schema = deepFreeze({ type: 'object', properties: { a: shared, b: shared } });
    const before = JSON.stringify(schema);
    const widened = admitNullProperties(schema) as {
      properties: Record<string, unknown>;
    };
    expect(JSON.stringify(schema)).toBe(before);
    expect(widened.properties['a']).toBe(widened.properties['b']);
    expect(admitNullProperties(schema)).toBe(widened);
  });

  it('follows $defs and wraps a $ref property', () => {
    const validate = validatorOf({
      $defs: { image: { type: 'object', properties: { url: { type: 'string' } } } },
      type: 'object',
      properties: { logo: { $ref: '#/$defs/image' } },
    });
    expect(validate({ logo: null })).toBe(true);
    expect(validate({ logo: { url: null } })).toBe(true);
    expect(validate({ logo: { url: 1 } })).toBe(false);
  });

  it('walks tuple items, prefixItems and oneOf members without widening them', () => {
    const member = { type: 'object', properties: { n: { type: 'integer' } } };
    const validate = validatorOf({
      type: 'object',
      properties: {
        pair: { type: 'array', prefixItems: [member] },
        one: { oneOf: [member, { type: 'string' }] },
      },
    });
    expect(validate({ pair: [{ n: null }], one: { n: null } })).toBe(true);
    expect(validate({ pair: [null] })).toBe(false);
  });

  it('walks a draft-07 tuple `items` array the same way', () => {
    const member = { type: 'object', properties: { n: { type: 'integer' } } };
    const widened = admitNullProperties(deepFreeze({ type: 'array', items: [member, true] })) as {
      items: [{ properties: { n: unknown } }, unknown];
    };
    expect(widened.items[0].properties.n).toEqual({ type: ['integer', 'null'] });
    expect(widened.items[1]).toBe(true);
  });

  it('keeps const, enum and if constraints while admitting null beside them', () => {
    const validate = validatorOf({
      type: 'object',
      properties: {
        fixed: { const: 'x' },
        kind: { enum: ['a', 'b'] },
        // oxlint-disable-next-line unicorn/no-thenable -- `then` is the JSON Schema keyword here
        gated: { if: { type: 'string' }, then: { minLength: 2 } },
      },
    });
    expect(validate({ fixed: null, kind: null, gated: null })).toBe(true);
    expect(validate({ fixed: 'y' })).toBe(false);
    expect(validate({ kind: 'c' })).toBe(false);
    expect(validate({ gated: 'a' })).toBe(false);
  });

  it('leaves properties that already admit null, and boolean schemas, as they are', () => {
    const properties = {
      none: { const: null },
      either: { enum: ['a', null] },
      union: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      typed: { type: ['integer', 'null'] },
      free: { description: 'anything' },
      open: true,
      closed: false,
    };
    const schema = deepFreeze({ type: 'object', properties });
    expect(admitNullProperties(schema)).toBe(schema);
  });

  it('wraps a property whose anyOf admits no null, and one carrying a type next to anyOf', () => {
    const validate = validatorOf({
      type: 'object',
      properties: {
        union: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        mixed: { type: 'null', anyOf: [{ minimum: 1 }] },
      },
    });
    expect(validate({ union: null, mixed: null })).toBe(true);
    expect(validate({ union: true })).toBe(false);
  });
});

// Issue #17: scope `optional` leaves the properties an object requires strict.
describe('admitNullProperties — optional scope (#17)', () => {
  const optionalValidatorOf = (schema: Record<string, unknown>): EnvelopeValidator =>
    compileEnvelopeValidator(
      admitNullProperties(deepFreeze(schema), 'optional'),
    ) as EnvelopeValidator;

  const order = {
    type: 'object',
    required: ['id', 'customer'],
    properties: {
      id: { type: 'string' },
      note: { type: 'string' },
      customer: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, email: { type: 'string' } },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sku'],
          properties: { sku: { type: 'string' }, gift: { type: 'boolean' } },
        },
      },
    },
  };
  const valid = { id: '1', customer: { name: 'a' } };

  it('admits null only where the object does not require the key', () => {
    const validate = optionalValidatorOf(order);
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, note: null, items: null })).toBe(true);
    expect(validate({ ...valid, customer: { name: 'a', email: null } })).toBe(true);
    expect(validate({ ...valid, items: [{ sku: 'x', gift: null }] })).toBe(true);
    expect(validate({ ...valid, id: null })).toBe(false);
    expect(validate({ ...valid, customer: null })).toBe(false);
    expect(validate({ ...valid, customer: { name: null } })).toBe(false);
    expect(validate({ ...valid, items: [{ sku: null }] })).toBe(false);
  });

  it('widens a superset of nothing and a subset of the all scope', () => {
    const all = compileEnvelopeValidator(
      admitNullProperties(deepFreeze(order)),
    ) as EnvelopeValidator;
    const optional = optionalValidatorOf(order);
    const samples = [
      valid,
      { ...valid, note: null },
      { ...valid, id: null },
      { ...valid, customer: { name: null } },
      { ...valid, id: 1 },
    ];
    for (const sample of samples) {
      if (optional(sample)) {
        expect(all(sample)).toBe(true);
      }
    }
    expect(all({ ...valid, id: null })).toBe(true);
  });

  it('keeps one cache per scope', () => {
    const schema = deepFreeze({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    });
    const optional = admitNullProperties(schema, 'optional');
    const all = admitNullProperties(schema, 'all');
    expect(optional).toBe(schema);
    expect(all).not.toBe(schema);
    expect(admitNullProperties(schema, 'optional')).toBe(optional);
    expect(admitNullProperties(schema)).toBe(all);
  });

  it('treats a key required only by a sibling allOf member as optional', () => {
    const validate = optionalValidatorOf({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', required: ['a'] },
      ],
    });
    expect(validate({ a: null })).toBe(true);
    expect(validate({})).toBe(false);
  });
});
