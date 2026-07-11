import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext, type CliContext } from '../src/context.ts';
import { run } from '../src/main.ts';

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

interface Capture {
  lines: string[];
  errLines: string[];
  ctx: CliContext;
}

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
  it('lists tools and omissions in human mode', async () => {
    const { lines, ctx } = fileCtx();
    const code = await run(ctx, ['node', 'openapi-mcp', 'tools', '--spec', 'petstore.json']);
    expect(code).toBe(EXIT.OK);
    const text = lines.join('\n');
    expect(text).toContain('Petstore 1.0.0 (OpenAPI 3.1) — 2 tools');
    expect(text).toContain('listPets');
    expect(text).toContain('createPet');
    expect(text).toContain('omitted operations:');
    expect(text).toContain('cookie parameters are not supported');
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
    }) as typeof fetch;
    const { lines, ctx } = fileCtx({ fetcher, env: { SPEC_TOKEN: 'Bearer super-secret' } });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
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
      Promise.resolve(new Response('denied', { status: 401 }))) as typeof fetch;
    const { lines, errLines, ctx } = fileCtx({ fetcher, env: { SPEC_TOKEN: secret } });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'https://api.example.com/openapi.json?page=1',
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
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
