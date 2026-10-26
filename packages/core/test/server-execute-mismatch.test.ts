import { describe, expect, it } from 'vitest';
import { compileEnvelopeValidator, createRedactor } from '../src/index.ts';
import type { MapResponseOptions, PinnedOutcome } from '../src/index.ts';
import { mapResponse, mismatchOf } from '../src/server/execute/response.ts';
import { formatCallLog } from '../src/server/telemetry.ts';
import { compactOutputSchema } from '../src/toolgen/output-schema.ts';

// Why a response was refused, for the operator's call log only (issue #24):
// built from the schema and JSON type names, never from response data

const SECRET = 'example-token-not-a-secret-24';

const envelopeOf = (data: Record<string, unknown>, status = 200) => ({
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { const: status },
        contentType: { const: 'application/json' },
        data,
        // As generated: forwarded headers join the envelope
        headers: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['status', 'contentType', 'data'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        status: { const: 404 },
        contentType: { const: 'application/json' },
        data: { type: 'object' },
      },
      required: ['status', 'contentType', 'data'],
      additionalProperties: false,
    },
  ],
});

const encoder = new TextEncoder();
const response = (body: string | Uint8Array, status = 200, contentType = 'application/json') =>
  ({
    kind: 'response',
    status,
    contentType,
    bodyBytes: typeof body === 'string' ? encoder.encode(body) : body,
    headers: {},
    url: 'https://api.example.test/',
  }) satisfies PinnedOutcome;

const USER = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    owner: {
      type: 'object',
      properties: { email: { type: 'string' }, login: { type: 'string' } },
      required: ['login'],
    },
    items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
  },
  additionalProperties: false,
};

const refuse = (
  outputSchema: Record<string, unknown>,
  body: string | Uint8Array,
  overrides: Partial<MapResponseOptions> = {},
) => {
  const outcome = mapResponse({
    outcome: response(body, overrides.outcome?.kind === 'response' ? 200 : 200),
    validator: compileEnvelopeValidator(outputSchema),
    outputSchema,
    redactor: createRedactor([SECRET]),
    maxTextBytes: 4096,
    diagnose: true,
    ...overrides,
  });
  expect(outcome.isError).toBe(true);
  return { outcome, mismatch: mismatchOf(outcome) };
};

describe('response mismatch diagnostics (#24)', () => {
  it('names the keyword, the data path and both types of a type failure', () => {
    const { mismatch } = refuse(
      envelopeOf(USER),
      JSON.stringify({ owner: { email: null, login: 'a' } }),
    );
    expect(mismatch).toStrictEqual({
      category: 'schema',
      keyword: 'type',
      path: '/owner/email',
      expected: 'string',
      observed: 'null',
    });
  });

  it('names a missing required property by the schema, and an array element as *', () => {
    expect(refuse(envelopeOf(USER), JSON.stringify({ owner: {} })).mismatch).toStrictEqual({
      category: 'schema',
      keyword: 'required',
      path: '/owner/login',
    });
    expect(
      refuse(envelopeOf(USER), JSON.stringify({ items: [{ id: 'a' }, { id: 7 }] })).mismatch,
    ).toMatchObject({
      keyword: 'type',
      path: '/items/*/id',
      expected: 'string',
      observed: 'integer',
    });
  });

  // A response that carries a configured secret is withheld before it is
  // validated; these canaries are response data the redactor does not know
  it('never shows an extra key, an index or any value from the response', () => {
    const body = JSON.stringify({ 'dynamic-key-canary': 1, owner: { login: 'value-canary' } });
    const { outcome, mismatch } = refuse(envelopeOf(USER), body);
    expect(mismatch).toStrictEqual({
      category: 'schema',
      keyword: 'additionalProperties',
      path: '',
    });
    const line = formatCallLog(
      { tool: 't', outcome: 'response_error', latencyMs: 1, ...(mismatch ? { mismatch } : {}) },
      createRedactor([SECRET]),
      new Date(0),
    );
    expect(line).toContain(
      '"mismatch":{"category":"schema","keyword":"additionalProperties","path":""}',
    );
    for (const text of [line, JSON.stringify(outcome)]) {
      expect(text).not.toContain('canary');
    }
  });

  it('redacts a configured secret used as a property name in the spec, before cutting it', () => {
    const name = `${'x'.repeat(50)}${SECRET}`;
    const named = { type: 'object', properties: { [name]: { type: 'string' } }, required: [name] };
    const { mismatch } = refuse(envelopeOf(named), '{}');
    expect(mismatch).toMatchObject({ keyword: 'required' });
    expect(JSON.stringify(mismatch)).not.toContain(SECRET.slice(0, 8));
    expect(mismatch?.path?.length).toBeLessThanOrEqual(65);
  });

  // Review of #24: a secret longer than any cut is redacted whole first
  it('redacts a long secret used as a property name before anything is cut', () => {
    const long = `example-long-secret-${'s'.repeat(5000)}`;
    const named = { type: 'object', properties: { [long]: { type: 'string' } }, required: [long] };
    const outputSchema = envelopeOf(named);
    const outcome = mapResponse({
      outcome: response('{}'),
      validator: compileEnvelopeValidator(outputSchema),
      outputSchema,
      redactor: createRedactor([long]),
      maxTextBytes: 4096,
      diagnose: true,
    });
    const mismatch = mismatchOf(outcome);
    expect(mismatch).toMatchObject({ keyword: 'required' });
    expect(JSON.stringify(mismatch)).not.toContain('example-long-secret');
  });

  // Review of #24: forwarded headers rebuild the outcome, the reason stays
  it('keeps the reason when the response forwards headers', () => {
    const outputSchema = envelopeOf(USER);
    const outcome = mapResponse({
      outcome: {
        ...response(JSON.stringify({ id: 'x' })),
        headers: { 'x-ratelimit-remaining': '9' },
      },
      validator: compileEnvelopeValidator(outputSchema),
      outputSchema,
      redactor: createRedactor([]),
      maxTextBytes: 4096,
      baseUrl: 'https://api.example.test/',
      diagnose: true,
    });
    expect(JSON.stringify(outcome)).toContain('x-ratelimit-remaining');
    expect(mismatchOf(outcome)).toMatchObject({ keyword: 'type', path: '/id' });
  });

  it('escapes / and ~ in names and keeps % as written', () => {
    const named = { type: 'object', properties: { 'a/b~c%': { type: 'string' } } };
    expect(refuse(envelopeOf(named), JSON.stringify({ 'a/b~c%': 1 })).mismatch).toMatchObject({
      path: '/a~1b~0c%',
    });
  });

  it('gives no path through a $ref, where the schema path cannot prove one', () => {
    const repeated = {
      type: 'object',
      properties: Object.fromEntries(
        ['name', 'street', 'city', 'country', 'zip'].map((key) => [key, { type: 'string' }]),
      ),
    };
    const compact = compactOutputSchema(
      envelopeOf({
        type: 'object',
        properties: { a: repeated, b: repeated, c: repeated },
      }),
    );
    const { mismatch } = refuse(compact, JSON.stringify({ a: { name: 1 } }));
    expect(mismatch).toMatchObject({ category: 'schema', keyword: 'type' });
    expect(mismatch).not.toHaveProperty('path');
  });

  it('reports a failed union as its keyword', () => {
    const union = {
      type: 'object',
      properties: { value: { oneOf: [{ type: 'string' }, { type: 'boolean' }] } },
    };
    expect(refuse(envelopeOf(union), JSON.stringify({ value: 3 })).mismatch).toMatchObject({
      category: 'schema',
      path: '/value',
    });
  });

  it('walks every schema keyword that leads into the data, and gives up on the others', () => {
    const cases: [Record<string, unknown>, unknown, Record<string, unknown>][] = [
      [
        { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
        { 'x-a': 1 },
        { path: '/*', expected: 'string', observed: 'integer' },
      ],
      [
        { type: 'array', prefixItems: [{ type: 'boolean' }] },
        [1.5],
        { path: '/*', expected: 'boolean', observed: 'number' },
      ],
      [{ allOf: [{ properties: { a: { type: 'string' } } }] }, { a: true }, { path: '/a' }],
      [{ not: { type: 'object' } }, {}, { keyword: 'not', path: '' }],
      [
        { type: 'object', dependentSchemas: { a: { properties: { b: { type: 'string' } } } } },
        { a: 1, b: 2 },
        { keyword: 'type' },
      ],
      [
        { type: 'object', dependentRequired: { a: ['b'] } },
        { a: 1 },
        { keyword: 'other', path: '' },
      ],
      [
        { type: ['string', 'null'] },
        false,
        { path: '', expected: 'string|null', observed: 'boolean' },
      ],
    ];
    for (const [data, body, expected] of cases) {
      const { mismatch } = refuse(envelopeOf(data), JSON.stringify(body));
      expect(mismatch).toMatchObject({ category: 'schema', ...expected });
      if (!('path' in expected)) {
        expect(mismatch).not.toHaveProperty('path');
      }
    }
  });

  it('leaves out a path longer than 256 characters', () => {
    let data: Record<string, unknown> = { type: 'string' };
    let body: unknown = 1;
    for (let level = 0; level < 6; level += 1) {
      const name = `${String(level)}${'n'.repeat(60)}`;
      data = { type: 'object', properties: { [name]: data } };
      body = { [name]: body };
    }
    const { mismatch } = refuse(envelopeOf(data), JSON.stringify(body));
    expect(mismatch).toMatchObject({ keyword: 'type' });
    expect(mismatch).not.toHaveProperty('path');
  });

  it('names the category of a response that never reached validation', () => {
    const schema = envelopeOf(USER);
    const options = { validator: compileEnvelopeValidator(schema), outputSchema: schema };
    const categoryOf = (outcome: PinnedOutcome) =>
      mismatchOf(
        mapResponse({
          outcome,
          ...options,
          redactor: createRedactor([]),
          maxTextBytes: 4096,
          diagnose: true,
        }),
      );
    expect(categoryOf(response('{not json'))).toStrictEqual({ category: 'invalid_json' });
    const notUtf8 = response(new Uint8Array([0xff, 0xfe]));
    expect(categoryOf(notUtf8)).toStrictEqual({ category: 'invalid_utf8' });
    expect(categoryOf(response('{}', 201))).toStrictEqual({ category: 'unmatched_branch' });
    expect(categoryOf(response('{}', 200, 'text/csv'))).toStrictEqual({
      category: 'unmatched_branch',
    });
  });

  it('works the same for a projected call', () => {
    const { mismatch } = refuse(envelopeOf(USER), JSON.stringify({ owner: { login: 1 } }), {
      fields: ['/owner/login'],
    });
    expect(mismatch).toMatchObject({ keyword: 'type', path: '/owner/login' });
  });

  it('computes nothing, and answers the client the same, without diagnose', () => {
    const schema = envelopeOf(USER);
    const body = JSON.stringify({ owner: { email: null, login: 'a' } });
    const on = refuse(schema, body);
    const off = refuse(schema, body, { diagnose: false });
    expect(off.mismatch).toBeUndefined();
    expect(off.outcome).toStrictEqual(on.outcome);
  });

  it('keeps each call to a shared validator to its own errors', () => {
    const schema = envelopeOf(USER);
    const validator = compileEnvelopeValidator(schema);
    const run = (body: string) =>
      mismatchOf(
        mapResponse({
          outcome: response(body),
          validator,
          outputSchema: schema,
          redactor: createRedactor([]),
          maxTextBytes: 4096,
          diagnose: true,
        }),
      );
    expect(run(JSON.stringify({ id: 'x' }))).toMatchObject({ path: '/id' });
    expect(run(JSON.stringify({ owner: {} }))).toMatchObject({ path: '/owner/login' });
    expect(run(JSON.stringify({ id: 1 }))).toBeUndefined();
  });
});
