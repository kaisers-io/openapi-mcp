import { describe, expect, it } from 'vitest';
import {
  assignToolNames,
  buildTools,
  convertSchema,
  createDereferencer,
  normalizeSpec,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { BuildToolsResult, OpenapiVersion, OperationRecord } from '../src/index.ts';
import { mergeSchemaSiblings } from '../src/spec/ref-siblings.ts';

// Issue #63: in OpenAPI 3.1 (JSON Schema 2020-12) keywords next to a $ref are
// applied in addition to the referenced schema; in 3.0 they MUST be ignored.

const DEFAULT_COMPONENTS: Record<string, unknown> = { Name: { type: 'string' } };

const spec = (
  openapi: string,
  nameSchema: Record<string, unknown>,
  components = DEFAULT_COMPONENTS,
): Record<string, unknown> => ({
  openapi,
  info: { title: 't', version: '1' },
  components: { schemas: components },
  paths: {
    '/things': {
      post: {
        operationId: 'createThing',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: { name: nameSchema } },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

// The pipeline's path: normalize the raw document, dereference what is exposed
const build = (document: Record<string, unknown>, version: OpenapiVersion): BuildToolsResult => {
  const normalized = normalizeSpec(document, version);
  const dereferencer = createDereferencer(document, {
    collapseCycles: true,
    openapiVersion: version,
  });
  const operations: OperationRecord[] = [];
  for (const operation of normalized.operations) {
    const { requestBody } = operation;
    operations.push({
      ...operation,
      parameters: operation.parameters.map(
        (parameter) => dereferencer.resolve(parameter) as Record<string, unknown>,
      ),
      ...(requestBody === undefined
        ? {}
        : { requestBody: dereferencer.resolve(requestBody) as Record<string, unknown> }),
      responses: dereferencer.resolve(operation.responses) as Record<string, unknown>,
    });
  }
  return buildTools(assignToolNames(operations), {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: version,
  });
};

const nameProperty = (built: BuildToolsResult): Record<string, unknown> => {
  const wire = built.tools[0]?.wireSchema as { properties: Record<string, unknown> };
  return wire.properties['name'] as Record<string, unknown>;
};

const SIBLINGS = { $ref: '#/components/schemas/Name', maxLength: 5, description: 'Display name' };

describe('$ref siblings — OpenAPI 3.1 applies them', () => {
  it('adds an assertion keyword and overrides the description (the issue reproduction)', () => {
    const built = build(spec('3.1.0', SIBLINGS), '3.1');
    expect(nameProperty(built)).toMatchObject({
      type: 'string',
      maxLength: 5,
      description: 'Display name',
    });
    const input = built.tools[0]?.inputSchema;
    expect(input?.safeParse({ name: 'much-too-long' }).success).toBe(false);
    expect(input?.safeParse({ name: 'short' }).success).toBe(true);
  });

  it('lets an annotation sibling override the target annotation', () => {
    const built = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Name', description: 'Field-specific', title: 'Own' },
        { Name: { type: 'string', description: 'Shared', title: 'Shared title' } },
      ),
      '3.1',
    );
    expect(nameProperty(built)).toMatchObject({ description: 'Field-specific' });
  });

  it('keeps an assertion both sides agree on', () => {
    const built = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Name', maxLength: 5 },
        { Name: { type: 'string', maxLength: 5 } },
      ),
      '3.1',
    );
    expect(nameProperty(built)).toMatchObject({ maxLength: 5 });
  });

  it('narrows a shared bound to the exact intersection instead of omitting the operation', () => {
    // The most common 3.1 use of siblings: a shared type tightened at one use
    // site. Both bounds must hold, so the smaller maximum is exact
    const built = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Name', maxLength: 5 },
        { Name: { type: 'string', maxLength: 10 } },
      ),
      '3.1',
    );
    expect(nameProperty(built)).toMatchObject({ type: 'string', maxLength: 5 });
    const input = built.tools[0]?.inputSchema;
    expect(input?.safeParse({ name: 'sixsix' }).success).toBe(false);
    expect(input?.safeParse({ name: 'five5' }).success).toBe(true);
    // And a looser sibling cannot widen the target
    const looser = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Name', maxLength: 50, minLength: 1 },
        { Name: { type: 'string', maxLength: 10, minLength: 3 } },
      ),
      '3.1',
    );
    expect(nameProperty(looser)).toMatchObject({ maxLength: 10, minLength: 3 });
  });

  it('intersects type sets (a nullable sibling next to a non-null target stays non-null)', () => {
    const built = build(
      spec('3.1.0', { $ref: '#/components/schemas/Name', type: ['string', 'null'] }),
      '3.1',
    );
    expect(nameProperty(built)).toMatchObject({ type: 'string' });
    expect(built.tools[0]?.inputSchema.safeParse({ name: null }).success).toBe(false);
    const integer = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Count', type: 'integer' },
        { Count: { type: 'number', minimum: 0 } },
      ),
      '3.1',
    );
    expect(nameProperty(integer)).toMatchObject({ type: 'integer', minimum: 0 });
  });

  it('intersects enums and fails closed on an empty intersection', () => {
    const narrowed = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Color', enum: ['red', 'green', 'purple'] },
        { Color: { type: 'string', enum: ['red', 'green', 'blue'] } },
      ),
      '3.1',
    );
    expect(nameProperty(narrowed)['enum']).toEqual(['red', 'green']);
    const disjoint = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Color', enum: ['purple'] },
        { Color: { type: 'string', enum: ['red'] } },
      ),
      '3.1',
    );
    expect(disjoint.tools).toEqual([]);
    expect(disjoint.omitted).toHaveLength(1);
  });

  it('merges uniqueItems (either side) and the item-count bounds', () => {
    const merged = mergeSchemaSiblings(
      { type: 'array', items: { type: 'string' }, uniqueItems: false, maxItems: 5 },
      { uniqueItems: true, maxItems: 3, minItems: 1 },
    );
    expect(merged['allOf']).toBeUndefined();
    expect({ ...merged }).toMatchObject({ uniqueItems: true, maxItems: 3, minItems: 1 });
    // #112: the converter enforces the merged keywords (OR of uniqueItems)
    const converted = convertSchema({ ...merged }, '3.1');
    if (!('ok' in converted)) {
      throw new Error(converted.unrepresentable);
    }
    expect(converted.ok.safeParse(['a', 'b']).success).toBe(true);
    expect(converted.ok.safeParse(['a', 'a']).success).toBe(false);
    expect(converted.ok.safeParse(['a', 'b', 'c', 'd']).success).toBe(false);
  });

  it('never widens a differing non-monotone assertion: the operation is omitted instead', () => {
    // Two different patterns have no single-keyword intersection; target and
    // siblings are combined with allOf, which the converter refuses for strings
    const built = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Name', pattern: '^b' },
        { Name: { type: 'string', pattern: '^a' } },
      ),
      '3.1',
    );
    expect(built.tools).toEqual([]);
    expect(built.omitted).toHaveLength(1);
  });

  it('stays fail-closed for a recursive schema with siblings, without crashing', () => {
    const built = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Node', description: 'A tree' },
        {
          Node: {
            type: 'object',
            properties: { child: { $ref: '#/components/schemas/Node', description: 'Child' } },
          },
        },
      ),
      '3.1',
    );
    expect(built.tools).toEqual([]);
    expect(built.omitted).toHaveLength(1);
  });

  it('applies only summary and description next to a non-schema Reference Object', () => {
    const document: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      components: {
        parameters: {
          Limit: {
            name: 'limit',
            in: 'query',
            required: true,
            description: 'Shared',
            schema: { type: 'integer' },
          },
        },
      },
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            parameters: [
              // `required` is not allowed next to a Reference Object and is ignored
              { $ref: '#/components/parameters/Limit', description: 'Page size', required: false },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const built = build(document, '3.1');
    const wire = built.tools[0]?.wireSchema as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(wire.properties['limit']?.['description']).toBe('Page size');
    expect(wire.required).toContain('limit');
  });
});

describe('$ref siblings — OpenAPI 3.0 ignores them', () => {
  it('behaves as before: the referenced schema alone', () => {
    const built = build(spec('3.0.3', SIBLINGS), '3.0');
    const name = nameProperty(built);
    expect(name['maxLength']).toBeUndefined();
    expect(name['description']).toBeUndefined();
    expect(built.tools[0]?.inputSchema.safeParse({ name: 'much-too-long' }).success).toBe(true);
  });
});

describe('mergeSchemaSiblings — exact intersection (3.1)', () => {
  it('unions required, intersects property-count bounds and compares values key-order independently', () => {
    const merged = mergeSchemaSiblings(
      {
        type: 'object',
        required: ['a'],
        minProperties: 1,
        maxProperties: 9,
        const: { x: 1, y: 2 },
      },
      { required: ['b'], minProperties: 2, maxProperties: 4, const: { y: 2, x: 1 } },
    );
    expect(merged['allOf']).toBeUndefined();
    expect({ ...merged }).toMatchObject({
      required: ['a', 'b'],
      minProperties: 2,
      maxProperties: 4,
      const: { x: 1, y: 2 },
    });
  });

  it('feeds the converter the intersected property-count bounds (#112: max of mins, min of maxes)', () => {
    const merged = mergeSchemaSiblings(
      { type: 'object', additionalProperties: true, minProperties: 1, maxProperties: 9 },
      { minProperties: 2, maxProperties: 3 },
    );
    const converted = convertSchema({ ...merged }, '3.1');
    if (!('ok' in converted)) {
      throw new Error(converted.unrepresentable);
    }
    expect(converted.ok.safeParse({ a: 1 }).success).toBe(false);
    expect(converted.ok.safeParse({ a: 1, b: 2 }).success).toBe(true);
    expect(converted.ok.safeParse({ a: 1, b: 2, c: 3, d: 4 }).success).toBe(false);
  });

  it('keeps target and siblings apart for a differing const or a malformed bound', () => {
    expect(mergeSchemaSiblings({ const: 1 }, { const: 2 })['allOf']).toBeDefined();
    expect(mergeSchemaSiblings({ maxLength: 'x' }, { maxLength: 3 })['allOf']).toBeDefined();
  });

  it('keeps an identical scope group flattened, a differing one apart', () => {
    const closed = { type: 'object', properties: { a: {} }, additionalProperties: false };
    expect(mergeSchemaSiblings(closed, { additionalProperties: false })['allOf']).toBeDefined();
    expect(
      mergeSchemaSiblings(closed, { properties: { a: {} }, additionalProperties: false })['allOf'],
    ).toBeUndefined();
  });
});

describe('$ref siblings — conjunctive scope (3.1)', () => {
  const bodySpec = (
    bodySchema: Record<string, unknown>,
    components: Record<string, unknown>,
  ): Record<string, unknown> => ({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    components: { schemas: components },
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: bodySchema } },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });
  const BASE = { type: 'object', properties: { name: { type: 'string' } } };

  it('does not move a sibling additionalProperties into the target properties scope', () => {
    // The original rejects {name: "x"}: the sibling's additionalProperties
    // sees no properties of its own. Flattening would allow name
    const built = build(
      bodySpec({ $ref: '#/components/schemas/Base', additionalProperties: false }, { Base: BASE }),
      '3.1',
    );
    const accepts = built.tools.some(
      (tool) => tool.inputSchema.safeParse({ body: { name: 'x' } }).success,
    );
    expect(accepts).toBe(false);
    expect(built.omitted).toHaveLength(1);
  });

  it('does not let sibling properties escape a target additionalProperties: false', () => {
    const built = build(
      bodySpec(
        { $ref: '#/components/schemas/Closed', properties: { b: { type: 'string' } } },
        { Closed: { ...BASE, additionalProperties: false } },
      ),
      '3.1',
    );
    expect(built.tools).toEqual([]);
    expect(built.omitted).toHaveLength(1);
  });

  it('still adds an independent object assertion (required) to an object target', () => {
    const built = build(
      bodySpec({ $ref: '#/components/schemas/Base', required: ['name'] }, { Base: BASE }),
      '3.1',
    );
    expect(built.tools).toHaveLength(1);
  });
});

describe('$ref inside instance data is data, not a reference', () => {
  it('copies example, default, const and enum values verbatim, but still resolves schema maps', () => {
    const document = {
      openapi: '3.1.0',
      components: {
        schemas: {
          Name: { type: 'string' },
          Doc: {
            type: 'object',
            properties: {
              // A property NAMED like a data keyword is still a schema
              example: { $ref: '#/components/schemas/Name' },
              link: {
                type: 'object',
                example: { $ref: '#/components/schemas/Name' },
                default: { $ref: '#/components/schemas/Name' },
                enum: [{ $ref: '#/components/schemas/Name' }],
                const: { $ref: '#/components/schemas/Name' },
              },
            },
          },
        },
      },
      root: {
        $ref: '#/components/schemas/Doc',
        examples: [{ $ref: '#/components/schemas/Name' }],
      },
    };
    // Resolved the way the pipeline reaches a schema: through a media type
    const media = createDereferencer(document, { openapiVersion: '3.1' }).resolve({
      schema: document.root,
    }) as { schema: { examples: unknown; properties: Record<string, Record<string, unknown>> } };
    const out = media.schema;
    const literal = { $ref: '#/components/schemas/Name' };
    expect(out.properties['example']).toEqual({ type: 'string' });
    expect(out.properties['link']).toMatchObject({
      example: literal,
      default: literal,
      enum: [literal],
      const: literal,
    });
    expect(out.examples).toEqual([literal]);
  });
});
