import { describe, expect, it } from 'vitest';
import {
  assignToolNames,
  buildTools,
  createDereferencer,
  normalizeSpec,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { BuildToolsResult, OpenapiVersion, OperationRecord } from '../src/index.ts';

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

  it('never widens a conflicting assertion: the operation is omitted instead', () => {
    // The intersection of maxLength 10 and 5 is not picked heuristically; the
    // two are combined with allOf, which the converter refuses for strings
    const built = build(
      spec(
        '3.1.0',
        { $ref: '#/components/schemas/Name', maxLength: 5 },
        { Name: { type: 'string', maxLength: 10 } },
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
