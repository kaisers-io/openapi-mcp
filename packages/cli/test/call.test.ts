import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import type { CliContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// Issue #78: `call --dry-run` builds the request a tool call would send and
// describes it. call-process.test.ts covers the requests that are never
// sent, secrets, uploads and the parity with `serve`.

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Call', version: '1' },
  servers: [{ url: 'https://api.example.test/v1' }],
  paths: {
    '/things/{id}': {
      get: {
        operationId: 'getThing',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'fields', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
      put: {
        operationId: 'putThing',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '204': { description: 'stored' } },
      },
    },
  },
};

let dir: string;

type Report = {
  ok: boolean;
  data?: {
    tool: string;
    method: string;
    origin: string;
    path: string;
    query: string[];
    headers: { name: string }[];
    body: unknown;
    checks: Record<string, { status: string; reason?: string }>;
    notEvaluated: string[];
  };
  error?: { code: string; message: string };
};

const callCli = async (
  args: readonly string[],
  overrides: { resolve?: string[]; json?: boolean; env?: Record<string, string> } = {},
) => {
  const lines: string[] = [];
  const errLines: string[] = [];
  let sent = 0;
  const transport: CliContext['transport'] = {
    fetch: () => {
      sent += 1;
      return Promise.reject(new Error('nothing may be sent'));
    },
    resolve: () => Promise.resolve(overrides.resolve ?? ['93.184.215.14']),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
  const ctx = testContext({
    lines,
    errLines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => dir,
    env: overrides.env ?? {},
    // The startup check of a spec-derived base URL
    lookup: () => Promise.resolve(['93.184.215.14']),
    transport,
  });
  const code = await run(ctx, [
    'node',
    'openapi-mcp',
    ...(overrides.json === false ? [] : ['--json']),
    'call',
    ...args,
  ]);
  return { code, lines, errLines, sent };
};

const reportOf = (lines: readonly string[]): Report => JSON.parse(lines.join('\n')) as Report;

describe('call --dry-run (issue #78)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-call-'));
    await writeFile(join(dir, 'spec.json'), JSON.stringify(SPEC));
    await writeFile(
      join(dir, 'http.json'),
      JSON.stringify({ ...SPEC, servers: [{ url: 'http://api.example.test' }] }),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('describes the request under the spec-derived base URL', async () => {
    const result = await callCli([
      'getThing',
      '--dry-run',
      '--spec',
      'spec.json',
      '--args-json',
      '{"id":"a b","fields":"name"}',
    ]);
    expect(result.code).toBe(EXIT.OK);
    expect(reportOf(result.lines)).toMatchObject({
      ok: true,
      data: {
        tool: 'getThing',
        method: 'GET',
        origin: 'https://api.example.test',
        path: '/v1/things/a%20b',
        query: ['fields'],
        headers: [{ name: 'accept' }],
        body: 'none',
        checks: {
          route: { status: 'allowed' },
          egress: { status: 'allowed' },
          budgets: { status: 'allowed' },
        },
      },
    });
    expect(result.sent).toBe(0);
  });

  it('reports a refused egress check with exit 3', async () => {
    const result = await callCli(
      ['getThing', '--dry-run', '--spec', 'spec.json', '--args-json', '{"id":"1"}'],
      { resolve: ['10.0.0.5'] },
    );
    expect(result.code).toBe(EXIT.VALIDATION);
    const report = reportOf(result.lines);
    expect(report.ok).toBe(false);
    expect(report.data?.checks['egress']).toMatchObject({ status: 'refused' });
    expect(result.sent).toBe(0);
  });

  it('takes the operation name in discover mode', async () => {
    const result = await callCli([
      'getThing',
      '--dry-run',
      '--spec',
      'spec.json',
      '--tool-mode',
      'discover',
      '--args-json',
      '{"id":"1"}',
    ]);
    expect(result.code).toBe(EXIT.OK);
    expect(reportOf(result.lines).data?.path).toBe('/v1/things/1');
  });

  it('prints the report as lines without --json', async () => {
    const result = await callCli(
      ['getThing', '--dry-run', '--spec', 'spec.json', '--args-json', '{"id":"1"}'],
      { json: false },
    );
    expect(result.code).toBe(EXIT.OK);
    expect(result.lines).toEqual([
      'getThing: GET https://api.example.test/v1/things/1',
      'query: none',
      'headers: accept',
      'body: none',
      'route: allowed',
      'egress: allowed',
      'budgets: allowed',
      expect.stringMatching(/^not evaluated: redirects/u),
    ]);
  });

  it.each([
    [['getThing', '--spec', 'spec.json'], '--dry-run'],
    [['getThing', '--dry-run', '--spec', 'spec.json', '--args-json', '{'], 'not valid JSON'],
    [['nope', '--dry-run', '--spec', 'spec.json'], 'no exposed operation'],
    [['openapi_mcp_status', '--dry-run', '--spec', 'spec.json'], 'no exposed operation'],
  ])('refuses %j with a usage error', async (args, text) => {
    const result = await callCli(args);
    expect(result.code).toBe(EXIT.USAGE);
    expect(reportOf(result.lines).error?.message).toContain(text);
    expect(result.sent).toBe(0);
  });

  it('refuses a missing argument with the tool error', async () => {
    const result = await callCli(['getThing', '--dry-run', '--spec', 'spec.json']);
    expect(result.code).toBe(EXIT.VALIDATION);
    expect(reportOf(result.lines).error).toMatchObject({
      code: 'tool_error',
      message: expect.stringMatching(/^invalid tool arguments:/u) as unknown,
    });
  });

  it('prints the body, a credential and a refused check as lines', async () => {
    const result = await callCli(
      [
        'putThing',
        '--dry-run',
        '--spec',
        'spec.json',
        '--allow',
        'method:put',
        '--header-env',
        'X-Api-Key=API_KEY',
        '--args-json',
        '{"id":"1","body":{"name":"box"}}',
      ],
      { json: false, resolve: ['10.0.0.5'], env: { API_KEY: 'example-token-not-a-secret' } },
    );
    expect(result.code).toBe(EXIT.VALIDATION);
    const bodyBytes = String(JSON.stringify({ name: 'box' }).length);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        'putThing: PUT https://api.example.test/v1/things/1',
        'headers: accept, content-type, x-api-key (set)',
        `body: application/json, ${bodyBytes} bytes`,
        expect.stringMatching(
          /^egress: refused \(egress: "api\.example\.test" resolves to a private/u,
        ),
      ]),
    );
    expect([...result.lines, ...result.errLines].join('\n')).not.toContain(
      'example-token-not-a-secret',
    );
    expect(result.sent).toBe(0);
  });

  it('redacts a configured secret that reaches the report through an argument', async () => {
    const secret = 'example-token-not-a-secret';
    const args = [
      'getThing',
      '--dry-run',
      '--spec',
      'spec.json',
      '--header-env',
      'X-Token=DEMO_TOKEN',
      '--args-json',
      JSON.stringify({ id: secret }),
    ];
    const env = { DEMO_TOKEN: secret };
    const json = await callCli(args, { env });
    const human = await callCli(args, { env, json: false });
    expect(json.code).toBe(EXIT.OK);
    expect(reportOf(json.lines).data?.path).toMatch(/^\/v1\/things\//u);
    for (const result of [json, human]) {
      expect([...result.lines, ...result.errLines].join('\n')).not.toContain(secret);
    }
  });

  it('uses the configuration of the API the tool belongs to', async () => {
    const result = await callCli(
      [
        'b_getThing',
        '--dry-run',
        '--api',
        'a=spec.json',
        '--api',
        'b=spec.json',
        '--cache-key',
        'b=b',
        '--base-url',
        'a=https://a.example.test/v1',
        '--base-url',
        'b=https://b.example.test/v2',
        '--header-env',
        'b=Authorization=B_TOKEN',
        '--args-json',
        '{"id":"1"}',
      ],
      { env: { B_TOKEN: 'b-secret' } },
    );
    expect(result.code).toBe(EXIT.OK);
    expect(reportOf(result.lines).data).toMatchObject({
      tool: 'b_getThing',
      origin: 'https://b.example.test',
      path: '/v2/things/1',
      headers: [{ name: 'accept' }, { name: 'authorization', credential: 'set' }],
    });
  });

  it('refuses what serve refuses before sending, with its tool error', async () => {
    const result = await callCli(
      [
        'getThing',
        '--dry-run',
        '--spec',
        'http.json',
        '--header-env',
        'X-Api-Key=API_KEY',
        '--args-json',
        '{"id":"1"}',
      ],
      { env: { API_KEY: 'example-token-not-a-secret' } },
    );
    expect(result.code).toBe(EXIT.VALIDATION);
    expect(reportOf(result.lines).error).toMatchObject({
      code: 'tool_error',
      message: expect.stringContaining('cleartext') as unknown,
    });
    expect(result.sent).toBe(0);
  });
});
