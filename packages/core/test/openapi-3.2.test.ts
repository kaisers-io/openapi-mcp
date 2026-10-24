import { describe, expect, it } from 'vitest';
import {
  assignToolNames,
  buildTools,
  createDereferencer,
  declaredOpenapiVersion,
  describeSecurityScheme,
  normalizeSpec,
  SYSTEM_HEADERS,
  validateOpenApiDocument,
} from '../src/index.ts';
import type { BuildToolsResult, OperationRecord } from '../src/index.ts';

// Issue #33: OpenAPI 3.2 documents are accepted. What tool generation does
// not map yet (QUERY, additionalOperations, querystring parameters) is
// omitted per operation with a reason, so the rest of the spec is served.

const okResponses = { '200': { description: 'ok' } };

const doc32 = (
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  openapi: '3.2.0',
  info: { title: 'Shop', version: '1.0.0' },
  paths,
  ...extra,
});

// The pipeline's path: validate, normalize, dereference what is exposed, build
const build = (document: Record<string, unknown>): BuildToolsResult => {
  const { version } = validateOpenApiDocument(document);
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

describe('OpenAPI 3.2 (issue #33)', () => {
  it('omits QUERY and additionalOperations, keeping the other operations of the path', () => {
    const document = doc32({
      '/orders': {
        get: { operationId: 'listOrders', responses: okResponses },
        query: { operationId: 'queryOrders', responses: okResponses },
        additionalOperations: {
          LINK: { responses: okResponses },
          'PURGE\u001B[31m': { responses: okResponses },
        },
      },
    });
    // The meta-schema refuses the control character; normalization must not
    // rely on that (a cache hit skips revalidation)
    expect(() => validateOpenApiDocument(document)).toThrow(/schema validation/u);
    const spec = normalizeSpec(document, '3.2');
    expect(spec.operations.map((operation) => operation.operationId)).toEqual(['listOrders']);
    expect(spec.omitted).toEqual([
      { method: 'QUERY', path: '/orders', reason: 'QUERY operations are not supported yet' },
      { method: 'LINK', path: '/orders', reason: 'additionalOperations are not supported yet' },
      // The method name is spec text: sanitized before it is shown
      {
        method: expect.not.stringContaining('\u001B') as string,
        path: '/orders',
        reason: 'additionalOperations are not supported yet',
      },
    ]);
  });

  it('accepts a document with QUERY and additionalOperations', () => {
    const document = doc32({
      '/orders': {
        query: { responses: okResponses },
        additionalOperations: { LINK: { responses: okResponses } },
      },
    });
    expect(validateOpenApiDocument(document).version).toBe('3.2');
  });

  it('omits an operation with a querystring parameter, also one inherited from the path', () => {
    const querystring = {
      name: 'filter',
      in: 'querystring',
      content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } },
    };
    const document = doc32({
      '/search': { get: { parameters: [querystring], responses: okResponses } },
      '/inherited': { parameters: [querystring], get: { responses: okResponses } },
      '/plain': { get: { operationId: 'plain', responses: okResponses } },
    });
    expect(validateOpenApiDocument(document).version).toBe('3.2');
    const spec = normalizeSpec(document, '3.2');
    expect(spec.operations.map((operation) => operation.path)).toEqual(['/plain']);
    expect(spec.omitted).toEqual([
      { method: 'GET', path: '/search', reason: 'querystring parameters are not supported yet' },
      { method: 'GET', path: '/inherited', reason: 'querystring parameters are not supported yet' },
    ]);
  });

  it('builds tools like 3.1: $ref siblings apply and a components.mediaTypes $ref resolves', () => {
    const document = doc32(
      {
        '/orders/{id}': {
          get: {
            operationId: 'getOrder',
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { $ref: '#/components/schemas/Id', maxLength: 4 },
              },
            ],
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { $ref: '#/components/mediaTypes/Order' } },
              },
            },
          },
        },
      },
      {
        $self: 'https://shop.example.test/openapi.yaml',
        components: {
          schemas: { Id: { type: 'string' } },
          mediaTypes: {
            Order: {
              schema: {
                type: 'object',
                required: ['note'],
                properties: { note: { type: ['string', 'null'] } },
              },
            },
          },
        },
      },
    );
    const built = build(document);
    const [tool] = built.tools;
    expect(built.omitted).toEqual([]);
    expect(tool?.inputSchema.safeParse({ id: 'o1' }).success).toBe(true);
    // The sibling maxLength applies, as in 3.1 (JSON Schema 2020-12)
    expect(tool?.inputSchema.safeParse({ id: 'o12345' }).success).toBe(false);
    const [branch] = (tool?.outputSchema?.['oneOf'] ?? []) as Record<string, unknown>[];
    expect(branch?.['properties']).toMatchObject({
      data: { type: 'object', properties: { note: { type: ['string', 'null'] } } },
    });
  });

  it('lists the 3.2 device authorization flow among an oauth2 scheme flows', () => {
    const spec = normalizeSpec(
      doc32(
        { '/a': { get: { responses: okResponses } } },
        {
          components: {
            securitySchemes: {
              device: {
                type: 'oauth2',
                oauth2MetadataUrl:
                  'https://auth.example.test/.well-known/oauth-authorization-server',
                flows: {
                  deviceAuthorization: {
                    deviceAuthorizationUrl: 'https://auth.example.test/device',
                    tokenUrl: 'https://auth.example.test/token',
                    scopes: {},
                  },
                },
              },
            },
          },
        },
      ),
      '3.2',
    );
    expect(spec.securitySchemes).toEqual([
      { name: 'device', type: 'oauth2', flows: ['deviceAuthorization'] },
    ]);
  });

  it('marks a scheme the spec deprecates in the credential hint', () => {
    const spec = normalizeSpec(
      doc32(
        { '/a': { get: { responses: okResponses } } },
        {
          components: {
            securitySchemes: {
              old: { type: 'apiKey', in: 'header', name: 'X-Key', deprecated: true },
              current: { type: 'apiKey', in: 'header', name: 'X-Token' },
            },
          },
        },
      ),
      '3.2',
    );
    const [old, current] = spec.securitySchemes ?? [];
    expect(old).toMatchObject({ name: 'old', deprecated: true });
    expect(current).not.toHaveProperty('deprecated');
    expect(old === undefined ? '' : describeSecurityScheme(old)).toContain(
      '(apiKey in header "X-Key", deprecated)',
    );
    expect(current === undefined ? '' : describeSecurityScheme(current)).not.toContain(
      'deprecated',
    );
  });

  it.each([
    ['3.2.0', '3.2'],
    ['3.2.1', '3.2'],
    ['3.1.2', '3.1'],
    ['3.0.4', '3.0'],
    ['3.20.0', undefined],
    ['4.0.0', undefined],
  ])('derives the cache discriminator of openapi %s', (declared, expected) => {
    expect(declaredOpenapiVersion({ openapi: declared })).toBe(expected);
  });
});
