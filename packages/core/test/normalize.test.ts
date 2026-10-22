import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { normalizeSpec, SPEC_BUDGETS } from '../src/index.ts';
import { serverUrlRejectedWarning } from '../src/spec/server-url.ts';

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
      { method: 'OPTIONS', path: '/meta', reason: 'OPTIONS operations are never exposed' },
      { method: 'TRACE', path: '/meta', reason: 'TRACE operations are never exposed' },
    ]);
  });

  it('omits an operation that is not an object', () => {
    const spec = normalizeSpec(doc({ '/broken': { get: 'bogus' } }), '3.1');
    expect(spec.omitted[0]?.reason).toContain('not an object');
  });
});

describe('normalizeSpec — server URL extraction', () => {
  it('extracts an absolute server URL from servers[0]', () => {
    const spec = normalizeSpec(
      doc(
        { '/pets': { get: { responses: okResponses } } },
        { servers: [{ url: 'https://api.example.com/v1' }] },
      ),
      '3.1',
    );
    expect(spec.serverUrl).toBe('https://api.example.com/v1');
    expect(spec.serverUrlIsRelative).toBeUndefined();
  });

  it('expands a server variable using its default', () => {
    const spec = normalizeSpec(
      doc(
        { '/pets': { get: { responses: okResponses } } },
        {
          servers: [
            { url: 'https://{host}/v1', variables: { host: { default: 'api.example.com' } } },
          ],
        },
      ),
      '3.1',
    );
    expect(spec.serverUrl).toBe('https://api.example.com/v1');
  });

  it('leaves serverUrl undefined when a variable has no matching default (operations unaffected)', () => {
    const spec = normalizeSpec(
      doc(
        { '/pets': { get: { responses: okResponses } } },
        { servers: [{ url: 'https://{host}/v1', variables: {} }] },
      ),
      '3.1',
    );
    expect(spec.serverUrl).toBeUndefined();
    expect(spec.operations).toHaveLength(1);
  });

  it('classifies a relative server URL', () => {
    const spec = normalizeSpec(
      doc({ '/pets': { get: { responses: okResponses } } }, { servers: [{ url: '/v2' }] }),
      '3.1',
    );
    expect(spec.serverUrl).toBe('/v2');
    expect(spec.serverUrlIsRelative).toBe(true);
  });

  it('leaves serverUrl undefined when there is no servers key', () => {
    const spec = normalizeSpec(doc({ '/pets': { get: { responses: okResponses } } }), '3.1');
    expect(spec.serverUrl).toBeUndefined();
    expect(spec.serverUrlIsRelative).toBeUndefined();
  });

  it('leaves serverUrl undefined when servers is empty', () => {
    const spec = normalizeSpec(
      doc({ '/pets': { get: { responses: okResponses } } }, { servers: [] }),
      '3.1',
    );
    expect(spec.serverUrl).toBeUndefined();
  });

  it('leaves serverUrl undefined on a malformed servers[0].url (fail-closed, no throw)', () => {
    const build = () =>
      normalizeSpec(
        doc({ '/pets': { get: { responses: okResponses } } }, { servers: [{ url: 42 }] }),
        '3.1',
      );
    expect(build).not.toThrow();
    expect(build().serverUrl).toBeUndefined();
  });

  it('expands multiple variables in a single template', () => {
    const spec = normalizeSpec(
      doc(
        { '/pets': { get: { responses: okResponses } } },
        {
          servers: [
            {
              url: 'https://{host}:{port}/v1',
              variables: {
                host: { default: 'api.example.com' },
                port: { default: '8443' },
              },
            },
          ],
        },
      ),
      '3.1',
    );
    expect(spec.serverUrl).toBe('https://api.example.com:8443/v1');
  });

  it('leaves serverUrl undefined on an unmatched brace in the template', () => {
    const spec = normalizeSpec(
      doc(
        { '/pets': { get: { responses: okResponses } } },
        { servers: [{ url: 'https://{host/v1', variables: { host: { default: 'x' } } }] },
      ),
      '3.1',
    );
    // The unbalanced brace never matches the placeholder regex, so the raw
    // `{` survives the single pass — the residual-brace guard rejects it.
    expect(spec.serverUrl).toBeUndefined();
  });

  it('leaves serverUrl undefined when a default itself injects a brace', () => {
    const spec = normalizeSpec(
      doc(
        { '/pets': { get: { responses: okResponses } } },
        {
          servers: [{ url: 'https://{host}/v1', variables: { host: { default: '{host}' } } }],
        },
      ),
      '3.1',
    );
    expect(spec.serverUrl).toBeUndefined();
  });

  it('resolves an amplifying-default template fast with serverUrl undefined (DoS guard)', () => {
    // Hostile case: a placeholder repeated k times whose OWN default
    // reintroduces the placeholder. A per-match split/join loop on the
    // accumulator would double the placeholder count on every one of the k
    // iterations (~k*2^k blowup). The single-pass implementation scans the
    // ORIGINAL template exactly once, so this must both resolve to
    // `undefined` (residual braces survive the one pass) AND return fast.
    const repeats = 30;
    const url = '{x}'.repeat(repeats);
    const start = performance.now();
    const spec = normalizeSpec(
      doc(
        { '/pets': { get: { responses: okResponses } } },
        { servers: [{ url, variables: { x: { default: '{x}{x}' } } }] },
      ),
      '3.1',
    );
    const elapsedMs = performance.now() - start;
    expect(spec.serverUrl).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('normalizeSpec — expanded server URL budget (issue #37)', () => {
  const budget = SPEC_BUDGETS.maxServerUrlBytes;
  type ServerFields = {
    operations: readonly { path: string }[];
    serverUrl?: string;
    serverUrlIsRelative?: boolean;
    serverUrlRejected?: { expandedBytes: number };
  };
  const withServer = (url: string, variables: Record<string, unknown> = {}): ServerFields =>
    normalizeSpec(
      doc({ '/pets': { get: { responses: okResponses } } }, { servers: [{ url, variables }] }),
      '3.1',
    );

  it('marks the 11 kB spec that expanded to a 10,000,018-character URL as rejected, without throwing or building it', () => {
    const spec = withServer(`https://a.example/${'{x}'.repeat(2000)}`, {
      x: { default: 'y'.repeat(5000) },
    });
    expect(spec.serverUrl).toBeUndefined();
    expect(spec.serverUrlRejected).toEqual({ expandedBytes: 10_000_018 });
    // The operation set is unaffected: --base-url can still serve this spec
    expect(spec.operations).toMatchObject([{ path: '/pets' }]);
  });

  it('the warning names the size and the budget, and echoes no spec content', () => {
    const message = serverUrlRejectedWarning(10_000_018);
    expect(message).toContain('10000018 bytes');
    expect(message).toContain(`${String(budget)}-byte budget`);
    expect(message).toContain('--base-url');
    expect(message.length).toBeLessThan(300);
  });

  it('accepts a result of exactly the budget and rejects one byte more', () => {
    const prefix = 'https://a.example/';
    const fill = budget - prefix.length;
    const exact = withServer(`${prefix}{x}`, { x: { default: 'y'.repeat(fill) } });
    expect(exact.serverUrl).toBe(`${prefix}${'y'.repeat(fill)}`);
    expect(exact.serverUrlRejected).toBeUndefined();
    expect(
      withServer(`${prefix}{x}`, { x: { default: 'y'.repeat(fill + 1) } }).serverUrlRejected,
    ).toEqual({ expandedBytes: budget + 1 });
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const prefix = 'https://a.example/';
    // 'é' is one code unit but two UTF-8 bytes: within budget by length,
    // over it by bytes
    const chars = Math.floor((budget - prefix.length) / 2) + 1;
    expect(`${prefix}${'é'.repeat(chars)}`.length).toBeLessThanOrEqual(budget);
    expect(
      withServer(`${prefix}{x}`, { x: { default: 'é'.repeat(chars) } }).serverUrlRejected,
    ).toBeDefined();
  });

  it('sums every variable and every occurrence', () => {
    const quarter = Math.floor(budget / 4);
    const variables = { a: { default: 'a'.repeat(quarter) }, b: { default: 'b'.repeat(quarter) } };
    expect(withServer('{a}{b}', variables).serverUrl).toBe(
      `${'a'.repeat(quarter)}${'b'.repeat(quarter)}`,
    );
    expect(withServer('{a}{b}{a}{b}{a}', variables).serverUrlRejected).toBeDefined();
  });

  it('a template over the budget that SHRINKS under it after substitution is accepted', () => {
    // Placeholder names longer than their defaults: the template is over the
    // budget, the result is not. Pins that no early exit rejects it.
    const name = 'n'.repeat(100);
    const template = `https://a.example/${`{${name}}`.repeat(30)}`;
    expect(Buffer.byteLength(template)).toBeGreaterThan(budget);
    const spec = withServer(template, { [name]: { default: 'z' } });
    expect(spec.serverUrl).toBe(`https://a.example/${'z'.repeat(30)}`);
    expect(spec.serverUrlRejected).toBeUndefined();
  });

  it('marks an over-budget literal URL without placeholders too', () => {
    expect(withServer(`https://a.example/${'y'.repeat(budget)}`).serverUrlRejected).toBeDefined();
  });

  it('keeps an unresolvable template fail-closed (serverUrl undefined, not marked rejected), however long', () => {
    const spec = withServer(`https://a.example/${'{x}'.repeat(2000)}{missing}`, {
      x: { default: 'y'.repeat(5000) },
    });
    expect(spec.operations).toMatchObject([{ path: '/pets' }]);
    expect(spec.serverUrl).toBeUndefined();
    expect(spec.serverUrlRejected).toBeUndefined();
  });

  it('still expands non-recursively: a default that injects a placeholder is not re-expanded', () => {
    const spec = withServer('https://a.example/{x}', { x: { default: '{x}' } });
    expect(spec.serverUrl).toBeUndefined();
    expect(spec.serverUrlRejected).toBeUndefined();
  });
});
