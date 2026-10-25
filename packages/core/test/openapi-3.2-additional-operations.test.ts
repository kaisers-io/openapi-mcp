import { OPENAPI_VALIDATORS } from '../src/spec/validators.ts';
import { describe, expect, it } from 'vitest';
import {
  assignToolNames,
  buildRequest,
  buildTools,
  createDereferencer,
  normalizeSpec,
  SYSTEM_HEADERS,
  validateOpenApiDocument,
} from '../src/index.ts';
import type { BuildToolsResult, OperationRecord } from '../src/index.ts';
import { operationKeysOf } from '../src/spec/pending-candidate.ts';

// Issue #33: OpenAPI 3.2 `additionalOperations` declare operations for HTTP
// methods without their own Path Item field, keyed by the method name "with
// the same capitalization that is to be sent in the request" (OAS 3.2.1
// §4.9.1). Upper-case methods become tools; everything else is omitted with
// a reason.

const okResponses = { '200': { description: 'ok' } };
const budgets = { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 };

const doc32 = (paths: Record<string, unknown>): Record<string, unknown> => ({
  openapi: '3.2.0',
  info: { title: 'Shop', version: '1.0.0' },
  paths,
});

// The pipeline's path: validate, normalize, dereference what is exposed, build
const build = (document: Record<string, unknown>): BuildToolsResult => {
  const { version } = validateOpenApiDocument(document, OPENAPI_VALIDATORS);
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

describe('OpenAPI 3.2 additionalOperations (issue #33)', () => {
  const linkBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['target'],
          properties: { target: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
  };
  const document = doc32({
    '/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getOrder', responses: okResponses },
      additionalOperations: {
        LINK: { operationId: 'linkOrder', requestBody: linkBody, responses: okResponses },
        COPY: { responses: okResponses },
      },
    },
  });

  it('maps each upper-case method to a tool, after the standard methods', () => {
    const { tools, omitted } = build(document);
    expect(omitted).toEqual([]);
    expect(
      tools.map((tool) => [tool.toolName, tool.operation.method, tool.operation.path]),
    ).toEqual([
      ['getOrder', 'get', '/orders/{id}'],
      ['linkOrder', 'LINK', '/orders/{id}'],
      // Without an operationId the name comes from the method and the path
      ['copy_orders_by_id', 'COPY', '/orders/{id}'],
    ]);
  });

  it('treats an additional method like POST: never read-only or idempotent', () => {
    const link = build(document).tools.find((tool) => tool.toolName === 'linkOrder');
    expect(link?.annotations).toEqual({ destructiveHint: true, openWorldHint: true });
  });

  it('inherits path parameters and sends the request body with the method', () => {
    const link = build(document).tools.find((tool) => tool.toolName === 'linkOrder');
    expect(link?.wireSchema).toMatchObject({ required: ['id', 'target'] });
    const request = buildRequest(
      link!.mapper,
      'LINK',
      '/orders/{id}',
      { id: 'o1', target: '/orders/o2' },
      budgets,
    );
    expect(request).toMatchObject({
      ok: {
        pathname: '/orders/o1',
        contentType: 'application/json',
      },
    });
    expect(new TextDecoder().decode((request as { ok: { body: Uint8Array } }).ok.body)).toBe(
      '{"target":"/orders/o2"}',
    );
  });

  it.each([
    ['link', 'additionalOperations methods that are not upper case are not supported'],
    ['Link', 'additionalOperations methods that are not upper case are not supported'],
    ['CONNECT', 'CONNECT operations are never exposed'],
    ['connect', 'CONNECT operations are never exposed'],
    ['TRACK', 'TRACK operations are never exposed'],
    [
      'X'.repeat(33),
      'additionalOperations method names longer than 32 characters are not supported',
    ],
  ])('omits the method %s: %s', (method, reason) => {
    const spec = doc32({
      '/orders': { additionalOperations: { [method]: { responses: okResponses } } },
    });
    // The meta-schema accepts each of these: any token but the fixed names
    expect(validateOpenApiDocument(spec, OPENAPI_VALIDATORS).version).toBe('3.2');
    const normalized = normalizeSpec(spec, '3.2');
    expect(normalized.operations).toEqual([]);
    // The method name is spec text, shown shortened when it is long
    const shown = method.length > 32 ? `${method.slice(0, 20)}…[truncated]` : method;
    expect(normalized.omitted).toEqual([{ method: shown, path: '/orders', reason }]);
  });

  // The meta-schema refuses these; normalization must not rely on that (a
  // cache hit skips revalidation)
  it.each([
    [
      'GET',
      { responses: okResponses },
      'GET must be declared by its own Path Item field, not in additionalOperations',
    ],
    [
      'OPTIONS',
      { responses: okResponses },
      'OPTIONS must be declared by its own Path Item field, not in additionalOperations',
    ],
    [
      'QUERY',
      { responses: okResponses },
      'QUERY must be declared by its own Path Item field, not in additionalOperations',
    ],
    ['LINK', 'not an operation', 'operation is not an object'],
    [
      'BAD METHOD',
      { responses: okResponses },
      'additionalOperations key is not a valid HTTP method name',
    ],
    ['', { responses: okResponses }, 'additionalOperations key is not a valid HTTP method name'],
  ])('omits %j without relying on the meta-schema', (method, operation, reason) => {
    const spec = doc32({ '/orders': { additionalOperations: { [method]: operation } } });
    expect(() => validateOpenApiDocument(spec, OPENAPI_VALIDATORS)).toThrow(/schema validation/u);
    const normalized = normalizeSpec(spec, '3.2');
    expect(normalized.operations).toEqual([]);
    expect(normalized.omitted).toEqual([{ method, path: '/orders', reason }]);
  });

  it('omits an additional operation under a path-level servers override, like any method', () => {
    const spec = doc32({
      '/orders': {
        servers: [{ url: 'https://other.example.test' }],
        additionalOperations: { LINK: { responses: okResponses } },
      },
    });
    expect(normalizeSpec(spec, '3.2').omitted).toEqual([
      { method: 'LINK', path: '/orders', reason: 'path-level servers overrides are not supported' },
    ]);
  });

  it('applies the per-operation omissions, for example callbacks', () => {
    const spec = doc32({
      '/orders': {
        additionalOperations: {
          LINK: {
            callbacks: { done: { '{$request.body#/url}': { post: { responses: okResponses } } } },
            responses: okResponses,
          },
        },
      },
    });
    expect(normalizeSpec(spec, '3.2').omitted).toEqual([
      { method: 'LINK', path: '/orders', reason: 'callbacks are not supported' },
    ]);
  });

  // A pending candidate withholds every served operation it no longer
  // declares, so an additional method it still declares must count as present
  it('counts additional methods of a candidate as present, upper case only', () => {
    const keys = operationKeysOf(
      doc32({
        '/orders/{id}': {
          get: { responses: okResponses },
          additionalOperations: {
            LINK: { responses: okResponses },
            unlink: { responses: okResponses },
            COPY: 'not an operation',
          },
        },
      }),
    );
    expect([...keys]).toEqual(['GET /orders/{}', 'LINK /orders/{}']);
  });
});
