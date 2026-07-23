import { describe, expect, it } from 'vitest';
import { buildLayout, paramFields, type HttpMethod, type OperationRecord } from '../src/index.ts';

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

const bodyOp = (
  requestBody: Record<string, unknown> | undefined,
  parameters: readonly Record<string, unknown>[] = [],
): OperationRecord => ({
  method: 'post' as HttpMethod,
  path: '/x',
  tags: [],
  deprecated: false,
  parameters,
  ...(requestBody === undefined ? {} : { requestBody }),
  responses: {},
});

const jsonBody = (schema: Record<string, unknown>, required = false): Record<string, unknown> => ({
  ...(required ? { required: true } : {}),
  content: { 'application/json': { schema } },
});

const layout = (r: ReturnType<typeof buildLayout>) => {
  if (!('ok' in r)) throw new Error(`unrepresentable: ${r.unrepresentable}`);
  return r.ok;
};

describe('buildLayout — body classification', () => {
  it('flattens a closed non-empty object body', () => {
    const l = layout(
      buildLayout(
        bodyOp(
          jsonBody(
            {
              type: 'object',
              properties: { total: { type: 'integer' }, note: { type: 'string' } },
              required: ['total'],
            },
            true,
          ),
        ),
        new Set(),
      ),
    );
    expect(l.mapper.bodyMode).toBe('flattened');
    expect(l.mapper.bodyContentType).toBe('application/json');
    expect(l.mapper.fields['total']).toEqual({
      destination: 'body',
      bodyPath: ['total'],
      required: true,
    });
    expect(l.mapper.fields['note']).toEqual({
      destination: 'body',
      bodyPath: ['note'],
      required: false,
    });
    expect(l.inputSchema.safeParse({ total: 1, note: 'x' }).success).toBe(true);
    expect(l.inputSchema.safeParse({ note: 'x' }).success).toBe(false);
    expect(l.inputSchema.safeParse({ total: 1, extra: 9 }).success).toBe(false);
  });

  it('does NOT flatten an object body carrying an unsupported keyword — omits it', () => {
    // The root `not` must not be bypassed by flattening (root-schema validation).
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(
            jsonBody(
              {
                type: 'object',
                properties: { a: { type: 'string' } },
                not: {},
              },
              true,
            ),
          ),
          new Set(),
        ),
    ).toBe(true);
  });

  it('omits a flattened body whose required name is not a declared property', () => {
    // The flatten path iterates declared properties; a required name with no
    // property would silently lose the constraint. Omit instead.
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(
            jsonBody(
              {
                type: 'object',
                properties: { a: { type: 'string' } },
                required: ['missing'],
              },
              true,
            ),
          ),
          new Set(),
        ),
    ).toBe(true);
  });

  it('omits a flattened body with a malformed required array', () => {
    // The flatten path bypasses convertSchema on the root, so bodyFields must
    // validate the root `required` itself: a non-string element or a duplicate is
    // an invalid Schema Object and omits (fail-closed, round-12), not silently
    // filtered as objectSchema's convertSchema path would otherwise do.
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(
            jsonBody(
              {
                type: 'object',
                properties: { a: { type: 'string' } },
                required: [123],
              },
              true,
            ),
          ),
          new Set(),
        ),
    ).toBe(true);
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(
            jsonBody(
              {
                type: 'object',
                properties: { a: { type: 'string' } },
                required: ['a', 'a'],
              },
              true,
            ),
          ),
          new Set(),
        ),
    ).toBe(true);
  });

  it('wraps an array-root body in a single body field', () => {
    const l = layout(
      buildLayout(bodyOp(jsonBody({ type: 'array', items: { type: 'string' } }, true)), new Set()),
    );
    expect(l.mapper.bodyMode).toBe('single');
    expect(l.mapper.fields['body']).toEqual({ destination: 'body', bodyPath: [], required: true });
    expect(l.inputSchema.safeParse({ body: ['a'] }).success).toBe(true);
    expect(l.inputSchema.safeParse({}).success).toBe(false);
  });

  it('wraps an open object body (additionalProperties true) as single body', () => {
    const l = layout(
      buildLayout(
        bodyOp(
          jsonBody({
            type: 'object',
            additionalProperties: true,
            properties: { a: { type: 'string' } },
          }),
        ),
        new Set(),
      ),
    );
    expect(l.mapper.bodyMode).toBe('single');
  });

  it('omits a body with a malformed additionalProperties (not flattened, not silently ignored)', () => {
    // additionalProperties:7 is neither absent/false nor true/schema; it must not be
    // silently ignored by flattening. isFlattenableRoot routes it to the single-body
    // path, where convertSchema omits it (round-14).
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(
            jsonBody(
              {
                type: 'object',
                properties: { a: { type: 'string' } },
                additionalProperties: 7,
              },
              true,
            ),
          ),
          new Set(),
        ),
    ).toBe(true);
  });

  it('reports bodyMode none with no request body', () => {
    const l = layout(buildLayout(bodyOp(undefined), new Set()));
    expect(l.mapper.bodyMode).toBe('none');
    expect(l.mapper.bodyContentType).toBeUndefined();
  });

  it('omits on an unsupported media type', () => {
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp({
            required: true,
            content: { 'multipart/form-data': { schema: { type: 'object' } } },
          }),
          new Set(),
        ),
    ).toBe(true);
  });

  it('omits a form-urlencoded body with an encoding object', () => {
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp({
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: { type: 'object', properties: { a: { type: 'string' } } },
                encoding: { a: { style: 'form' } },
              },
            },
          }),
          new Set(),
        ),
    ).toBe(true);
  });

  it('does NOT flatten a 3.1 nullable object body — wraps it as single body', () => {
    // type ['object','null'] is not a plain object root; flattening would lose
    // the null alternative, so it routes to the single `body` field.
    const l = layout(
      buildLayout(
        bodyOp(
          jsonBody({ type: ['object', 'null'], properties: { id: { type: 'string' } } }, true),
        ),
        new Set(),
      ),
    );
    expect(l.mapper.bodyMode).toBe('single');
    expect(l.inputSchema.safeParse({ body: null }).success).toBe(true);
    expect(l.inputSchema.safeParse({ body: { id: 'a' } }).success).toBe(true);
  });

  it('omits an operation with a prototype-hazardous field name', () => {
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(undefined, [{ name: '__proto__', in: 'query', schema: { type: 'string' } }]),
          new Set(),
        ),
    ).toBe(true);
  });
});

describe('buildLayout — collisions and optional body', () => {
  it('prefixes colliding names by location', () => {
    const l = layout(
      buildLayout(
        bodyOp(
          jsonBody(
            { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            true,
          ),
          [{ name: 'id', in: 'query', schema: { type: 'string' } }],
        ),
        new Set(),
      ),
    );
    expect(Object.keys(l.mapper.fields).toSorted()).toEqual(['body_id', 'query_id']);
    expect(l.mapper.fields['body_id']).toEqual({
      destination: 'body',
      bodyPath: ['id'],
      required: true,
    });
    expect(l.mapper.fields['query_id']?.destination).toBe('query');
  });

  it('omits when a prefixed name still collides', () => {
    // A query param literally named `query_id` plus a query `id` → both want
    // query_id after prefixing (id collides with a body id) → residual collision.
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(
            jsonBody(
              { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
              true,
            ),
            [
              { name: 'id', in: 'query', schema: { type: 'string' } },
              { name: 'query_id', in: 'query', schema: { type: 'string' } },
            ],
          ),
          new Set(),
        ),
    ).toBe(true);
  });

  it('enforces the optional-body all-or-nothing rule', () => {
    const l = layout(
      buildLayout(
        bodyOp(
          jsonBody(
            {
              type: 'object',
              properties: { id: { type: 'string' }, note: { type: 'string' } },
              required: ['id'],
            },
            false,
          ),
        ),
        new Set(),
      ),
    );
    expect(l.inputSchema.safeParse({}).success).toBe(true);
    expect(l.inputSchema.safeParse({ id: 'a', note: 'b' }).success).toBe(true);
    expect(l.inputSchema.safeParse({ id: 'a' }).success).toBe(true);
    expect(l.inputSchema.safeParse({ note: 'b' }).success).toBe(false);
  });
});
