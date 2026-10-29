import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import type { CliContext } from '../src/context.ts';
import { run } from '../src/main.ts';

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

type Capture = {
  lines: string[];
  errLines: string[];
  ctx: CliContext;
};

const fileCtx = (overrides: Parameters<typeof testContext>[0] = {}): Capture => {
  const lines: string[] = [];
  const errLines: string[] = [];
  const ctx = testContext({
    lines,
    errLines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => fixturesDir,
    ...overrides,
  });
  return { lines, errLines, ctx };
};

describe('tools command — file specs', () => {
  it('lists tools in human mode and reports omissions as warnings', async () => {
    const { lines, errLines, ctx } = fileCtx();
    const code = await run(ctx, ['node', 'openapi-mcp', 'tools', '--spec', 'petstore.json']);
    expect(code).toBe(EXIT.OK);
    const text = lines.join('\n');
    // The read-only default hides the POST
    expect(text).toContain('Petstore 1.0.0 (OpenAPI 3.1) — 1 tool');
    expect(text).toContain('listPets');
    expect(text).not.toContain('createPet');
    // Omissions are a non-fatal condition: stderr, not stdout
    expect(errLines.join('\n')).toContain('cookie parameters are not supported');
  });

  it('emits the JSON envelope with tool and omission data', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'path:/**',
    ]);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(lines[0]!) as {
      ok: boolean;
      data: {
        title: string;
        openapiVersion: string;
        toolCount: number;
        contentHash: string;
        tools: { name: string; method: string; path: string; deprecated: boolean }[];
        omitted: { method: string; path: string; reason: string }[];
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.title).toBe('Petstore');
    expect(envelope.data.toolCount).toBe(2);
    expect(envelope.data.tools.map((tool) => tool.name)).toEqual(['listPets', 'createPet']);
    expect(envelope.data.tools[0]?.method).toBe('GET');
    expect(envelope.data.omitted).toHaveLength(1);
    expect(envelope.data.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('escapes C1 and bidi characters from spec paths, operation ids and tags in JSON', async () => {
    const path = '/p\u009B31mX\u202EY';
    const spec = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Hostile', version: '1.0.0' },
      paths: {
        [path]: {
          get: {
            operationId: 'op\u009D0;T\u009C\u2066z',
            tags: ['t\u202E'],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const { lines, ctx } = fileCtx({
      readFileText: () => Promise.resolve(spec),
      fileSizeBytes: () => Promise.resolve(spec.length),
    });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'tools',
      '--spec',
      'hostile.json',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(lines[0]).not.toMatch(/[\u0080-\u009F\u202A-\u202E\u2066-\u2069]/u);
    const { data } = JSON.parse(lines[0]!) as {
      data: { tools: { path: string; operationId: string; tags: string[] }[] };
    };
    expect(data.tools[0]?.path).toBe(path);
    expect(data.tools[0]?.operationId).toBe('op\u009D0;T\u009C\u2066z');
    expect(data.tools[0]?.tags).toEqual(['t\u202E']);
  });

  it('serves an OpenAPI 3.2 spec, additionalOperations included (#33)', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'tools',
      '--spec',
      'shop-3.2.yaml',
      '--allow',
      'path:/**',
    ]);
    expect(code).toBe(EXIT.OK);
    const { data } = JSON.parse(lines[0]!) as {
      data: {
        openapiVersion: string;
        tools: { name: string; method: string }[];
        omitted: { method: string; path: string; reason: string }[];
        security: { scheme: string; hint: string }[];
      };
    };
    expect(data.openapiVersion).toBe('3.2');
    expect(data.tools.map((tool) => [tool.name, tool.method])).toEqual([
      ['listOrders', 'GET'],
      ['queryOrders', 'QUERY'],
      ['linkOrders', 'LINK'],
      ['getOrder', 'GET'],
      ['updateOrder', 'PATCH'],
      ['searchOrders', 'GET'],
      ['exportOrders', 'GET'],
      ['streamEvents', 'GET'],
      ['getPet', 'GET'],
    ]);
    expect(data.omitted).toEqual([]);
    expect(JSON.stringify(data.security)).toContain('deviceAuthorization');
  });

  // OpenAPI 3.2 additionalOperations (#33): a pattern may name a method the
  // spec declares; any other non-standard method is still a usage error
  it('filters an additionalOperations method by name and rejects an undeclared one', async () => {
    const allowed = fileCtx();
    const okCode = await run(allowed.ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'tools',
      '--spec',
      'shop-3.2.yaml',
      '--allow',
      'route:LINK /orders',
    ]);
    expect(okCode).toBe(EXIT.OK);
    const { data } = JSON.parse(allowed.lines[0]!) as { data: { tools: { name: string }[] } };
    expect(data.tools.map((tool) => tool.name)).toEqual(['linkOrders']);

    const misspelled = fileCtx();
    const badCode = await run(misspelled.ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'shop-3.2.yaml',
      '--deny',
      'route:LNIK /orders',
    ]);
    expect(badCode).toBe(EXIT.USAGE);
    expect(misspelled.errLines.join('\n')).toContain('names LNIK');
  });

  it('maps an invalid spec to a validation error with exit 3', async () => {
    const { errLines, ctx } = fileCtx({
      readFileText: () => Promise.resolve('{"openapi":"3.1.0"}'),
      fileSizeBytes: () => Promise.resolve(20),
    });
    const code = await run(ctx, ['node', 'openapi-mcp', 'tools', '--spec', 'broken.json']);
    expect(code).toBe(EXIT.VALIDATION);
    expect(errLines.join('\n')).toContain('schema validation');
  });

  it('maps a missing spec file to exit 4', async () => {
    const { ctx } = fileCtx({
      readFileText: () => Promise.reject(new Error('ENOENT')),
      fileSizeBytes: () => Promise.reject(new Error('ENOENT')),
    });
    const code = await run(ctx, ['node', 'openapi-mcp', 'tools', '--spec', 'missing.json']);
    expect(code).toBe(EXIT.NOT_FOUND);
  });

  it('rejects an invalid --timeout with exit 2', async () => {
    const { ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--timeout',
      '5w',
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('rejects --spec-header-env for file specs with exit 2', async () => {
    const { errLines, ctx } = fileCtx({ env: { SPEC_TOKEN: 'secret' } });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).toContain('URL spec sources');
  });

  it('strips terminal escapes from a hostile path key end to end', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'hostile-path-key.json',
    ]);
    expect(code).toBe(EXIT.VALIDATION);
    const allOutput = errLines.join('\n');
    // The hostile path key's ESC bytes must never reach the operator's terminal
    expect(allOutput).not.toContain('\u001B');
    // The stripped payload should still be visible so the operator sees the attempt
    expect(allOutput).toContain(']0;PWNED');
  });
});

describe('tools command — URL specs', () => {
  const specText = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Remote', version: '2.0.0' },
    paths: {
      '/things': {
        get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
      },
    },
  });

  it('fetches the spec with resolved auth headers', async () => {
    const seen: Headers[] = [];
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response(specText));
    }) as unknown as CliContext['fetcher'];
    const { lines, ctx } = fileCtx({ fetcher, env: { SPEC_TOKEN: 'Bearer super-secret' } });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--cache-key',
      'test',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(seen[0]?.get('authorization')).toBe('Bearer super-secret');
    expect(lines.join('\n')).toContain('listThings');
  });

  it('fails hard with exit 2 when the env var is missing, naming it', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).toContain('SPEC_TOKEN');
  });

  it('never leaks the secret value into any output channel', async () => {
    const secret = 'super-secret-value-9000';
    const fetcher = (() =>
      Promise.resolve(new Response('denied', { status: 401 }))) as unknown as CliContext['fetcher'];
    const { lines, errLines, ctx } = fileCtx({ fetcher, env: { SPEC_TOKEN: secret } });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json?page=1',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--cache-key',
      'test',
    ]);
    expect(code).toBe(EXIT.VALIDATION);
    const allOutput = [...lines, ...errLines].join('\n');
    expect(allOutput).not.toContain(secret);
    // The redacted display source drops even benign query strings
    expect(allOutput).not.toContain('page=1');
    expect(allOutput).toContain('--spec-header-env');
  });

  it('rejects credential-bearing query parameters with exit 2, without echoing the value', async () => {
    const { lines, errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json?token=in-query-secret',
    ]);
    expect(code).toBe(EXIT.USAGE);
    const allOutput = [...lines, ...errLines].join('\n');
    expect(allOutput).not.toContain('in-query-secret');
    expect(allOutput).toContain('token');
  });
});

describe('tools command — filters', () => {
  it('exposes a write operation when it is explicitly allowed', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'operationId:createPet',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('createPet');
    // An explicit allow replaces the read-only default entirely
    expect(lines.join('\n')).not.toContain('listPets');
  });

  it('lets deny win over allow', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'path:/**',
      '--deny',
      'operationId:createPet',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('listPets');
    expect(lines.join('\n')).not.toContain('createPet');
  });

  it('accepts repeated allow patterns', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'operationId:listPets',
      '--allow',
      'operationId:createPet',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('listPets');
    expect(lines.join('\n')).toContain('createPet');
  });

  it('warns about a dead pattern with the closest-match suggestion', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'operationId:listPetz',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(errLines.join('\n')).toContain(
      'openapi-mcp: warning: --allow "operationId:listPetz" matches no operation; closest: operationId:listPets',
    );
  });

  it('names the flag the engine recorded for a dead deny pattern', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--deny',
      'operationId:nothingLikeThis',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(errLines.join('\n')).toContain(
      '--deny "operationId:nothingLikeThis" matches no operation',
    );
  });

  it('turns a dead pattern into exit 3 under --strict-filters', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'operationId:listPetz',
      '--strict-filters',
    ]);
    expect(code).toBe(EXIT.VALIDATION);
    expect(errLines.join('\n')).toContain('closest: operationId:listPets');
  });

  it('rejects a malformed pattern with exit 2 before any spec access', async () => {
    const { errLines, ctx } = fileCtx({
      readFileText: () => Promise.reject(new Error('should not be read')),
      fileSizeBytes: () => Promise.reject(new Error('should not be read')),
    });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'route:GET  /double/space',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).not.toContain('should not be read');
  });

  it('rejects an over-long pattern with exit 2', async () => {
    const { ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'operationId:a'.repeat(300),
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('rejects a pattern with too many wildcards with exit 2', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      `operationId:${'*a'.repeat(20)}`,
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).toContain('wildcard');
  });

  it('rejects more patterns than the count bound allows with exit 2', async () => {
    const { ctx } = fileCtx();
    const many = Array.from({ length: 129 }, (_unused, index) => [
      '--allow',
      `operationId:op${String(index)}`,
    ]).flat();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      ...many,
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('reports dead patterns with their flag in the json envelope', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'operationId:listPetz',
    ]);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(lines[0]!) as {
      data: {
        deadPatterns: { raw: string; flag: string; suggestion?: string }[];
        cacheStatus: string;
      };
      warnings: string[];
    };
    expect(envelope.data.deadPatterns).toEqual([
      { raw: 'operationId:listPetz', flag: 'allow', suggestion: 'operationId:listPets' },
    ]);
    expect(envelope.warnings.join('\n')).toContain('--allow "operationId:listPetz"');
  });
});

describe('tools command — cache and ttl', () => {
  it('reports the cache status in human output', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, ['node', 'openapi-mcp', 'tools', '--spec', 'petstore.json']);
    expect(code).toBe(EXIT.OK);
    // The testContext().homeDir() stub is undefined, so there is no cache root to use
    expect(lines.join('\n')).toContain('cache: bypassed');
  });

  it('rejects an invalid --ttl with exit 2', async () => {
    const { ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--ttl',
      '1y',
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('rejects an invalid --cache-key with exit 2 without echoing it', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--cache-key',
      '../../etc',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).not.toContain('../../etc');
  });

  it('rejects an authenticated spec with no cache decision with exit 2', async () => {
    const fetcher = (() => Promise.resolve(new Response('{}'))) as unknown as CliContext['fetcher'];
    const { errLines, ctx } = fileCtx({ fetcher, env: { SPEC_TOKEN: 'Bearer x' } });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).toContain('--cache-key');
    expect(errLines.join('\n')).toContain('--trust-spec-updates');
  });

  it('accepts an authenticated spec under --trust-spec-updates as a bypass', async () => {
    const specText = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Remote', version: '1.0.0' },
      paths: {
        '/things': {
          get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
        },
      },
    });
    const fetcher = (() =>
      Promise.resolve(new Response(specText))) as unknown as CliContext['fetcher'];
    const { lines, ctx } = fileCtx({ fetcher, env: { SPEC_TOKEN: 'Bearer x' } });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--trust-spec-updates',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('cache: bypassed');
  });

  // --allow-private-network threads through parseSpecPipelineArgs into the
  // pipeline options exactly like the other nine flags, but nothing in this
  // file exercised it before the tools.ts -> spec-options.ts extraction — a
  // dropped flag in that extraction would have gone undetected by the rest
  // of this suite. A redirect to a
  // private-address host is the only place this flag has any effect (the
  // initial --spec URL itself is never address-checked).
  it('threads --allow-private-network through to the redirect egress check', async () => {
    const specText = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Remote', version: '1.0.0' },
      paths: {
        '/things': {
          get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
        },
      },
    });
    const hrefOf = (url: string | URL | Request): string => {
      if (typeof url === 'string') {
        return url;
      }
      return url instanceof URL ? url.href : url.url;
    };
    const fetcher = ((url: string | URL | Request) => {
      const href = hrefOf(url);
      if (href === 'https://api.example.com/openapi.json') {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://internal.example.com/openapi.json' },
          }),
        );
      }
      return Promise.resolve(new Response(specText));
    }) as unknown as CliContext['fetcher'];
    const lookup = (hostname: string): Promise<readonly string[]> =>
      hostname === 'internal.example.com'
        ? Promise.resolve(['10.0.0.5'])
        : Promise.reject(new Error('unexpected host'));

    const denied = fileCtx({ fetcher, lookup });
    const deniedCode = await run(denied.ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
    ]);
    expect(deniedCode).toBe(EXIT.VALIDATION);
    expect(denied.errLines.join('\n')).toContain('--allow-private-network');

    const allowed = fileCtx({ fetcher, lookup });
    const allowedCode = await run(allowed.ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--allow-private-network',
    ]);
    expect(allowedCode).toBe(EXIT.OK);
    expect(allowed.lines.join('\n')).toContain('listThings');
  });
});

describe('tools command — toolgen omissions', () => {
  it('counts only toolgen-generated tools and merges a toolgen omission with the spec-level ones', async () => {
    const specText = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Omit', version: '1.0.0' },
      paths: {
        '/clean': {
          get: {
            operationId: 'getClean',
            parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
        '/bad': {
          post: {
            operationId: 'postBad',
            requestBody: {
              content: { 'application/json': { schema: { not: {} } } },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const fetcher = (() =>
      Promise.resolve(new Response(specText))) as unknown as CliContext['fetcher'];
    const { lines, ctx } = fileCtx({ fetcher });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--allow',
      'path:/**',
    ]);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(lines[0]!) as {
      data: {
        toolCount: number;
        tools: { name: string }[];
        omitted: { method: string; path: string; reason: string }[];
      };
    };
    // POST /bad is unrepresentable (a "not" body schema) and must be dropped by
    // toolgen, not counted as a generated tool.
    expect(envelope.data.toolCount).toBe(1);
    expect(envelope.data.tools.map((tool) => tool.name)).toEqual(['getClean']);
    const badOmission = envelope.data.omitted.find(
      (omission) => omission.method === 'POST' && omission.path === '/bad',
    );
    expect(badOmission).toBeDefined();
    expect(badOmission?.reason).toContain('not');
  });

  it('sanitizes a hostile parameter name before it reaches the omission warning', async () => {
    // Built at runtime, never typed literally: BEL (0x07) and RTL override (0x202e)
    const bad = `p${String.fromCodePoint(0x07)}${String.fromCodePoint(0x20_2e)}`;
    const specText = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Hostile', version: '1.0.0' },
      paths: {
        '/h': {
          get: {
            operationId: 'getH',
            parameters: [
              { name: bad, in: 'query', schema: { type: 'string' }, style: 'deepObject' },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const fetcher = (() =>
      Promise.resolve(new Response(specText))) as unknown as CliContext['fetcher'];
    const { errLines, ctx } = fileCtx({ fetcher });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--allow',
      'path:/**',
    ]);
    expect(code).toBe(EXIT.OK);
    const allOutput = errLines.join('\n');
    // The warning must exist — the unsupported "deepObject" style is what
    // triggers the toolgen omission for GET /h.
    expect(allOutput).toContain('omitted GET /h');
    expect(allOutput).toContain('deepObject');
    // But the hostile bytes it carried in the raw parameter name must not.
    expect(allOutput).not.toContain(bad);
    expect(allOutput).not.toContain(String.fromCodePoint(0x07));
    expect(allOutput).not.toContain(String.fromCodePoint(0x20_2e));

    // Bind the tools.ts reason-sanitize wrap directly. In human mode emit()
    // re-sanitizes every warning line, so the assertions above hold even if the
    // inner sanitizeSpecText(reason) is removed. The --json envelope emits the
    // warnings array WITHOUT that human-mode sanitize loop (output.ts), so the
    // inner wrap is the sole sanitizer of the reason there: dropping it lets the
    // raw hostile parameter name reach the --json warnings entry. (data.omitted
    // stays raw by policy, so we assert on warnings, not on data.omitted.)
    const jsonRun = fileCtx({ fetcher });
    const jsonCode = await run(jsonRun.ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--allow',
      'path:/**',
    ]);
    expect(jsonCode).toBe(EXIT.OK);
    const envelope = JSON.parse(jsonRun.lines[0]!) as { warnings: string[] };
    const warningsText = envelope.warnings.join('\n');
    expect(warningsText).toContain('omitted GET /h');
    expect(warningsText).not.toContain(String.fromCodePoint(0x07));
    expect(warningsText).not.toContain(String.fromCodePoint(0x20_2e));
  });
});

// Issue kaisers-io/openapi-mcp-archive#72: opt-in --default-response-is-error.
describe('tools command — --default-response-is-error (kaisers-io/openapi-mcp-archive#72)', () => {
  type Row = { name: string; outputSchema: boolean; outputSchemaAssumesDefaultIsError?: true };
  const toolsJson = async (extra: readonly string[]): Promise<Row[]> => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'default-response.json'];
    const code = await run(ctx, [...argv, ...extra]);
    expect(code).toBe(EXIT.OK);
    return (JSON.parse(lines[0]!) as { data: { tools: Row[] } }).data.tools;
  };

  it('without the flag: no outputSchema for an operation with a default response', async () => {
    const [row] = await toolsJson([]);
    expect(row).toMatchObject({ name: 'getCharge', outputSchema: false });
    expect(row?.outputSchemaAssumesDefaultIsError).toBeUndefined();
  });

  it('with the flag: an outputSchema, reported as relying on the flag', async () => {
    const [row] = await toolsJson(['--default-response-is-error']);
    expect(row).toMatchObject({
      name: 'getCharge',
      outputSchema: true,
      outputSchemaAssumesDefaultIsError: true,
    });
  });

  it('marks such tools in human output', async () => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', 'tools', '--spec', 'default-response.json'];
    const code = await run(ctx, [...argv, '--default-response-is-error']);
    expect(code).toBe(EXIT.OK);
    const text = lines.join('\n');
    expect(text).toContain('getCharge');
    expect(text).toContain('[output schema assumes default = error]');
  });
});

// Issue #3: opt-in --nullable-response-fields.
describe('tools command — --nullable-response-fields (#3)', () => {
  type Row = { name: string; outputSchema: boolean; outputSchemaAdmitsNullFields?: true };
  const toolsJson = async (extra: readonly string[]): Promise<Row[]> => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'petstore.json'];
    const code = await run(ctx, [...argv, '--allow', 'path:/**', ...extra]);
    expect(code).toBe(EXIT.OK);
    return (JSON.parse(lines[0]!) as { data: { tools: Row[] } }).data.tools;
  };

  it('without the flag: no tool is reported as admitting null fields', async () => {
    const rows = await toolsJson([]);
    expect(rows.find((row) => row.name === 'listPets')).toMatchObject({ outputSchema: true });
    for (const row of rows) {
      expect(row.outputSchemaAdmitsNullFields).toBeUndefined();
    }
  });

  it('with the flag: reports the tools whose output schema it widened', async () => {
    const rows = await toolsJson(['--nullable-response-fields']);
    expect(rows.find((row) => row.name === 'listPets')).toMatchObject({
      outputSchema: true,
      outputSchemaAdmitsNullFields: true,
    });
    // No output schema, nothing widened
    const createPet = rows.find((row) => row.name === 'createPet');
    expect(createPet?.outputSchemaAdmitsNullFields).toBeUndefined();
  });

  it('accepts the scopes all and optional (#17)', async () => {
    for (const scope of ['all', 'optional']) {
      const rows = await toolsJson(['--nullable-response-fields', scope]);
      // The listPets items require none of their properties: both scopes widen them
      expect(rows.find((row) => row.name === 'listPets')).toMatchObject({
        outputSchemaAdmitsNullFields: true,
      });
    }
  });

  it('rejects an unknown scope with exit 2 (#17)', async () => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'petstore.json'];
    const code = await run(ctx, [...argv, '--nullable-response-fields=sometimes']);
    expect(code).toBe(EXIT.USAGE);
    const { error } = JSON.parse(lines[0]!) as { error: { message: string } };
    expect(error.message).toBe(
      '--nullable-response-fields "sometimes" is not one of all, optional',
    );
  });
});

// Issue #13: --omit-output-schema takes the output schema from the matching
// exposed tools, so a response that does not match the spec is returned as text.
describe('tools command — --omit-output-schema (#13)', () => {
  type Row = {
    name: string;
    outputSchema: boolean;
    outputSchemaOptedOut?: true;
    outputSchemaAdmitsNullFields?: true;
  };
  const toolsJson = async (
    extra: readonly string[],
  ): Promise<{ code: number; rows: Row[]; warnings: string }> => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'petstore.json'];
    const code = await run(ctx, [...argv, '--allow', 'path:/**', ...extra]);
    const parsed = JSON.parse(lines[0]!) as { data?: { tools: Row[] }; warnings?: string[] };
    return { code, rows: parsed.data?.tools ?? [], warnings: (parsed.warnings ?? []).join('\n') };
  };

  it('without the flag: no tool is marked', async () => {
    const { rows } = await toolsJson([]);
    expect(rows.find((row) => row.name === 'listPets')).toMatchObject({ outputSchema: true });
    for (const row of rows) {
      expect(row.outputSchemaOptedOut).toBeUndefined();
    }
  });

  it('with the flag: the matching tool has no output schema, is marked, and is named on stderr', async () => {
    const { code, rows, warnings } = await toolsJson([
      '--omit-output-schema',
      'route:GET /pets',
      '--nullable-response-fields',
    ]);
    expect(code).toBe(EXIT.OK);
    const listPets = rows.find((row) => row.name === 'listPets');
    expect(listPets).toMatchObject({ outputSchema: false, outputSchemaOptedOut: true });
    // The schema it widened is gone, so it no longer reports that either
    expect(listPets?.outputSchemaAdmitsNullFields).toBeUndefined();
    expect(warnings).toContain(
      '--omit-output-schema: response-schema validation is off for 1 tool, results are returned as text: listPets',
    );
  });

  it('does not mark or name a tool that has no output schema anyway', async () => {
    const { rows, warnings } = await toolsJson(['--omit-output-schema', 'operationId:createPet']);
    expect(rows.find((row) => row.name === 'createPet')?.outputSchemaOptedOut).toBeUndefined();
    expect(warnings).not.toContain('response-schema validation is off');
    // It is not dead, but it changes nothing, and says so (review of #13)
    expect(warnings).toContain(
      '--omit-output-schema "operationId:createPet" matches only tools without an output schema, so it changes nothing',
    );
  });

  it('marks the tool in human output', async () => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', 'tools', '--spec', 'petstore.json'];
    const code = await run(ctx, [...argv, '--omit-output-schema', 'operationId:listPets']);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toMatch(/listPets .*\[output schema omitted\]/u);
  });

  it('warns about a pattern that matches no exposed operation, with a suggestion', async () => {
    const { code, warnings } = await toolsJson(['--omit-output-schema', 'operationId:listPet']);
    expect(code).toBe(EXIT.OK);
    expect(warnings).toContain(
      '--omit-output-schema "operationId:listPet" matches no exposed operation; closest: operationId:listPets',
    );
    // An operation the filters exclude is not exposed, so naming it does nothing
    const denied = await toolsJson([
      '--deny',
      'operationId:listPets',
      '--omit-output-schema',
      'operationId:listPets',
    ]);
    expect(denied.warnings).toContain(
      '--omit-output-schema "operationId:listPets" matches no exposed operation; it names only operations that are filtered out or omitted',
    );
  });

  it('turns a dead pattern into exit 3 under --strict-filters', async () => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'petstore.json'];
    const code = await run(ctx, [
      ...argv,
      '--strict-filters',
      '--omit-output-schema',
      'operationId:nope',
    ]);
    expect(code).toBe(EXIT.VALIDATION);
    const { error } = JSON.parse(lines[0]!) as { error: { message: string } };
    expect(error.message).toBe(
      '--omit-output-schema "operationId:nope" matches no exposed operation',
    );
  });

  // Review of #13: an operation toolgen leaves out is no tool to opt out
  it('counts a pattern that matches only an unrepresentable operation as dead', async () => {
    const specText = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Omit', version: '1.0.0' },
      paths: {
        '/bad': {
          get: {
            operationId: 'getBad',
            parameters: [{ name: 'q', in: 'query', schema: { not: {} } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const fetcher = (() =>
      Promise.resolve(new Response(specText))) as unknown as CliContext['fetcher'];
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'https://api.example.com/x'];
    const lenient = fileCtx({ fetcher });
    expect(await run(lenient.ctx, [...argv, '--omit-output-schema', 'operationId:getBad'])).toBe(
      EXIT.OK,
    );
    const envelope = JSON.parse(lenient.lines[0]!) as {
      data: { deadPatterns: { raw: string; flag: string }[] };
    };
    expect(envelope.data.deadPatterns).toEqual([
      { raw: 'operationId:getBad', flag: 'omit-output-schema', notExposed: true },
    ]);
    const strict = fileCtx({ fetcher });
    const code = await run(strict.ctx, [
      ...argv,
      '--strict-filters',
      '--omit-output-schema',
      'operationId:getBad',
    ]);
    expect(code).toBe(EXIT.VALIDATION);
  });

  // Review of #13: normalization keeps only method and path of an operation
  // it omits, so a METHOD /path pattern can still be told it is not exposed
  it('says a METHOD /path pattern names an operation omitted while loading the spec', async () => {
    const specText = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Omit', version: '1.0.0' },
      paths: {
        '/item': {
          get: {
            operationId: 'getItem',
            servers: [{ url: 'https://other.example.test' }],
            responses: { '200': { description: 'ok' } },
          },
        },
        '/items': { get: { operationId: 'getItems', responses: { '200': { description: 'ok' } } } },
      },
    });
    const fetcher = (() =>
      Promise.resolve(new Response(specText))) as unknown as CliContext['fetcher'];
    const { lines, ctx } = fileCtx({ fetcher });
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'https://api.example.com/x'];
    expect(await run(ctx, [...argv, '--omit-output-schema', 'route:GET /item'])).toBe(EXIT.OK);
    const envelope = JSON.parse(lines[0]!) as {
      data: { deadPatterns: { raw: string; flag: string; notExposed?: true }[] };
    };
    expect(envelope.data.deadPatterns).toEqual([
      { raw: 'route:GET /item', flag: 'omit-output-schema', notExposed: true },
    ]);
  });

  it('rejects an invalid pattern with exit 2', async () => {
    for (const pattern of ['FOO /pets', '']) {
      const { code } = await toolsJson(['--omit-output-schema', pattern]);
      expect(code).toBe(EXIT.USAGE);
    }
  });
});

// Issue kaisers-io/openapi-mcp-archive#39: a withheld output schema is reported
// in --json output.
describe('tools command — withheld output schema (kaisers-io/openapi-mcp-archive#39)', () => {
  it('reports why a response pattern with nested quantifiers left the tool without one', async () => {
    const { lines, ctx } = fileCtx();
    const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'unsafe-pattern.json'];
    const code = await run(ctx, argv);
    expect(code).toBe(EXIT.OK);
    const [row] = (
      JSON.parse(lines[0]!) as {
        data: { tools: { name: string; outputSchema: boolean; outputSchemaWithheld?: string }[] };
      }
    ).data.tools;
    expect(row).toMatchObject({ name: 'listCodes', outputSchema: false });
    expect(row?.outputSchemaWithheld).toMatch(/nested quantifiers/u);
  });
});

describe('tools command — spec credentials over plain http', () => {
  const argv = [
    'node',
    'openapi-mcp',
    'tools',
    '--spec',
    'http://specs.example.test/openapi.json',
    '--spec-header-env',
    'Authorization=SPEC_TOKEN',
    '--trust-spec-updates',
  ];
  const specCtx = () => {
    const sent: string[] = [];
    const fetcher = ((url: URL) => {
      sent.push(String(url));
      return Promise.resolve(
        Response.json({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: {} }),
      );
    }) as unknown as CliContext['fetcher'];
    return { sent, ...fileCtx({ fetcher, env: { SPEC_TOKEN: 'example-token-not-a-secret' } }) };
  };

  it('refuses before anything is sent', async () => {
    const { sent, errLines, ctx } = specCtx();
    expect(await run(ctx, argv)).toBe(EXIT.VALIDATION);
    expect(sent).toEqual([]);
    expect(errLines.join('\n')).toContain('--allow-insecure-http');
  });

  it('fetches with --allow-insecure-http', async () => {
    const { sent, ctx } = specCtx();
    expect(await run(ctx, [...argv, '--allow-insecure-http'])).toBe(EXIT.OK);
    expect(sent).toHaveLength(1);
  });
});
