import { describe, expect, it } from 'vitest';
import { buildLayout, paramFields } from '../src/index.ts';
import type { OperationRecord } from '../src/index.ts';

const op = (parameters: readonly Record<string, unknown>[]): OperationRecord => ({
  method: 'get',
  path: '/x',
  tags: [],
  deprecated: false,
  parameters,
  responses: {},
});

const okFields = (r: ReturnType<typeof paramFields>) => {
  if (!('ok' in r)) {
    throw new Error(`unrepresentable: ${r.unrepresentable}`);
  }
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
    // it has no built-in set. The caller passes SYSTEM_HEADERS ∪ auth names.
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

  it('validates a reserved header BEFORE dropping it', () => {
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
    const fields = okFields(
      paramFields(
        op([
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
          { name: 'keep', in: 'query', schema: { type: 'string' } },
        ]),
        new Set(['authorization']),
      ),
    );
    expect(fields.map((f) => f.preferred)).toEqual(['keep']);
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
  method: 'post',
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
  if (!('ok' in r)) {
    throw new Error(`unrepresentable: ${r.unrepresentable}`);
  }
  return r.ok;
};

describe('buildLayout — body classification', () => {
  it('flattens a closed non-empty object body', () => {
    const body = jsonBody(
      {
        type: 'object',
        properties: { total: { type: 'integer' }, note: { type: 'string' } },
        required: ['total'],
      },
      true,
    );
    const l = layout(buildLayout(bodyOp(body), new Set()));
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
    const body = jsonBody(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        not: {},
      },
      true,
    );
    expect('unrepresentable' in buildLayout(bodyOp(body), new Set())).toBe(true);
  });

  it('omits a flattened body whose required name is not a declared property', () => {
    // The flatten path iterates declared properties; a required name with no
    // property would silently lose the constraint. Omit instead.
    const body = jsonBody(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['missing'],
      },
      true,
    );
    expect('unrepresentable' in buildLayout(bodyOp(body), new Set())).toBe(true);
  });

  it('omits a flattened body with a malformed required array', () => {
    // The flatten path bypasses convertSchema on the root, so bodyFields must
    // validate the root `required` itself: a non-string element or a duplicate is
    // an invalid Schema Object and omits (fail-closed), not silently filtered
    // as objectSchema's convertSchema path would otherwise do.
    const nonStringBody = jsonBody(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: [123],
      },
      true,
    );
    expect('unrepresentable' in buildLayout(bodyOp(nonStringBody), new Set())).toBe(true);
    const duplicateBody = jsonBody(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'a'],
      },
      true,
    );
    expect('unrepresentable' in buildLayout(bodyOp(duplicateBody), new Set())).toBe(true);
  });

  it('wraps an array-root body in a single body field', () => {
    const body = jsonBody({ type: 'array', items: { type: 'string' } }, true);
    const l = layout(buildLayout(bodyOp(body), new Set()));
    expect(l.mapper.bodyMode).toBe('single');
    expect(l.mapper.fields['body']).toEqual({ destination: 'body', bodyPath: [], required: true });
    expect(l.inputSchema.safeParse({ body: ['a'] }).success).toBe(true);
    expect(l.inputSchema.safeParse({}).success).toBe(false);
  });

  it('wraps an open object body (additionalProperties true) as single body', () => {
    const body = jsonBody({
      type: 'object',
      additionalProperties: true,
      properties: { a: { type: 'string' } },
    });
    const l = layout(buildLayout(bodyOp(body), new Set()));
    expect(l.mapper.bodyMode).toBe('single');
  });

  it('omits a body with a malformed additionalProperties (not flattened, not silently ignored)', () => {
    // additionalProperties:7 is neither absent/false nor true/schema; it must not be
    // silently ignored by flattening. isFlattenableRoot routes it to the single-body
    // path, where convertSchema omits it.
    const body = jsonBody(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: 7,
      },
      true,
    );
    expect('unrepresentable' in buildLayout(bodyOp(body), new Set())).toBe(true);
  });

  it('reports bodyMode none with no request body', () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- bodyOp's requestBody is a required (non-optional) parameter; dropping the argument changes call arity and fails to type-check (TS2554)
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
    const body = jsonBody(
      { type: ['object', 'null'], properties: { id: { type: 'string' } } },
      true,
    );
    const l = layout(buildLayout(bodyOp(body), new Set()));
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
    const body = jsonBody(
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      true,
    );
    const l = layout(
      buildLayout(
        bodyOp(body, [{ name: 'id', in: 'query', schema: { type: 'string' } }]),
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
    const body = jsonBody(
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      true,
    );
    expect(
      'unrepresentable' in
        buildLayout(
          bodyOp(body, [
            { name: 'id', in: 'query', schema: { type: 'string' } },
            { name: 'query_id', in: 'query', schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });

  it('enforces the optional-body all-or-nothing rule', () => {
    const body = jsonBody(
      {
        type: 'object',
        properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id'],
      },
      false,
    );
    const l = layout(buildLayout(bodyOp(body), new Set()));
    expect(l.inputSchema.safeParse({}).success).toBe(true);
    expect(l.inputSchema.safeParse({ id: 'a', note: 'b' }).success).toBe(true);
    expect(l.inputSchema.safeParse({ id: 'a' }).success).toBe(true);
    expect(l.inputSchema.safeParse({ note: 'b' }).success).toBe(false);
  });
});

const pathOp = (
  path: string,
  parameters: readonly Record<string, unknown>[] = [],
): OperationRecord => ({ ...bodyOp(undefined, parameters), path });

describe('buildLayout — path template consistency', () => {
  it('is representable when the placeholder set matches the path-param set exactly', () => {
    const l = layout(
      buildLayout(
        pathOp('/pets/{petId}', [
          { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
        ]),
        new Set(),
      ),
    );
    expect(l.mapper.fields['petId']).toEqual({
      destination: 'path',
      wireName: 'petId',
      style: 'simple',
      explode: false,
      required: true,
    });
  });

  it('omits when a placeholder has no matching path parameter', () => {
    expect('unrepresentable' in buildLayout(pathOp('/pets/{petId}', []), new Set())).toBe(true);
  });

  it('omits when a path parameter has no matching placeholder', () => {
    expect(
      'unrepresentable' in
        buildLayout(
          pathOp('/pets', [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });

  it.each([['/pets/{petId'], ['/pets/{}'], ['/a/{}/b'], ['/pets/{{petId}}']])(
    'omits on a malformed placeholder brace: %s',
    (path) => {
      expect(
        'unrepresentable' in
          buildLayout(
            pathOp(path, [
              { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            ]),
            new Set(),
          ),
      ).toBe(true);
    },
  );

  it.each([
    ['/a/../b'],
    ['/a/%2e%2e/b'],
    ['/a/%2E%2E/b'],
    ['/a/%2F/b'],
    ['/a/%5C/b'],
    ['/a/./b'],
    // A static `?`/`#` baked into the path template is dangerous once
    // decoded — joinFinalUrl (executor.ts) assembles the final URL by
    // string concatenation of the built pathname + `?` + query, so a
    // decoded `?`/`#` here could truncate/inject the real query string or
    // smuggle a fragment into path text.
    ['/a/%3F/b'], // Decoded: "?"
    ['/a/%23/b'], // Decoded: "#"
    ['/a/?abc/b'], // A literal "?" needs no percent-encoding to reach this check
    ['/a/abc#/b'], // A literal "#" likewise
  ])('omits an operation with a dangerous static path segment: %s', (path) => {
    expect('unrepresentable' in buildLayout(pathOp(path, []), new Set())).toBe(true);
  });

  it('does not flag a static segment that merely contains dots or slashes when decoded safely', () => {
    // "a..b" and "a%2Fb"-free segments are ordinary literal text — only an EXACT
    // "." / ".." decode, or a decoded "/" or "\", is dangerous.
    const l = layout(buildLayout(pathOp('/a..b/c', []), new Set()));
    expect(l.mapper.bodyMode).toBe('none');
  });

  it('omits an operation with a malformed percent-encoding in a static segment', () => {
    // decodeURIComponent throws on an incomplete escape ("%" with no following
    // two hex digits) — that must fail closed too, not bubble the exception.
    expect('unrepresentable' in buildLayout(pathOp('/a/%/b', []), new Set())).toBe(true);
  });

  it('omits a mixed segment where static text baked AROUND a placeholder decodes to a traversal', () => {
    // "/x/{id}%2F..%2Fadmin" is ONE segment ("{id}%2F..%2Fadmin"). It contains
    // "{" so a guard that skips any segment with a placeholder never validates
    // it — its literal "%2F..%2Fadmin" would reach the wire and decode at the
    // origin to "/../admin". Stripping the "{id}" run first must still catch it.
    expect(
      'unrepresentable' in
        buildLayout(
          pathOp('/x/{id}%2F..%2Fadmin', [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });

  it('omits a mixed segment whose static remainder decodes to exactly ".."', () => {
    expect(
      'unrepresentable' in
        buildLayout(
          pathOp('/a/{id}%2e%2e', [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });

  it('omits a mixed segment with an encoded backslash in the static remainder', () => {
    expect(
      'unrepresentable' in
        buildLayout(
          pathOp('/x/{id}%5Cthing', [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });

  it('still allows a mixed segment whose static suffix is safe (does not over-block)', () => {
    // A normal mixed segment like "{id}.json" must remain representable — the
    // fix strips only the placeholder run, not the whole segment.
    const l = layout(
      buildLayout(
        pathOp('/files/{id}.json', [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ]),
        new Set(),
      ),
    );
    expect(l.mapper.fields['id']?.destination).toBe('path');
  });

  it('omits on a lone closing brace with no opener (malformed, no "{" anywhere)', () => {
    // Binds the pathPlaceholders branch for a bare "}" that never saw an
    // opening "{" — distinct from the unclosed/empty/nested cases above.
    expect(
      'unrepresentable' in
        buildLayout(
          pathOp('/pets/petId}', [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });
});
