import { describe, expect, it } from 'vitest';
import { paramFields, type HttpMethod, type OperationRecord } from '../src/index.ts';

const op = (parameters: readonly Record<string, unknown>[]): OperationRecord => ({
  method: 'get' as HttpMethod,
  path: '/x',
  tags: [],
  deprecated: false,
  parameters,
  responses: {},
});

const okFields = (r: ReturnType<typeof paramFields>) => {
  if (!('ok' in r)) throw new Error(`unrepresentable: ${r.unrepresentable}`);
  return r.ok;
};

describe('paramFields', () => {
  it('captures path/query/header with style, explode, required', () => {
    const fields = okFields(
      paramFields(
        op([
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'x-trace', in: 'header', schema: { type: 'string' } },
        ]),
        new Set(),
      ),
    );
    const byName = Object.fromEntries(fields.map((f) => [f.preferred, f.mapping]));
    expect(byName['id']).toEqual({
      destination: 'path',
      wireName: 'id',
      style: 'simple',
      explode: false,
      required: true,
    });
    expect(byName['tag']).toEqual({
      destination: 'query',
      wireName: 'tag',
      style: 'form',
      explode: true,
      required: false,
    });
    expect(byName['x-trace']).toEqual({
      destination: 'header',
      wireName: 'x-trace',
      style: 'simple',
      explode: false,
      required: false,
    });
  });

  it('carries the parameter-level description into the field schema', () => {
    const fields = okFields(
      paramFields(
        op([{ name: 'q', in: 'query', description: 'the query', schema: { type: 'string' } }]),
        new Set(),
      ),
    );
    expect(fields[0]!.schema.description).toBe('the query');
  });

  it('drops reserved header params (case-insensitive)', () => {
    // paramFields drops a header iff its lowercased name is in the passed set;
    // it has no built-in set. The caller (Task 5) passes SYSTEM_HEADERS ∪ auth names.
    const fields = okFields(
      paramFields(
        op([
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
          { name: 'X-API-Key', in: 'header', schema: { type: 'string' } },
          { name: 'keep', in: 'query', schema: { type: 'string' } },
        ]),
        new Set(['authorization', 'x-api-key']),
      ),
    );
    expect(fields.map((f) => f.preferred)).toEqual(['keep']);
  });

  it('validates a reserved header BEFORE dropping it (owner decision, round-15)', () => {
    // A reserved header is injected, not a tool input, but it is still fully
    // validated: a malformed/unsupported reserved-header param omits the operation
    // rather than being silently discarded. A wrong-version exclusive bound:
    expect(
      'unrepresentable' in
        paramFields(
          op([
            {
              name: 'Authorization',
              in: 'header',
              schema: { type: 'number', exclusiveMinimum: true },
            },
          ]),
          new Set(['authorization']),
          '3.1',
        ),
    ).toBe(true);
    // An unsupported style on the reserved header:
    expect(
      'unrepresentable' in
        paramFields(
          op([
            {
              name: 'Authorization',
              in: 'header',
              style: 'deepObject',
              schema: { type: 'object' },
            },
          ]),
          new Set(['authorization']),
        ),
    ).toBe(true);
    // allowReserved on the reserved header:
    expect(
      'unrepresentable' in
        paramFields(
          op([
            {
              name: 'Authorization',
              in: 'header',
              allowReserved: true,
              schema: { type: 'string' },
            },
          ]),
          new Set(['authorization']),
        ),
    ).toBe(true);
    // A VALID reserved header is still dropped (not exposed), leaving other fields.
    expect(
      okFields(
        paramFields(
          op([
            { name: 'Authorization', in: 'header', schema: { type: 'string' } },
            { name: 'keep', in: 'query', schema: { type: 'string' } },
          ]),
          new Set(['authorization']),
        ),
      ).map((f) => f.preferred),
    ).toEqual(['keep']);
  });

  it('omits on an unsupported style', () => {
    expect(
      'unrepresentable' in
        paramFields(
          op([{ name: 'ids', in: 'query', style: 'deepObject', schema: { type: 'object' } }]),
          new Set(),
        ),
    ).toBe(true);
  });

  it('omits on allowReserved', () => {
    expect(
      'unrepresentable' in
        paramFields(
          op([{ name: 'q', in: 'query', allowReserved: true, schema: { type: 'string' } }]),
          new Set(),
        ),
    ).toBe(true);
  });

  it('omits on an unrepresentable param schema', () => {
    expect(
      'unrepresentable' in
        paramFields(op([{ name: 'q', in: 'query', schema: { not: {} } }]), new Set()),
    ).toBe(true);
  });

  it('omits on a case-insensitive duplicate header', () => {
    // X-Test and x-test target the same HTTP header (case-insensitive).
    expect(
      'unrepresentable' in
        paramFields(
          op([
            { name: 'X-Test', in: 'header', schema: { type: 'string' } },
            { name: 'x-test', in: 'header', schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
    // A query `X` and header `x` do NOT collide (different locations).
    expect(
      'ok' in
        paramFields(
          op([
            { name: 'X', in: 'query', schema: { type: 'string' } },
            { name: 'x', in: 'header', schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });
});
