import { describe, expect, it } from 'vitest';
import { outputFieldsOf } from '../src/server/output-fields.ts';

// The compact field list describe_operation returns for `_fields` (issue #49)

const envelope = (data: Record<string, unknown>) => ({
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { const: 200 },
        contentType: { const: 'application/json' },
        data,
      },
    },
  ],
});

describe('outputFieldsOf (#49)', () => {
  it('lists pointers with their types, every top-level field before a nested one', () => {
    const data = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          owner: { type: 'object', properties: { login: { type: 'string' } } },
          id: { type: 'integer', description: 'left out' },
          'a/b~c': { type: ['string', 'null'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    };
    expect(outputFieldsOf(envelope(data))).toStrictEqual([
      {
        status: 200,
        contentType: 'application/json',
        fields: [
          '/*: object',
          '/*/owner: object',
          '/*/id: integer',
          '/*/a~1b~0c: string|null',
          '/*/tags: array',
          '/*/owner/login: string',
          '/*/tags/*: string',
        ],
      },
    ]);
  });

  it('merges the fields of allOf, anyOf and oneOf variants once each', () => {
    const data = {
      allOf: [{ properties: { id: { type: 'string' } } }],
      anyOf: [{ properties: { id: { type: 'string' }, name: { type: 'string' } } }],
    };
    expect(outputFieldsOf(envelope(data))[0]?.fields).toStrictEqual([
      '/id: string',
      '/name: string',
    ]);
  });

  // Review of #49: a union inside a union keeps its fields
  it('unfolds nested unions', () => {
    const data = {
      anyOf: [
        {
          anyOf: [
            { type: 'object', properties: { id: { type: 'string' } } },
            { type: 'object', properties: { name: { type: 'string' } } },
          ],
        },
        { type: 'null' },
      ],
    };
    expect(outputFieldsOf(envelope(data))).toStrictEqual([
      { status: 200, contentType: 'application/json', fields: ['/id: string', '/name: string'] },
    ]);
  });

  it('says so when unions nest deeper than it unfolds', () => {
    let data: Record<string, unknown> = {
      type: 'object',
      properties: { id: { type: 'string' } },
    };
    for (let level = 0; level < 9; level += 1) {
      data = { anyOf: [data] };
    }
    expect(outputFieldsOf(envelope(data))[0]).toMatchObject({ fields: [], truncated: true });
  });

  // Review of #49: a union that types one field differently lists every type
  it('lists every type a union gives one field', () => {
    const data = {
      anyOf: [
        { type: 'object', properties: { value: { type: 'string' } } },
        { type: 'object', properties: { value: { type: 'integer' } } },
      ],
    };
    expect(outputFieldsOf(envelope(data))[0]?.fields).toStrictEqual(['/value: string|integer']);
  });

  // Review of #49: a field typed by its own composition
  it('reads a field type from anyOf and oneOf members', () => {
    const data = {
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        maybe: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        list: { items: { type: 'string' } },
        free: {},
      },
    };
    expect(outputFieldsOf(envelope(data))[0]?.fields).toStrictEqual([
      '/value: string|integer',
      '/maybe: object|null',
      '/list: array',
      '/free: any',
      '/list/*: string',
    ]);
  });

  // Review of #49: a very wide schema must not be copied into a queue whole
  it('lists a schema with 130,000 nested fields within its limits', () => {
    const wide = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 130_000 }, (_unused, index) => [
              `f${String(index)}`,
              { type: 'string' },
            ]),
          ),
        },
      },
    };
    const [listed] = outputFieldsOf(envelope(wide));
    expect(listed?.fields).toHaveLength(150);
    expect(listed?.fields[0]).toBe('/nested: object');
    expect(listed?.truncated).toBe(true);
  });

  // A union left folded at the composition limit does not hide the rest
  it('keeps listing deeper levels after a folded union', () => {
    let folded: Record<string, unknown> = { type: 'object', properties: { x: { type: 'string' } } };
    for (let level = 0; level < 9; level += 1) {
      folded = { anyOf: [folded] };
    }
    const data = {
      type: 'object',
      properties: {
        folded,
        owner: { type: 'object', properties: { login: { type: 'string' } } },
      },
    };
    expect(outputFieldsOf(envelope(data))[0]).toMatchObject({
      fields: ['/folded: any', '/owner: object', '/owner/login: string'],
      truncated: true,
    });
  });

  it('stops two levels deep and at 150 fields, and says so', () => {
    const deep = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: { b: { type: 'object', properties: { c: { type: 'string' } } } },
        },
      },
    };
    const [cut] = outputFieldsOf(envelope(deep));
    expect(cut?.fields).toStrictEqual(['/a: object', '/a/b: object']);
    // Review of #49: fields below the depth limit make the list incomplete
    expect(cut?.truncated).toBe(true);
    const wide = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_unused, index) => [`f${String(index)}`, { type: 'string' }]),
      ),
    };
    const [listed] = outputFieldsOf(envelope(wide));
    expect(listed?.fields).toHaveLength(150);
    expect(listed?.truncated).toBe(true);
  });

  it('skips branches without a data schema', () => {
    expect(outputFieldsOf({ oneOf: [{ properties: { status: { const: 204 } } }] })).toStrictEqual(
      [],
    );
    expect(outputFieldsOf({})).toStrictEqual([]);
  });
});
