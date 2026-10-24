import { describe, expect, it } from 'vitest';
import {
  assignToolNames,
  buildRequest,
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
// not map is omitted per operation with a reason, so the rest of the spec is
// served. additionalOperations have their own file.

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
  it('maps QUERY and additionalOperations to operations', () => {
    const document = doc32({
      '/orders': {
        get: { operationId: 'listOrders', responses: okResponses },
        query: { operationId: 'queryOrders', responses: okResponses },
        additionalOperations: {
          LINK: { operationId: 'linkOrders', responses: okResponses },
          'PURGE\u001B[31m': { responses: okResponses },
        },
      },
    });
    // The meta-schema refuses the control character; normalization must not
    // rely on that (a cache hit skips revalidation)
    expect(() => validateOpenApiDocument(document)).toThrow(/schema validation/u);
    const spec = normalizeSpec(document, '3.2');
    expect(spec.operations.map((operation) => [operation.method, operation.operationId])).toEqual([
      ['get', 'listOrders'],
      ['query', 'queryOrders'],
      ['LINK', 'linkOrders'],
    ]);
    expect(spec.omitted).toEqual([
      // The method name is spec text: sanitized before it is shown
      {
        method: expect.not.stringContaining('\u001B') as string,
        path: '/orders',
        reason: 'additionalOperations key is not a valid HTTP method name',
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

  describe('querystring parameters', () => {
    const budgets = { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 };
    const formFilter = (schema: Record<string, unknown>): Record<string, unknown> => ({
      name: 'filter',
      in: 'querystring',
      content: { 'application/x-www-form-urlencoded': { schema } },
    });
    const filterSchema = {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['open', 'closed'] },
        text: { type: 'string' },
        limit: { type: 'integer' },
        urgent: { type: 'boolean' },
      },
    };

    it('maps a form querystring to one argument and encodes it as the query string', () => {
      const built = build(
        doc32({
          '/search': {
            get: {
              operationId: 'search',
              parameters: [{ ...formFilter(filterSchema), required: true }],
              responses: okResponses,
            },
          },
          // Inherited from the path item, as for any parameter
          '/inherited': {
            parameters: [formFilter(filterSchema)],
            get: { operationId: 'inherited', responses: okResponses },
          },
        }),
      );
      expect(built.omitted).toEqual([]);
      const [search, inherited] = built.tools;
      expect(search?.inputSchema.safeParse({}).success).toBe(false);
      expect(search?.inputSchema.safeParse({ filter: { status: 'lost' } }).success).toBe(false);
      expect(inherited?.inputSchema.safeParse({}).success).toBe(true);
      // Input schemas are closed: an undeclared key is refused
      expect(search?.inputSchema.safeParse({ filter: { status: 'open', x: 1 } }).success).toBe(
        false,
      );
      const filter = { status: 'open', text: 'a b&c=d#e', limit: 5, urgent: true };
      expect(search?.inputSchema.safeParse({ filter }).success).toBe(true);
      const request = buildRequest(search!.mapper, 'get', '/search', { filter }, budgets);
      expect(request).toMatchObject({
        ok: { query: 'status=open&text=a+b%26c%3Dd%23e&limit=5&urgent=true' },
      });
      expect(buildRequest(inherited!.mapper, 'get', '/inherited', {}, budgets)).toMatchObject({
        ok: { query: '' },
      });
    });

    it.each([
      [
        'another media type',
        { name: 'q', in: 'querystring', content: { 'application/json': { schema: filterSchema } } },
        'needs exactly one application/x-www-form-urlencoded content',
      ],
      [
        'a nested property',
        formFilter({ type: 'object', properties: { range: { type: 'object' } } }),
        'must be an object of scalar values',
      ],
      ['a non-object schema', formFilter({ type: 'string' }), 'must be an object of scalar values'],
      [
        'an Encoding Object',
        {
          name: 'q',
          in: 'querystring',
          content: {
            'application/x-www-form-urlencoded': {
              schema: filterSchema,
              encoding: { text: { contentType: 'application/json' } },
            },
          },
        },
        'declares an encoding, which is not supported',
      ],
    ])('omits an operation whose querystring uses %s', (_label, parameter, reason) => {
      const built = build(
        doc32({ '/q': { get: { parameters: [parameter], responses: okResponses } } }),
      );
      expect(built.tools).toEqual([]);
      expect(built.omitted).toEqual([
        expect.objectContaining({ reason: expect.stringContaining(reason) as string }),
      ]);
    });

    it('omits an operation that combines a querystring with query parameters', () => {
      // Forbidden by OAS 3.2; a cached document is not revalidated, so the
      // layout does not rely on the meta-schema for it
      const spec = normalizeSpec(
        doc32({
          '/q': {
            get: {
              parameters: [
                formFilter(filterSchema),
                { name: 'page', in: 'query', schema: { type: 'integer' } },
              ],
              responses: okResponses,
            },
          },
        }),
        '3.2',
      );
      const built = buildTools(assignToolNames(spec.operations), {
        reservedHeaders: SYSTEM_HEADERS,
        openapiVersion: '3.2',
      });
      expect(built.omitted).toEqual([
        expect.objectContaining({
          reason: expect.stringContaining('combined with query parameters') as string,
        }),
      ]);
    });

    it('omits an operation with a second querystring inherited from the path item', () => {
      // OAS 3.2 allows one per operation; the meta-schema checks each
      // parameters array on its own, so this document validates
      const document = doc32({
        '/two': {
          parameters: [{ ...formFilter(filterSchema), name: 'a' }],
          get: { parameters: [{ ...formFilter(filterSchema), name: 'b' }], responses: okResponses },
        },
      });
      expect(validateOpenApiDocument(document).version).toBe('3.2');
      const built = build(document);
      expect(built.tools).toEqual([]);
      expect(built.omitted).toEqual([
        expect.objectContaining({
          reason: expect.stringContaining('is not the only one') as string,
        }),
      ]);
    });

    it('omits an operation with two querystring references at one level', () => {
      const document = doc32(
        {
          '/two': {
            get: {
              parameters: [
                { $ref: '#/components/parameters/A' },
                { $ref: '#/components/parameters/B' },
              ],
              responses: okResponses,
            },
          },
        },
        {
          components: {
            parameters: {
              A: { ...formFilter(filterSchema), name: 'a' },
              B: { ...formFilter(filterSchema), name: 'b' },
            },
          },
        },
      );
      const built = build(document);
      expect(built.tools).toEqual([]);
      expect(built.omitted).toEqual([
        expect.objectContaining({
          reason: expect.stringContaining('is not the only one') as string,
        }),
      ]);
    });

    it('keeps one querystring when the operation overrides the path item one by name', () => {
      const built = build(
        doc32({
          '/over': {
            parameters: [formFilter({ type: 'object', properties: { old: { type: 'string' } } })],
            get: {
              operationId: 'over',
              parameters: [formFilter(filterSchema)],
              responses: okResponses,
            },
          },
        }),
      );
      expect(built.omitted).toEqual([]);
      expect(built.tools[0]?.inputSchema.safeParse({ filter: { status: 'open' } }).success).toBe(
        true,
      );
    });

    it('fails closed at call time on a nested value or an unencodable string', () => {
      const built = build(
        doc32({
          '/q': {
            get: {
              operationId: 'q',
              parameters: [formFilter({ type: 'object', additionalProperties: true })],
              responses: okResponses,
            },
          },
        }),
      );
      const [tool] = built.tools;
      const call = (filter: unknown) =>
        buildRequest(tool!.mapper, 'get', '/q', { filter }, budgets);
      expect(call({ a: { b: 1 } })).toMatchObject({
        error: expect.stringContaining('cannot be form-urlencoded') as string,
      });
      expect(call({ a: String.fromCodePoint(0xd8_00) })).toMatchObject({
        error: expect.stringContaining('could not be encoded') as string,
      });
      // A null entry is left out, like an absent one
      expect(call({ a: null, b: 'x' })).toMatchObject({ ok: { query: 'b=x' } });
      expect(call('a=b')).toMatchObject({
        error: expect.stringContaining('must be an object') as string,
      });
    });
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

  it.each([
    ['a self-referencing', { Loop: { $ref: '#/components/mediaTypes/Loop' } }],
    [
      'a mutually referencing',
      {
        Loop: { $ref: '#/components/mediaTypes/Other' },
        Other: { $ref: '#/components/mediaTypes/Loop' },
      },
    ],
  ])(
    'keeps %s components.mediaTypes $ref fail-closed in request and response',
    (_label, mediaTypes) => {
      const loop = { 'application/json': { $ref: '#/components/mediaTypes/Loop' } };
      const document = doc32(
        {
          '/a': {
            post: {
              operationId: 'postA',
              requestBody: { required: true, content: loop },
              responses: { '200': { description: 'ok', content: loop } },
            },
          },
          '/b': {
            get: {
              operationId: 'getB',
              responses: { '200': { description: 'ok', content: loop } },
            },
          },
        },
        { components: { mediaTypes } },
      );
      const built = build(document);
      expect(built.omitted).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/a',
          reason: expect.stringContaining('the request body media type is a cyclic $ref') as string,
        }),
      ]);
      expect(built.tools.map((tool) => tool.toolName)).toEqual(['getB']);
      // No output schema rather than "any JSON"
      expect(built.tools[0]?.outputSchema).toBeUndefined();
    },
  );

  it('still accepts a schema-less media type as any JSON body', () => {
    const built = build(
      doc32({
        '/a': {
          post: {
            operationId: 'postA',
            requestBody: { required: true, content: { 'application/json': {} } },
            responses: okResponses,
          },
        },
      }),
    );
    expect(built.omitted).toEqual([]);
    expect(built.tools[0]?.inputSchema.safeParse({ body: { anything: true } }).success).toBe(true);
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
