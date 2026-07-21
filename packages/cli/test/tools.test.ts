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
  it('lists tools in human mode and reports omissions as warnings', async () => {
    const { lines, errLines, ctx } = fileCtx();
    const code = await run(ctx, ['node', 'openapi-mcp', 'tools', '--spec', 'petstore.json']);
    expect(code).toBe(EXIT.OK);
    const text = lines.join('\n');
    // The read-only default (spec §3.2 rule 3) hides the POST
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
      '**',
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
      'createPet',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('createPet');
    // An explicit allow replaces the read-only default entirely (spec §3.2 rule 2)
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
      '**',
      '--deny',
      'createPet',
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
      'listPets',
      '--allow',
      'createPet',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('listPets');
    expect(lines.join('\n')).toContain('createPet');
  });

  it('warns about a dead pattern with the spec §8 wording', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'listPetz',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(errLines.join('\n')).toContain(
      'openapi-mcp: warning: --allow "listPetz" matches no operation; closest: listPets',
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
      'nothingLikeThis',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(errLines.join('\n')).toContain('--deny "nothingLikeThis" matches no operation');
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
      'listPetz',
      '--strict-filters',
    ]);
    expect(code).toBe(EXIT.VALIDATION);
    expect(errLines.join('\n')).toContain('closest: listPets');
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
      'GET  /double/space',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).not.toContain('should not be read');
  });

  it('rejects an over-long pattern with exit 2 (D15)', async () => {
    const { ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      'a'.repeat(300),
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('rejects a pattern with too many wildcards with exit 2 (D15)', async () => {
    const { errLines, ctx } = fileCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      'petstore.json',
      '--allow',
      '*a'.repeat(20),
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(errLines.join('\n')).toContain('wildcard');
  });

  it('rejects more patterns than the count bound allows with exit 2 (D15)', async () => {
    const { ctx } = fileCtx();
    const many = Array.from({ length: 129 }, (_unused, index) => [
      '--allow',
      `op${String(index)}`,
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
      'listPetz',
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
      { raw: 'listPetz', flag: 'allow', suggestion: 'listPets' },
    ]);
    expect(envelope.warnings.join('\n')).toContain('--allow "listPetz"');
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

  it('rejects an authenticated spec with no cache decision with exit 2 (D13)', async () => {
    const fetcher = (() => Promise.resolve(new Response('{}'))) as typeof fetch;
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

  it('accepts an authenticated spec under --trust-spec-updates as a bypass (D13)', async () => {
    const specText = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Remote', version: '1.0.0' },
      paths: {
        '/things': {
          get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
        },
      },
    });
    const fetcher = (() => Promise.resolve(new Response(specText))) as typeof fetch;
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
});
