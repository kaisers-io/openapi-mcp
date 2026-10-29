import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// Issue #77: `check` runs the startup of `serve` with the same options and
// reports it, without serving and without calling an operation.

const SENTINEL = 'sentinel-value-not-a-secret';
const BASE = ['--base-url', 'https://api.example.test'];

const ok = (schema?: Record<string, unknown>) => ({
  '200': {
    description: 'ok',
    ...(schema === undefined ? {} : { content: { 'application/json': { schema } } }),
  },
});
const specWith = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'Check', version: '1' },
  paths,
  ...extra,
});
const reads = (count: number, description = '') =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `/items${String(index)}`,
      {
        get: {
          operationId: `getItem${String(index)}`,
          ...(description === '' ? {} : { description }),
          responses: ok({ type: 'object' }),
        },
      },
    ]),
  );

const SPECS: Record<string, unknown> = {
  'small.json': specWith(reads(2)),
  'many.json': specWith(reads(70)),
  // 64 usable reads, the auto threshold, and a HEAD whose GET is denied
  'head-at-threshold.json': specWith({
    ...reads(64),
    '/hidden/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getHidden', responses: ok() },
      head: { operationId: 'headHidden', responses: ok() },
    },
  }),
  'large.json': specWith(reads(12, 'd'.repeat(4000))),
  'bad-pattern.json': specWith({
    '/x': {
      get: {
        operationId: 'getX',
        // An invalid pattern, with a terminal escape the human output must not pass on
        responses: ok({
          type: 'object',
          properties: { id: { type: 'string', pattern: '(\u001B[2J' } },
        }),
      },
    },
  }),
  'oauth.json': specWith(reads(1), {
    components: {
      securitySchemes: {
        cc: {
          type: 'oauth2',
          flows: {
            clientCredentials: { tokenUrl: 'https://api.example.test/token', scopes: {} },
          },
        },
      },
    },
    security: [{ cc: [] }],
  }),
};

let dir: string;

type Report = {
  ok: boolean;
  data: {
    environment: { status: string; variables: { name: string; flag: string; set: boolean }[] };
    startup: { status: string; error?: { code: string; message: string } };
    toolMode?: string;
    toolModeReason?: string;
    apis?: { name?: string; baseUrl: string; exposed: string[] }[];
    listedTools?: string[];
  };
  warnings: string[];
};

const check = async (
  args: readonly string[],
  env: Record<string, string> = {},
  global: readonly string[] = ['--json'],
) => {
  const lines: string[] = [];
  const errLines: string[] = [];
  const ctx = testContext({
    lines,
    errLines,
    env,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => dir,
  });
  const code = await run(ctx, ['node', 'openapi-mcp', ...global, 'check', ...args]);
  return { code, lines, errLines };
};

const reportOf = (lines: readonly string[]): Report => JSON.parse(lines.join('\n')) as Report;

describe('check (issue #77)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-check-'));
    for (const [name, spec] of Object.entries(SPECS)) {
      await writeFile(join(dir, name), JSON.stringify(spec));
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists every missing variable, never a value, and skips the startup', async () => {
    const result = await check(
      [
        '--spec',
        'small.json',
        ...BASE,
        '--header-env',
        'Authorization=PRESENT_TOKEN',
        '--header-env',
        'X-Key=MISSING_KEY',
        '--upstream-oauth-client-id-env',
        'MISSING_ID',
        '--upstream-oauth-client-secret-env',
        'PRESENT_SECRET',
      ],
      { PRESENT_TOKEN: SENTINEL, PRESENT_SECRET: SENTINEL },
    );
    expect(result.code).toBe(EXIT.USAGE);
    const report = reportOf(result.lines);
    expect(report.ok).toBe(false);
    expect(report.data.environment).toEqual({
      status: 'failed',
      reason: 'env_missing',
      variables: [
        { name: 'PRESENT_TOKEN', flag: '--header-env', set: true },
        { name: 'MISSING_KEY', flag: '--header-env', set: false },
        { name: 'MISSING_ID', flag: '--upstream-oauth-client-id-env', set: false },
        { name: 'PRESENT_SECRET', flag: '--upstream-oauth-client-secret-env', set: true },
      ],
    });
    expect(report.data.startup).toEqual({ status: 'skipped' });
    expect([...result.lines, ...result.errLines].join('\n')).not.toContain(SENTINEL);
  });

  it('reports the tools, the base URL and the tool mode of a working setup', async () => {
    const result = await check(
      ['--spec', 'small.json', ...BASE, '--header-env', 'Authorization=TOKEN'],
      { TOKEN: SENTINEL },
      ['--json', '--verbose'],
    );
    expect(result.code).toBe(EXIT.OK);
    const report = reportOf(result.lines);
    expect(report.ok).toBe(true);
    expect(report.data).toMatchObject({
      startup: { status: 'ok' },
      toolMode: 'per-operation',
      apis: [{ baseUrl: 'https://api.example.test/', exposed: ['getItem0', 'getItem1'] }],
      listedTools: ['openapi_mcp_status', 'getItem0', 'getItem1', 'execute_code'],
    });
    expect(report.data.toolModeReason).toBeUndefined();
    expect([...result.lines, ...result.errLines].join('\n')).not.toContain(SENTINEL);
  });

  it('reports a missing base URL as a failed startup', async () => {
    const result = await check(['--spec', 'small.json']);
    expect(result.code).toBe(EXIT.USAGE);
    const report = reportOf(result.lines);
    expect(report.data.environment.status).toBe('ok');
    expect(report.data.startup.status).toBe('failed');
    expect(report.data.startup.error?.message).toContain('--base-url');
  });

  it('reports an OAuth scheme the spec does not have', async () => {
    const result = await check(
      [
        '--spec',
        'oauth.json',
        ...BASE,
        '--upstream-oauth-client-id-env',
        'ID',
        '--upstream-oauth-client-secret-env',
        'SECRET',
        '--upstream-oauth-scheme',
        'nope',
      ],
      { ID: SENTINEL, SECRET: SENTINEL },
    );
    expect(result.code).toBe(EXIT.USAGE);
    expect(reportOf(result.lines).data.startup.error?.message).toContain('--upstream-oauth-scheme');
    expect(result.lines.join('\n')).not.toContain(SENTINEL);
  });

  it('reports two APIs whose base URLs overlap', async () => {
    const result = await check([
      '--api',
      'a=small.json',
      '--api',
      'b=many.json',
      '--base-url',
      'a=https://api.example.test',
      '--base-url',
      'b=https://api.example.test/v1',
    ]);
    expect(result.code).not.toBe(EXIT.OK);
    expect(reportOf(result.lines).data.startup.error?.message).toContain('overlap');
  });

  it('names the variables of each API', async () => {
    const result = await check(
      [
        '--api',
        'a=small.json',
        '--api',
        'b=many.json',
        '--base-url',
        'a=https://a.example.test',
        '--base-url',
        'b=https://b.example.test',
        '--header-env',
        'b=Authorization=B_TOKEN',
      ],
      { B_TOKEN: SENTINEL },
    );
    expect(result.code).toBe(EXIT.OK);
    const report = reportOf(result.lines);
    expect(report.data.environment.variables).toEqual([
      { name: 'B_TOKEN', flag: '--header-env', api: 'b', set: true },
    ]);
    expect(report.data.apis?.map((api) => api.name)).toEqual(['a', 'b']);
  });

  it('says why auto chose discover: by count and by size', async () => {
    const many = await check(['--spec', 'many.json', ...BASE, '--tool-mode', 'auto']);
    const byCount = reportOf(many.lines);
    expect(byCount.data).toMatchObject({ toolMode: 'discover', toolModeReason: 'count' });
    expect(byCount.data.listedTools).toEqual([
      'openapi_mcp_status',
      'search_operations',
      'describe_operation',
      'call_operation',
      'execute_code',
    ]);
    expect(byCount.data.apis?.[0]?.exposed).toHaveLength(70);
    const large = await check(['--spec', 'large.json', ...BASE, '--tool-mode', 'auto']);
    const bySize = reportOf(large.lines);
    expect(bySize.data).toMatchObject({ toolMode: 'discover', toolModeReason: 'size' });
  });

  // Issue #68: a HEAD left out for its denied GET is not counted
  it('decides auto without a HEAD that no call can pass', async () => {
    const result = await check([
      '--spec',
      'head-at-threshold.json',
      ...BASE,
      '--tool-mode',
      'auto',
      '--deny',
      'route:GET /hidden/**',
    ]);
    const report = reportOf(result.lines);
    expect(report.data.toolMode).toBe('per-operation');
    expect(report.data.toolModeReason).toBeUndefined();
    expect(report.data.apis?.[0]?.exposed).toHaveLength(64);
    expect(report.warnings.join('\n')).not.toContain('--tool-mode auto');
  });

  it('compiles every output schema under discover, which serve leaves to the first call', async () => {
    const result = await check(['--spec', 'bad-pattern.json', ...BASE, '--tool-mode', 'discover']);
    expect(result.code).toBe(EXIT.USAGE);
    expect(reportOf(result.lines).data.startup.error?.message).toContain('getX');
  });

  it('lists the variables of --spec-header-env and --http-token-env', async () => {
    const result = await check([
      '--spec',
      'small.json',
      ...BASE,
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--http',
      '--http-token-env',
      'HTTP_TOKEN',
    ]);
    expect(result.code).toBe(EXIT.USAGE);
    expect(reportOf(result.lines).data.environment.variables).toEqual([
      { name: 'SPEC_TOKEN', flag: '--spec-header-env', set: false },
      { name: 'HTTP_TOKEN', flag: '--http-token-env', set: false },
    ]);
  });

  it('prints a failed startup and the API names without --json', async () => {
    const failed = await check(['--spec', 'small.json'], {}, []);
    expect(failed.code).toBe(EXIT.USAGE);
    expect(failed.lines[1]).toMatch(/^startup: failed: .*--base-url/u);
    const named = await check(
      [
        '--api',
        'a=small.json',
        '--base-url',
        'a=https://a.example.test',
        '--header-env',
        'a=Authorization=A_TOKEN',
      ],
      { A_TOKEN: SENTINEL },
      [],
    );
    expect(named.code).toBe(EXIT.OK);
    expect(named.lines).toEqual([
      'environment: ok',
      '  A_TOKEN (a --header-env): set',
      'startup: ok',
      'tool mode: per-operation',
      'api a: https://a.example.test/, 2 operations exposed',
      'tools the host lists: 4',
    ]);
  });

  it('discovers the authorization server of --http-auth oauth, as serve does', async () => {
    const result = await check([
      '--spec',
      'small.json',
      ...BASE,
      '--http',
      '--http-auth',
      'oauth',
      '--oauth-issuer',
      'not-a-url',
      '--oauth-audience',
      'also-not-a-url',
    ]);
    expect(result.code).not.toBe(EXIT.OK);
    expect(reportOf(result.lines).data.startup.status).toBe('failed');
  });

  it('prints a failed startup as one sanitized line without --json', async () => {
    const result = await check(
      ['--spec', 'bad-pattern.json', ...BASE, '--tool-mode', 'discover'],
      {},
      [],
    );
    expect(result.code).toBe(EXIT.USAGE);
    const output = result.lines.join('\n');
    expect(output).toContain('startup: failed');
    expect(output).not.toContain('\u001B');
  });

  it('refuses a variable name with control characters before it reports anything', async () => {
    const result = await check(
      ['--spec', 'small.json', ...BASE, '--http', '--http-token-env', 'BAD\n\u001B[2Jstartup: ok'],
      {},
      [],
    );
    expect(result.code).toBe(EXIT.USAGE);
    const output = [...result.lines, ...result.errLines].join('\n');
    expect(output).not.toContain('\u001B');
    expect(output).not.toContain('startup: ok');
  });

  it('prints a human report and the warnings on stderr without --json', async () => {
    const result = await check(['--spec', 'many.json', ...BASE, '--tool-mode', 'auto'], {}, []);
    expect(result.code).toBe(EXIT.OK);
    expect(result.lines).toEqual([
      'environment: ok',
      'startup: ok',
      'tool mode: discover (auto: count)',
      'api: https://api.example.test/, 70 operations exposed',
      'tools the host lists: 5',
    ]);
    expect(
      result.errLines.some((line) => line.startsWith('openapi-mcp: warning: --tool-mode auto')),
    ).toBe(true);
  });
});
