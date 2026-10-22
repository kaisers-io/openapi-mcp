import { describe, expect, it } from 'vitest';
import {
  deepObjectValue,
  fieldOf,
  hintValue,
  linkValue,
} from '../src/toolgen/pagination-values.ts';

const FORM = { style: 'form', explode: true } as const;

// Direct coverage of how a pagination hint value is typed and decoded
// (issue #86 floors): the schema shapes zod emits for optional/nullable
// fields, and body cursors that arrive as JSON numbers or booleans.
describe('fieldOf', () => {
  it('unwraps a nullable anyOf to its single non-null branch', () => {
    const schema = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
    expect(fieldOf('page', schema, FORM)).toEqual({ field: 'page', kind: 'number' });
  });

  it('treats an anyOf with several non-null branches as unsupported', () => {
    const schema = { anyOf: [{ type: 'integer' }, { type: 'boolean' }] };
    expect(fieldOf('page', schema, FORM)).toEqual({ field: 'page', kind: 'unsupported' });
  });

  it('reads an untyped schema as a string field', () => {
    expect(fieldOf('cursor', { description: 'opaque' }, FORM)).toEqual({
      field: 'cursor',
      kind: 'string',
    });
  });

  it('reads an array of scalars with its explode flag, and rejects a non-schema', () => {
    const schema = { type: 'array', items: { type: 'integer' } };
    expect(fieldOf('ids', schema, { style: 'form', explode: false })).toEqual({
      field: 'ids',
      kind: 'array',
      items: 'number',
      explode: false,
      delimiter: ',',
    });
    expect(fieldOf('ids', 'not a schema', FORM)).toEqual({ field: 'ids', kind: 'unsupported' });
  });

  it('records the delimiter of a space/pipe-delimited array, and never decodes a delimited object', () => {
    const array = { type: 'array', items: { type: 'string' } };
    const object = { type: 'object', properties: { a: { type: 'string' } } };
    const piped = { style: 'pipeDelimited', explode: false } as const;
    expect(fieldOf('ids', array, piped)).toMatchObject({ kind: 'array', delimiter: '|' });
    expect(fieldOf('ids', array, { style: 'spaceDelimited', explode: false })).toMatchObject({
      kind: 'array',
      delimiter: ' ',
    });
    expect(fieldOf('ids', object, piped)).toEqual({ field: 'ids', kind: 'unsupported' });
    expect(fieldOf('ids', { type: 'string' }, piped)).toEqual({
      field: 'ids',
      kind: 'unsupported',
    });
  });

  it('reads a deepObject as its declared scalar properties only', () => {
    const deep = { style: 'deepObject', explode: true } as const;
    const schema = {
      anyOf: [
        {
          type: 'object',
          properties: {
            number: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: { type: 'string' },
        },
        { type: 'null' },
      ],
    };
    expect(fieldOf('page', schema, deep)).toEqual({
      field: 'page',
      kind: 'object',
      properties: { number: 'number' },
    });
    // Free-form: no declared key a link could be checked against.
    expect(fieldOf('page', { type: 'object' }, deep)).toEqual({
      field: 'page',
      kind: 'unsupported',
    });
  });
});

describe('hintValue — a body cursor given as a JSON number or boolean', () => {
  const number = { field: 'page', kind: 'number' } as const;
  const text = { field: 'cursor', kind: 'string' } as const;
  const flag = { field: 'more', kind: 'boolean' } as const;

  it('keeps a number for a number field and stringifies it for a string field', () => {
    expect(hintValue(3, number)).toBe(3);
    expect(hintValue(3, text)).toBe('3');
  });

  it('never turns a number into a boolean, nor a boolean into anything else', () => {
    expect(hintValue(1, flag)).toBeUndefined();
    expect(hintValue(true, flag)).toBe(true);
    expect(hintValue(true, text)).toBeUndefined();
    expect(hintValue(true, number)).toBeUndefined();
  });

  it('refuses non-finite numbers and values for array or unsupported fields', () => {
    expect(hintValue(Number.POSITIVE_INFINITY, number)).toBeUndefined();
    expect(
      hintValue('x', {
        field: 'ids',
        kind: 'array',
        items: 'string',
        explode: true,
        delimiter: ',',
      }),
    ).toBeUndefined();
    expect(hintValue('x', { field: 'f', kind: 'unsupported' })).toBeUndefined();
    expect(
      hintValue('x', { field: 'f', kind: 'object', properties: { a: 'string' } }),
    ).toBeUndefined();
  });
});

describe('linkValue', () => {
  it('decodes text booleans and refuses a repeated scalar parameter', () => {
    const flag = { field: 'more', kind: 'boolean' } as const;
    expect(linkValue(['false'], flag)).toBe(false);
    expect(linkValue(['yes'], flag)).toBeUndefined();
    expect(linkValue(['true', 'true'], flag)).toBeUndefined();
  });

  it('never decodes a deepObject field from its bare name', () => {
    expect(linkValue(['2'], { field: 'page', kind: 'object', properties: {} })).toBeUndefined();
  });
});

describe('deepObjectValue', () => {
  const page = { field: 'page', kind: 'object', properties: { number: 'number' } } as const;

  it('decodes a declared key per its kind, once', () => {
    expect(deepObjectValue(['2'], page, 'number')).toBe(2);
    expect(deepObjectValue(['2', '3'], page, 'number')).toBeUndefined();
    expect(deepObjectValue(['two'], page, 'number')).toBeUndefined();
  });

  it('refuses an undeclared or inherited key, and a non-object field', () => {
    expect(deepObjectValue(['2'], page, 'size')).toBeUndefined();
    expect(deepObjectValue(['2'], page, 'constructor')).toBeUndefined();
    expect(deepObjectValue(['2'], { field: 'page', kind: 'number' }, 'number')).toBeUndefined();
  });
});
