import { describe, expect, it } from 'vitest';
import { compileEnvelopeValidator, deriveOutputSchema } from '../src/index.ts';
import type { EnvelopeValidator, OperationRecord } from '../src/index.ts';

const op = (responses: Record<string, unknown>): OperationRecord => ({
  method: 'get',
  path: '/things',
  tags: [],
  deprecated: false,
  parameters: [],
  responses,
});

describe('deriveOutputSchema — the object-envelope', () => {
  it('builds an object-root oneOf envelope over every 2xx JSON branch', () => {
    const schema = deriveOutputSchema(
      op({
        '200': { content: { 'application/json': { schema: { type: 'string' } } } },
        '201': { content: { 'application/json': { schema: { type: 'integer' } } } },
      }),
      '3.1',
    ) as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    const branches = schema['oneOf'] as Record<string, unknown>[];
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch['type']).toBe('object');
      expect(branch['additionalProperties']).toBe(false);
      expect(branch['required']).toEqual(['status', 'contentType', 'data']);
      const properties = branch['properties'] as Record<string, unknown>;
      expect((properties['contentType'] as { const: string }).const).toBe('application/json');
    }
    const statuses = branches.map(
      (branch) =>
        ((branch['properties'] as Record<string, unknown>)['status'] as { const: number }).const,
    );
    expect(statuses.toSorted()).toEqual([200, 201]);
  });

  it('omits the whole outputSchema when a 2xx response has no representable JSON content (fail-closed)', () => {
    // 204 No Content: no `content` at all — the envelope cannot uniformly
    // represent every success branch, so the WHOLE outputSchema is omitted
    // (the tool still generates; it just returns text content only).
    const schema = deriveOutputSchema(
      op({
        '200': { content: { 'application/json': { schema: { type: 'string' } } } },
        '204': { description: 'no content' },
      }),
      '3.1',
    );
    expect(schema).toBeUndefined();
  });

  it('omits when a 2xx response schema is unrepresentable', () => {
    const schema = deriveOutputSchema(
      op({ '200': { content: { 'application/json': { schema: { not: { type: 'string' } } } } } }),
      '3.1',
    );
    expect(schema).toBeUndefined();
  });

  it('returns undefined when there is no documented 2xx response at all', () => {
    expect(deriveOutputSchema(op({ '404': { description: 'not found' } }), '3.1')).toBeUndefined();
  });

  it('returns undefined for a 4xx carrying JSON content — success is concrete 2xx ONLY (A1 fail-closed regression guard)', () => {
    // Unlike the content-less 404 above (which short-circuits on the missing
    // `content` guard), this 4xx DOES carry a representable application/json
    // body, reaching the content-shape checks — nothing but the status number
    // distinguishes it from a real 2xx. The result must still be NO envelope,
    // because SUCCESS_STATUS_RE admits only /^2\d\d$/. Widening that regex to
    // accept a 4xx would emit a branch labelling a 404 as a success (status
    // const 404), a silent structuredContent mismatch at runtime; this guard is
    // what forbids it (the "success = concrete numeric 2xx only" property).
    expect(
      deriveOutputSchema(
        op({ '404': { content: { 'application/json': { schema: { type: 'string' } } } } }),
        '3.1',
      ),
    ).toBeUndefined();
  });

  it('omits the whole outputSchema when a "2XX" wildcard status RANGE is documented alongside a concrete 200 (fail-closed: the range may cover an undocumented success we cannot represent)', () => {
    const schema = deriveOutputSchema(
      op({
        '200': { content: { 'application/json': { schema: { type: 'string' } } } },
        '2XX': { description: 'any other success' },
      }),
      '3.1',
    );
    expect(schema).toBeUndefined();
  });

  it('omits the whole outputSchema when a "default" response is documented (it may cover an undocumented success status)', () => {
    const schema = deriveOutputSchema(
      op({
        '200': { content: { 'application/json': { schema: { type: 'string' } } } },
        default: { description: 'fallback' },
      }),
      '3.1',
    );
    expect(schema).toBeUndefined();
  });

  it('omits the whole outputSchema when a success response has a non-JSON sibling media type (content negotiation could return text/plain instead)', () => {
    const schema = deriveOutputSchema(
      op({
        '200': {
          content: {
            'application/json': { schema: { type: 'string' } },
            'text/plain': { schema: { type: 'string' } },
          },
        },
      }),
      '3.1',
    );
    expect(schema).toBeUndefined();
  });

  it('omits the whole outputSchema when a success response documents TWO JSON media types (e.g. application/json AND application/problem+json) — fail-closed: content negotiation could return either, and they may carry different schemas', () => {
    // Both are JSON, so a guard that only checked "every content key is
    // JSON" (jsonKeys.length === contentKeys.length) would pass here and
    // silently advertise ONLY the first (application/json)'s schema — even
    // though application/problem+json documents a DIFFERENT, distinct
    // object schema that could just as well be what is actually returned.
    const schema = deriveOutputSchema(
      op({
        '200': {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
            },
            'application/problem+json': {
              schema: { type: 'object', properties: { title: { type: 'string' } } },
            },
          },
        },
      }),
      '3.1',
    );
    expect(schema).toBeUndefined();
  });

  it("accepts a JSON-variant media type like application/problem+json as a success's sole content", () => {
    const schema = deriveOutputSchema(
      op({ '200': { content: { 'application/problem+json': { schema: { type: 'string' } } } } }),
      '3.1',
    ) as Record<string, unknown>;
    const branch = (schema['oneOf'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const properties = branch['properties'] as Record<string, unknown>;
    expect((properties['contentType'] as { const: string }).const).toBe('application/problem+json');
  });

  it('lets `data` be a non-object schema (array/scalar) — the envelope is what makes that object-rootable', () => {
    const schema = deriveOutputSchema(
      op({
        '200': {
          content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
        },
      }),
      '3.1',
    ) as Record<string, unknown>;
    const branch = (schema['oneOf'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const data = (branch['properties'] as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >;
    expect(data['type']).toBe('array');
  });

  it('omits when a 2xx response value is not an object (malformed spec)', () => {
    expect(deriveOutputSchema(op({ '200': 'not-a-response-object' }), '3.1')).toBeUndefined();
  });

  it("omits when a 2xx response's content-map entry is not an object (malformed spec)", () => {
    const schema = deriveOutputSchema(
      op({ '200': { content: { 'application/json': 'not-an-entry-object' } } }),
      '3.1',
    );
    expect(schema).toBeUndefined();
  });
});

// #33 / #47: response schemas are converted in RESPONSE mode — validated with
// the same Ajv2020 path the server uses at runtime.
describe('deriveOutputSchema — response-mode conversion (#33, #47)', () => {
  const validatorFor = (schema: Record<string, unknown>): EnvelopeValidator => {
    const outputSchema = deriveOutputSchema(
      op({ '200': { content: { 'application/json': { schema } } } }),
      '3.1',
    );
    if (outputSchema === undefined) {
      throw new Error('expected an outputSchema');
    }
    return compileEnvelopeValidator(outputSchema) as EnvelopeValidator;
  };
  const envelope = (data: unknown) => ({ status: 200, contentType: 'application/json', data });

  it('accepts an undocumented field when additionalProperties is absent', () => {
    const validate = validatorFor({ type: 'object', properties: { id: { type: 'string' } } });
    expect(validate(envelope({ id: 'a', created: 1 }))).toBe(true);
    // Documented constraints still apply.
    expect(validate(envelope({ id: 1 }))).toBe(false);
  });

  it('still rejects extra fields when additionalProperties:false is explicit', () => {
    const validate = validatorFor({
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string' } },
    });
    expect(validate(envelope({ id: 'a', created: 1 }))).toBe(false);
  });

  it('opens nested objects, array items and oneOf/anyOf members alike', () => {
    const validate = validatorFor({
      type: 'object',
      properties: {
        owner: { type: 'object', properties: { id: { type: 'string' } } },
        list: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } },
        one: { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }] },
        any: {
          anyOf: [
            { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
            { type: 'string' },
          ],
        },
      },
    });
    expect(
      validate(
        envelope({
          owner: { id: 'o', x: 1 },
          list: [{ n: 1, x: 2 }],
          one: { a: 'a', x: 3 },
          any: { b: 'b', x: 4 },
        }),
      ),
    ).toBe(true);
  });

  it('keeps the envelope itself closed', () => {
    const validate = validatorFor({ type: 'object', properties: { id: { type: 'string' } } });
    expect(validate({ ...envelope({ id: 'a' }), extra: true })).toBe(false);
  });

  it('validates a response that omits a required writeOnly property; readOnly stays required', () => {
    const validate = validatorFor({
      type: 'object',
      required: ['id', 'password'],
      properties: {
        id: { type: 'string', readOnly: true },
        password: { type: 'string', writeOnly: true },
      },
    });
    expect(validate(envelope({ id: 'a' }))).toBe(true);
    expect(validate(envelope({}))).toBe(false);
  });
});

describe('deriveOutputSchema — oneOf exclusivity (#43)', () => {
  it('advertises oneOf and rejects data matching more than one branch', () => {
    const outputSchema = deriveOutputSchema(
      op({
        '200': {
          content: {
            'application/json': {
              schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
            },
          },
        },
      }),
      '3.1',
    ) as Record<string, unknown>;
    const branch = (outputSchema['oneOf'] as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    const { data } = branch['properties'] as Record<string, Record<string, unknown>>;
    expect(Array.isArray(data?.['oneOf'])).toBe(true);
    const validate = compileEnvelopeValidator(outputSchema) as EnvelopeValidator;
    const envelope = (value: unknown) => ({
      status: 200,
      contentType: 'application/json',
      data: value,
    });
    expect(validate(envelope(3.5))).toBe(true);
    expect(validate(envelope(3))).toBe(false);
  });
});
