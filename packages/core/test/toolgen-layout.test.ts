import { describe, expect, it } from 'vitest';
import { buildLayout, paramFields } from '../src/index.ts';
import type { HttpMethod, OperationRecord } from '../src/index.ts';

const op = (parameters: readonly Record<string, unknown>[]): OperationRecord => ({
  method: 'get' as HttpMethod,
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

// #47: request bodies drop readOnly properties (OAS 3.0.3 / 3.1.1 Schema
// Object: readOnly properties SHOULD NOT be sent in a request, and a
// `required` readOnly property applies to the response only). #35: a
// free-form object field accepts arbitrary keys.
describe('buildLayout — request direction (#35, #47)', () => {
  const userBody = (required: boolean) =>
    jsonBody(
      {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' } },
      },
      required,
    );

  it('drops a required readOnly property from a flattened body', () => {
    const operation = bodyOp(userBody(true));
    const l = layout(buildLayout(operation, new Set()));
    expect(l.mapper.bodyMode).toBe('flattened');
    expect(Object.keys(l.mapper.fields)).toEqual(['name']);
    expect(l.inputSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(l.inputSchema.safeParse({ id: '1', name: 'x' }).success).toBe(false);
  });

  it('does not count a dropped readOnly property in the optional-body group', () => {
    const operation = bodyOp(userBody(false));
    const l = layout(buildLayout(operation, new Set()));
    expect(l.inputSchema.safeParse({}).success).toBe(true);
    expect(l.inputSchema.safeParse({ name: 'x' }).success).toBe(true);
  });

  it('drops nested readOnly properties inside a single (non-flattened) body', () => {
    const body = jsonBody(
      {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name'],
          properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' } },
        },
      },
      true,
    );
    const l = layout(buildLayout(bodyOp(body), new Set()));
    expect(l.mapper.bodyMode).toBe('single');
    expect(l.inputSchema.safeParse({ body: [{ name: 'x' }] }).success).toBe(true);
    expect(l.inputSchema.safeParse({ body: [{ id: '1', name: 'x' }] }).success).toBe(false);
  });

  it('keeps the operation when every body property is readOnly (no body fields)', () => {
    const body = jsonBody(
      { type: 'object', properties: { id: { type: 'string', readOnly: true } } },
      true,
    );
    const l = layout(buildLayout(bodyOp(body), new Set()));
    expect(Object.keys(l.mapper.fields)).toEqual([]);
    expect(l.inputSchema.safeParse({}).success).toBe(true);
  });

  it('exposes a flattened free-form property as an object accepting arbitrary keys', () => {
    const body = jsonBody(
      {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, metadata: { type: 'object' } },
      },
      true,
    );
    const l = layout(buildLayout(bodyOp(body), new Set()));
    const parsed = l.inputSchema.safeParse({ name: 'x', metadata: { env: 'prod', n: 1 } });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>)['metadata']).toEqual({ env: 'prod', n: 1 });
    expect(l.inputSchema.safeParse({ name: 'x', metadata: 'prod' }).success).toBe(false);
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

// #54 / decision D5: every JSON media-type variant is accepted (`+json`
// suffix, parameters), the DECLARED media type is what gets sent, and the
// choice among several variants is deterministic.
describe('buildLayout — JSON media-type variants (#54, D5)', () => {
  const objectSchema = { type: 'object', properties: { name: { type: 'string' } } };
  const withContent = (content: Record<string, unknown>) =>
    buildLayout(bodyOp({ required: true, content }), new Set());

  it.each([
    'application/json; charset=utf-8',
    'application/merge-patch+json',
    'application/vnd.api+json',
    'application/json; profile="https://example.com/p"',
    'Application/JSON',
  ])('exposes a body declared as %s and keeps the declared media type', (key) => {
    const l = layout(withContent({ [key]: { schema: objectSchema } }));
    expect(l.mapper.bodyMode).toBe('flattened');
    expect(l.mapper.bodyContentType).toBe(key);
  });

  it('routes an array-root application/json-patch+json body to the single body field', () => {
    const l = layout(
      withContent({
        'application/json-patch+json': {
          schema: {
            type: 'array',
            items: { type: 'object', properties: { op: { type: 'string' } } },
          },
        },
      }),
    );
    expect(l.mapper.bodyMode).toBe('single');
    expect(l.mapper.bodyContentType).toBe('application/json-patch+json');
  });

  it('prefers exact application/json over any variant, and the parameterless key among application/json keys', () => {
    expect(
      layout(
        withContent({
          'application/merge-patch+json': { schema: objectSchema },
          'application/json': { schema: objectSchema },
        }),
      ).mapper.bodyContentType,
    ).toBe('application/json');
    expect(
      layout(
        withContent({
          'application/json; charset=utf-8': { schema: objectSchema },
          'application/json': { schema: objectSchema },
        }),
      ).mapper.bodyContentType,
    ).toBe('application/json');
  });

  it('picks application/merge-patch+json among the Kubernetes PATCH media types', () => {
    const patch = { schema: { type: 'object', description: 'Patch' } };
    const l = layout(
      withContent({
        'application/apply-patch+yaml': patch,
        'application/json-patch+json': patch,
        'application/merge-patch+json': patch,
        'application/strategic-merge-patch+json': patch,
      }),
    );
    expect(l.mapper.bodyContentType).toBe('application/merge-patch+json');
  });

  it('omits when several JSON variants have no deterministic winner', () => {
    const r = withContent({
      'application/vnd.a+json': { schema: objectSchema },
      'application/vnd.b+json': { schema: objectSchema },
    });
    expect('unrepresentable' in r && r.unrepresentable).toMatch(/several JSON media types/u);
  });

  it.each([
    'text/plain',
    'application/json;',
    'application/json; charset',
    'application/json\r\nX-Evil: 1',
    'application/jsonx',
  ])('still omits a non-JSON or malformed media type key %j', (key) => {
    expect('unrepresentable' in withContent({ [key]: { schema: objectSchema } })).toBe(true);
  });

  it.each([
    'application/x-www-form-urlencoded; charset=utf-8',
    'application/x-www-form-urlencoded;charset="UTF-8"',
    'Application/X-WWW-Form-Urlencoded',
  ])('exposes a form body declared as %j and keeps the declared media type', (key) => {
    const l = layout(withContent({ [key]: { schema: objectSchema } }));
    expect(l.mapper.bodyMode).toBe('flattened');
    expect(l.mapper.bodyContentType).toBe(key);
  });

  it('prefers the bare form key over a parameterised one', () => {
    const l = layout(
      withContent({
        'application/x-www-form-urlencoded; charset=utf-8': { schema: objectSchema },
        'application/x-www-form-urlencoded': { schema: objectSchema },
      }),
    );
    expect(l.mapper.bodyContentType).toBe('application/x-www-form-urlencoded');
  });

  it.each([
    'application/x-www-form-urlencoded; charset=iso-8859-1',
    'application/x-www-form-urlencoded; charset=utf-8; foo=bar',
  ])('omits a form key %j whose parameters the UTF-8 encoder cannot honour', (key) => {
    expect('unrepresentable' in withContent({ [key]: { schema: objectSchema } })).toBe(true);
  });
});

// #59: query styles beyond `form` (OAS 3.1.1 §4.8.12.3 Style Values,
// §4.8.12.4 Style Examples). Only the combinations the spec defines are
// accepted; every `n/a` cell of the examples table still omits.
describe('paramFields — deepObject / spaceDelimited / pipeDelimited (#59)', () => {
  const query = (extra: Record<string, unknown>) =>
    paramFields(op([{ name: 'created', in: 'query', ...extra }]), new Set());
  const scalarObject = {
    type: 'object',
    properties: { gt: { type: 'integer' }, lte: { type: 'integer' } },
  };

  it('accepts deepObject + explode:true on an object of scalars', () => {
    const [field] = okFields(query({ style: 'deepObject', explode: true, schema: scalarObject }));
    expect(field?.mapping).toEqual({
      destination: 'query',
      wireName: 'created',
      style: 'deepObject',
      explode: true,
      required: false,
    });
  });

  it('accepts a free-form deepObject (JSON:API-style filter[...])', () => {
    expect('ok' in query({ style: 'deepObject', explode: true, schema: { type: 'object' } })).toBe(
      true,
    );
  });

  it.each([
    [
      'deepObject without explode (spec default false: n/a)',
      { style: 'deepObject', schema: scalarObject },
    ],
    [
      'deepObject with explode:false',
      { style: 'deepObject', explode: false, schema: scalarObject },
    ],
    [
      'deepObject with a nested object property',
      {
        style: 'deepObject',
        explode: true,
        schema: { type: 'object', properties: { range: { type: 'object' } } },
      },
    ],
    [
      'deepObject with an array property',
      {
        style: 'deepObject',
        explode: true,
        schema: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
        },
      },
    ],
    [
      'deepObject on a scalar schema',
      { style: 'deepObject', explode: true, schema: { type: 'string' } },
    ],
    [
      'pipeDelimited with explode:true',
      {
        style: 'pipeDelimited',
        explode: true,
        schema: { type: 'array', items: { type: 'string' } },
      },
    ],
    ['spaceDelimited on a scalar schema', { style: 'spaceDelimited', schema: { type: 'string' } }],
    [
      'pipeDelimited on an array of objects',
      { style: 'pipeDelimited', schema: { type: 'array', items: { type: 'object' } } },
    ],
  ])('still omits %s', (_label, extra) => {
    expect('unrepresentable' in query(extra)).toBe(true);
  });

  it.each(['spaceDelimited', 'pipeDelimited'])(
    'accepts %s (explode default false) on an array of scalars',
    (style) => {
      const [field] = okFields(
        query({ style, schema: { type: 'array', items: { type: 'string' } } }),
      );
      expect(field?.mapping).toMatchObject({ style, explode: false });
    },
  );

  it('omits deepObject outside query (header)', () => {
    expect(
      'unrepresentable' in
        paramFields(
          op([
            { name: 'x', in: 'header', style: 'deepObject', explode: true, schema: scalarObject },
          ]),
          new Set(),
        ),
    ).toBe(true);
  });
});
