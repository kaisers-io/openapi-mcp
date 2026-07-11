import { describe, expect, it } from 'vitest';
import { normalizeSpec } from '../src/index.ts';

const doc = (
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: { title: 'Petstore', version: '1.2.3' },
  paths,
  ...extra,
});

const okResponses = { '200': { description: 'ok' } };

describe('normalizeSpec — extraction', () => {
  it('extracts operations with metadata and info fields', () => {
    const spec = normalizeSpec(
      doc({
        '/pets': {
          get: {
            operationId: 'listPets',
            summary: 'List all pets',
            description: 'Returns every pet.',
            tags: ['pets', 'read'],
            deprecated: true,
            responses: okResponses,
          },
        },
      }),
      '3.1',
    );
    expect(spec.title).toBe('Petstore');
    expect(spec.specVersion).toBe('1.2.3');
    expect(spec.openapiVersion).toBe('3.1');
    expect(spec.omitted).toEqual([]);
    expect(spec.operations).toEqual([
      {
        method: 'get',
        path: '/pets',
        operationId: 'listPets',
        tags: ['pets', 'read'],
        summary: 'List all pets',
        description: 'Returns every pet.',
        deprecated: true,
        parameters: [],
        responses: okResponses,
      },
    ]);
  });

  it('merges path-level parameters with operation-level ones (operation wins)', () => {
    const spec = normalizeSpec(
      doc({
        '/pets/{petId}': {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          ],
          get: {
            parameters: [{ name: 'verbose', in: 'query', schema: { type: 'string' } }],
            responses: okResponses,
          },
        },
      }),
      '3.1',
    );
    const params = spec.operations[0]?.parameters ?? [];
    expect(params).toHaveLength(2);
    const verbose = params.find((param) => param['name'] === 'verbose');
    expect(verbose?.['schema']).toEqual({ type: 'string' });
  });

  it('keeps requestBody and responses as records', () => {
    const requestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
    const spec = normalizeSpec(
      doc({ '/pets': { post: { requestBody, responses: okResponses } } }),
      '3.1',
    );
    expect(spec.operations[0]?.requestBody).toEqual(requestBody);
  });

  it('skips path-object extension keys', () => {
    const spec = normalizeSpec(
      doc({
        'x-internal': { get: { responses: okResponses } },
        '/real': { get: { responses: okResponses } },
      }),
      '3.1',
    );
    expect(spec.operations).toHaveLength(1);
    expect(spec.operations[0]?.path).toBe('/real');
  });

  it('handles a spec without paths (3.1 webhooks-only)', () => {
    const spec = normalizeSpec(
      { openapi: '3.1.0', info: { title: 'W', version: '1' }, webhooks: { newPet: {} } },
      '3.1',
    );
    expect(spec.operations).toEqual([]);
    expect(spec.omitted).toEqual([
      { method: '*', path: 'webhook:newPet', reason: 'webhooks are not supported' },
    ]);
  });

  it('sanitizes and caps info and text fields', () => {
    const spec = normalizeSpec(
      doc(
        {
          '/pets': {
            get: { summary: 'evil\u202E summary\u0007', responses: okResponses },
          },
        },
        { info: { title: `T${'x'.repeat(500)}`, version: '1' } },
      ),
      '3.1',
    );
    expect(spec.title.length).toBeLessThanOrEqual(256);
    expect(spec.operations[0]?.summary).toBe('evil summary');
  });
});

describe('normalizeSpec — omissions (never silent)', () => {
  it('omits operations with cookie parameters', () => {
    const spec = normalizeSpec(
      doc({
        '/legacy': {
          get: {
            parameters: [{ name: 'session', in: 'cookie', schema: { type: 'string' } }],
            responses: okResponses,
          },
        },
      }),
      '3.1',
    );
    expect(spec.operations).toEqual([]);
    expect(spec.omitted).toEqual([
      { method: 'GET', path: '/legacy', reason: 'cookie parameters are not supported' },
    ]);
  });

  it('omits operations with per-operation servers overrides', () => {
    const spec = normalizeSpec(
      doc({
        '/admin': {
          get: { servers: [{ url: 'https://admin.example.com' }], responses: okResponses },
        },
      }),
      '3.1',
    );
    expect(spec.omitted[0]?.reason).toContain('servers');
  });

  it('omits every operation under a path with path-level servers', () => {
    const spec = normalizeSpec(
      doc({
        '/replicated': {
          servers: [{ url: 'https://replica.example.com' }],
          get: { responses: okResponses },
          post: { responses: okResponses },
        },
      }),
      '3.1',
    );
    expect(spec.operations).toEqual([]);
    expect(spec.omitted).toHaveLength(2);
    expect(spec.omitted.every((entry) => entry.reason.includes('path-level servers'))).toBe(true);
  });

  it('omits operations with callbacks', () => {
    const spec = normalizeSpec(
      doc({
        '/hooked': {
          post: { callbacks: { onEvent: {} }, responses: okResponses },
        },
      }),
      '3.1',
    );
    expect(spec.omitted[0]?.reason).toContain('callbacks');
  });

  it('omits operations whose parameters could not be resolved (cyclic marker)', () => {
    const spec = normalizeSpec(
      doc({
        '/cyclic': {
          get: {
            parameters: [{ $ref: '#/components/parameters/Cyclic' }],
            responses: okResponses,
          },
        },
      }),
      '3.1',
    );
    expect(spec.omitted[0]?.reason).toContain('parameter');
  });

  it('reports OPTIONS and TRACE as never exposed', () => {
    const spec = normalizeSpec(
      doc({
        '/meta': {
          options: { responses: okResponses },
          trace: { responses: okResponses },
          get: { responses: okResponses },
        },
      }),
      '3.1',
    );
    expect(spec.operations).toHaveLength(1);
    expect(spec.omitted).toEqual([
      { method: 'OPTIONS', path: '/meta', reason: 'OPTIONS operations are never exposed in v1' },
      { method: 'TRACE', path: '/meta', reason: 'TRACE operations are never exposed in v1' },
    ]);
  });

  it('omits an operation that is not an object', () => {
    const spec = normalizeSpec(doc({ '/broken': { get: 'bogus' } }), '3.1');
    expect(spec.omitted[0]?.reason).toContain('not an object');
  });
});
