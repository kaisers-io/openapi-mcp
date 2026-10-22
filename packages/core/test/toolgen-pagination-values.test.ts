import { describe, expect, it } from 'vitest';
import { fieldOf, hintValue, linkValue } from '../src/toolgen/pagination-values.ts';

// Direct coverage of how a pagination hint value is typed and decoded
// (issue #86 floors): the schema shapes zod emits for optional/nullable
// fields, and body cursors that arrive as JSON numbers or booleans.
describe('fieldOf', () => {
  it('unwraps a nullable anyOf to its single non-null branch', () => {
    const schema = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
    expect(fieldOf('page', schema, true)).toEqual({ field: 'page', kind: 'number' });
  });

  it('treats an anyOf with several non-null branches as unsupported', () => {
    const schema = { anyOf: [{ type: 'integer' }, { type: 'boolean' }] };
    expect(fieldOf('page', schema, true)).toEqual({ field: 'page', kind: 'unsupported' });
  });

  it('reads an untyped schema as a string field', () => {
    expect(fieldOf('cursor', { description: 'opaque' }, true)).toEqual({
      field: 'cursor',
      kind: 'string',
    });
  });

  it('reads an array of scalars with its explode flag, and rejects a non-schema', () => {
    const schema = { type: 'array', items: { type: 'integer' } };
    expect(fieldOf('ids', schema, false)).toEqual({
      field: 'ids',
      kind: 'array',
      items: 'number',
      explode: false,
    });
    expect(fieldOf('ids', 'not a schema', true)).toEqual({ field: 'ids', kind: 'unsupported' });
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
      hintValue('x', { field: 'ids', kind: 'array', items: 'string', explode: true }),
    ).toBeUndefined();
    expect(hintValue('x', { field: 'f', kind: 'unsupported' })).toBeUndefined();
  });
});

describe('linkValue', () => {
  it('decodes text booleans and refuses a repeated scalar parameter', () => {
    const flag = { field: 'more', kind: 'boolean' } as const;
    expect(linkValue(['false'], flag)).toBe(false);
    expect(linkValue(['yes'], flag)).toBeUndefined();
    expect(linkValue(['true', 'true'], flag)).toBeUndefined();
  });
});
