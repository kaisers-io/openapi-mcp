import { describe, expect, it } from 'vitest';
import { withConvertMemo } from '../src/toolgen/schema.ts';
import {
  buildTools,
  compileEnvelopeValidator,
  dereference,
  deriveOutputSchema,
  explainOutputSchema,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { EnvelopeValidator, NamedOperation, OperationRecord } from '../src/index.ts';

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

// Issue kaisers-io/openapi-mcp-archive#33 / kaisers-io/openapi-mcp-archive#47:
// response schemas are converted in RESPONSE mode — validated with the same
// Ajv2020 path the server uses at runtime.
describe('deriveOutputSchema — response-mode conversion (kaisers-io/openapi-mcp-archive#33, kaisers-io/openapi-mcp-archive#47)', () => {
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

describe('deriveOutputSchema — oneOf in responses (kaisers-io/openapi-mcp-archive#43)', () => {
  it('validates a response oneOf inclusively, so a discriminator-mapping payload passes', () => {
    const branch = (extra: string) => ({
      type: 'object',
      required: ['petType'],
      properties: {
        petType: { type: 'string' },
        name: { type: 'string' },
        [extra]: { type: 'boolean' },
      },
    });
    const outputSchema = deriveOutputSchema(
      op({
        '200': {
          content: {
            'application/json': {
              schema: {
                oneOf: [branch('hunts'), branch('bark')],
                discriminator: { propertyName: 'petType' },
              },
            },
          },
        },
      }),
      '3.1',
    ) as Record<string, unknown>;
    const validate = compileEnvelopeValidator(outputSchema) as EnvelopeValidator;
    const envelope = (value: unknown) => ({
      status: 200,
      contentType: 'application/json',
      data: value,
    });
    expect(validate(envelope({ petType: 'dog', name: 'Rex', bark: true }))).toBe(true);
    expect(validate(envelope({ name: 'Rex' }))).toBe(false);
  });
});

// Issue kaisers-io/openapi-mcp-archive#72: opt-in — treat `default` as covering
// error statuses only.
describe('deriveOutputSchema — defaultResponseIsError opt-in (kaisers-io/openapi-mcp-archive#72)', () => {
  const responses = {
    '200': {
      content: {
        'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    },
    default: {
      content: {
        'application/json': {
          schema: { type: 'object', properties: { error: { type: 'object' } } },
        },
      },
    },
  };

  it('is unchanged without the option (no outputSchema)', () => {
    expect(deriveOutputSchema(op(responses), '3.1')).toBeUndefined();
    const off = deriveOutputSchema(op(responses), '3.1', { defaultResponseIsError: false });
    expect(off).toBeUndefined();
  });

  it('derives one 200 branch with the option', () => {
    const schema = deriveOutputSchema(op(responses), '3.1', { defaultResponseIsError: true }) as {
      oneOf: { properties: { status: { const: number } } }[];
    };
    expect(schema.oneOf).toHaveLength(1);
    expect(schema.oneOf[0]?.properties.status.const).toBe(200);
  });

  it('still disables the outputSchema for a 2XX range key, with or without the option', () => {
    const ranged = op({ ...responses, '2XX': { description: 'any success' } });
    expect(deriveOutputSchema(ranged, '3.1', { defaultResponseIsError: true })).toBeUndefined();
  });

  it('still returns nothing when only `default` is documented', () => {
    const onlyDefault = op({ default: responses.default });
    const schema = deriveOutputSchema(onlyDefault, '3.1', { defaultResponseIsError: true });
    expect(schema).toBeUndefined();
  });
});

// Issue #3: opt-in — every value under an object's `properties` in the derived
// `data` schema also admits null, for specs whose generator omits `nullable`
// while the server serializes unset fields as null.
describe('deriveOutputSchema — nullableResponseFields opt-in (#3)', () => {
  // The issue's repro, with real `$ref`s resolved the way the pipeline does.
  const reproDocument = (): Record<string, unknown> => ({
    openapi: '3.0.1',
    info: { title: 'repro', version: '1.0.0' },
    paths: {
      '/shops/{id}': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Shop' } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Shop: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            district: { type: 'string' },
            logo: { $ref: '#/components/schemas/Image' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        Image: { type: 'object', properties: { url: { type: 'string' } } },
      },
    },
  });
  const reproResponses = (): Record<string, unknown> => {
    const resolved = dereference(reproDocument(), '3.0') as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    return resolved.paths['/shops/{id}']!['get']!.responses;
  };
  const envelope = (data: unknown) => ({ status: 200, contentType: 'application/json', data });
  const validatorFor = (
    responses: Record<string, unknown>,
    nullableResponseFields?: boolean,
  ): EnvelopeValidator => {
    const outputSchema = deriveOutputSchema(
      op(responses),
      '3.0',
      nullableResponseFields === undefined ? {} : { nullableResponseFields },
    );
    if (outputSchema === undefined) {
      throw new Error('expected an outputSchema');
    }
    return compileEnvelopeValidator(outputSchema) as EnvelopeValidator;
  };
  const withSchema = (schema: unknown): Record<string, unknown> => ({
    '200': { content: { 'application/json': { schema } } },
  });
  const REPRO_BODY = { id: '1', name: null, district: null, logo: null, tags: ['a'] };

  it('rejects the repro body without the option (the strict default is pinned)', () => {
    expect(validatorFor(reproResponses())(envelope(REPRO_BODY))).toBe(false);
    expect(validatorFor(reproResponses(), false)(envelope(REPRO_BODY))).toBe(false);
  });

  it('accepts the repro body with the option', () => {
    expect(validatorFor(reproResponses(), true)(envelope(REPRO_BODY))).toBe(true);
  });

  it('still rejects a wrong non-null type', () => {
    const validate = validatorFor(reproResponses(), true);
    expect(validate(envelope({ ...REPRO_BODY, name: 42 }))).toBe(false);
    expect(validate(envelope({ ...REPRO_BODY, logo: { url: 7 } }))).toBe(false);
  });

  it('still rejects a missing required key (required means present, null or not)', () => {
    const { name: _name, ...withoutName } = REPRO_BODY;
    expect(validatorFor(reproResponses(), true)(envelope(withoutName))).toBe(false);
  });

  it('does not widen array items, additionalProperties values or the root value', () => {
    const validate = validatorFor(reproResponses(), true);
    expect(validate(envelope({ ...REPRO_BODY, tags: ['a', null] }))).toBe(false);
    expect(validate(envelope(null))).toBe(false);
    const map = validatorFor(
      withSchema({ type: 'object', additionalProperties: { type: 'string' } }),
      true,
    );
    expect(map(envelope({ a: 'x' }))).toBe(true);
    expect(map(envelope({ a: null }))).toBe(false);
  });

  it('admits null for a $ref property and for the properties of the referenced object', () => {
    const validate = validatorFor(reproResponses(), true);
    expect(validate(envelope({ ...REPRO_BODY, logo: null }))).toBe(true);
    expect(validate(envelope({ ...REPRO_BODY, logo: { url: null } }))).toBe(true);
  });

  it('admits null at every depth of nested objects, including inside array items', () => {
    const validate = validatorFor(
      withSchema({
        type: 'object',
        properties: {
          owner: {
            type: 'object',
            properties: { address: { type: 'object', properties: { city: { type: 'string' } } } },
          },
          list: {
            type: 'array',
            items: { type: 'object', properties: { n: { type: 'integer' } } },
          },
        },
      }),
      true,
    );
    expect(validate(envelope({ owner: null }))).toBe(true);
    expect(validate(envelope({ owner: { address: null } }))).toBe(true);
    expect(validate(envelope({ owner: { address: { city: null } } }))).toBe(true);
    expect(validate(envelope({ list: [{ n: null }] }))).toBe(true);
    expect(validate(envelope({ owner: { address: { city: 1 } } }))).toBe(false);
  });

  it('admits null for properties contributed by allOf and anyOf members', () => {
    const image = { type: 'object', properties: { url: { type: 'string' } } };
    const validate = validatorFor(
      withSchema({
        type: 'object',
        properties: {
          merged: {
            allOf: [image, { type: 'object', properties: { width: { type: 'integer' } } }],
          },
          either: {
            anyOf: [
              { type: 'string' },
              { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } },
            ],
          },
        },
      }),
      true,
    );
    expect(validate(envelope({ merged: { url: null, width: null } }))).toBe(true);
    expect(validate(envelope({ either: { b: null } }))).toBe(true);
    expect(validate(envelope({ either: null }))).toBe(true);
    expect(validate(envelope({ merged: { width: 'wide' } }))).toBe(false);
    expect(validate(envelope({ either: {} }))).toBe(false);
  });

  it('leaves a 3.0 `nullable: true` property as it was (no second null)', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', nullable: true },
        kind: { type: 'string', nullable: true, enum: ['a', 'b'] },
      },
    };
    const off = deriveOutputSchema(op(withSchema(schema)), '3.0');
    const on = deriveOutputSchema(op(withSchema(schema)), '3.0', { nullableResponseFields: true });
    expect(on).toEqual(off);
  });

  it("leaves a 3.1 `type: [T, 'null']` property as it was (no second null)", () => {
    const schema = {
      type: 'object',
      properties: { name: { type: ['string', 'null'] }, free: {} },
    };
    const off = deriveOutputSchema(op(withSchema(schema)), '3.1');
    const on = deriveOutputSchema(op(withSchema(schema)), '3.1', { nullableResponseFields: true });
    expect(on).toEqual(off);
  });

  it('keeps the enum and const of a widened property', () => {
    const validate = validatorFor(
      withSchema({
        type: 'object',
        properties: { kind: { type: 'string', enum: ['a', 'b'] }, fixed: { const: 'x' } },
      }),
      true,
    );
    expect(validate(envelope({ kind: null, fixed: null }))).toBe(true);
    expect(validate(envelope({ kind: 'a', fixed: 'x' }))).toBe(true);
    expect(validate(envelope({ kind: 'c' }))).toBe(false);
    expect(validate(envelope({ fixed: 'y' }))).toBe(false);
  });

  it('leaves the envelope fields alone', () => {
    const outputSchema = deriveOutputSchema(op(reproResponses()), '3.0', {
      nullableResponseFields: true,
      pagination: true,
      projection: true,
    }) as { oneOf: { properties: Record<string, unknown> }[] };
    const plain = deriveOutputSchema(op(reproResponses()), '3.0', {
      pagination: true,
      projection: true,
    }) as { oneOf: { properties: Record<string, unknown> }[] };
    const { data: _on, ...envelopeOn } = outputSchema.oneOf[0]!.properties;
    const { data: _off, ...envelopeOff } = plain.oneOf[0]!.properties;
    expect(envelopeOn).toEqual(envelopeOff);
    expect(outputSchema.oneOf[1]).toEqual(plain.oneOf[1]);
    const validate = compileEnvelopeValidator(outputSchema) as EnvelopeValidator;
    expect(validate({ ...envelope(REPRO_BODY), status: null })).toBe(false);
  });

  it('is byte-identical to the default when off', () => {
    const responses = reproResponses();
    const omitted = JSON.stringify(deriveOutputSchema(op(responses), '3.0'));
    const off = JSON.stringify(
      deriveOutputSchema(op(responses), '3.0', { nullableResponseFields: false }),
    );
    expect(off).toBe(omitted);
    expect(omitted).not.toContain('null');
  });

  it('never mutates the memoized data schema shared across operations of one build', () => {
    const responses = reproResponses();
    const [plain, widened, plainAgain] = withConvertMemo(() => [
      explainOutputSchema(op(responses), '3.0').outputSchema,
      explainOutputSchema(op(responses), '3.0', { nullableResponseFields: true }).outputSchema,
      explainOutputSchema(op(responses), '3.0').outputSchema,
    ]);
    const dataOf = (schema: unknown): unknown =>
      (schema as { oneOf: { properties: { data: unknown } }[] }).oneOf[0]!.properties.data;
    // The two plain derivations share one memoized object, which the widened
    // derivation in between left untouched.
    expect(dataOf(plainAgain)).toBe(dataOf(plain));
    expect(JSON.stringify(dataOf(plain))).not.toContain('null');
    expect(JSON.stringify(dataOf(widened))).toContain('null');
    expect(compileEnvelopeValidator(plain)!(envelope(REPRO_BODY))).toBe(false);
    expect(compileEnvelopeValidator(widened)!(envelope(REPRO_BODY))).toBe(true);
  });

  it('gives operations sharing a schema one widened object per build, and builds differ by the option', () => {
    const shared = reproResponses();
    const named = (toolName: string): NamedOperation => ({
      toolName,
      operation: { ...op(shared), path: `/${toolName}` },
    });
    const opts = { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.0' as const };
    const on = buildTools([named('a'), named('b')], { ...opts, nullableResponseFields: true });
    const off = buildTools([named('a'), named('b')], opts);
    const dataOf = (schema: unknown): unknown =>
      (schema as { oneOf: { properties: { data: unknown } }[] }).oneOf[0]!.properties.data;
    expect(dataOf(on.tools[0]!.outputSchema)).toBe(dataOf(on.tools[1]!.outputSchema));
    expect(compileEnvelopeValidator(on.tools[1]!.outputSchema)!(envelope(REPRO_BODY))).toBe(true);
    expect(compileEnvelopeValidator(off.tools[1]!.outputSchema)!(envelope(REPRO_BODY))).toBe(false);
    expect(JSON.stringify(off.tools[0]!.outputSchema)).not.toContain('null');
  });
});
