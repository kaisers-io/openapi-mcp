import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultUploadDir } from '../src/upload-options.ts';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #78: `call --dry-run` as its own process. It sends nothing to the
// operation's URL or to the OAuth token endpoint, prints no secret, and
// refuses arguments with the same text a host gets from `serve`.

const SENTINEL = 'sentinel-value-not-a-secret';

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Call', version: '1' },
  paths: {
    '/things': {
      post: {
        operationId: 'createThing',
        parameters: [{ name: 'dryRunTag', in: 'query', schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
        responses: { '201': { description: 'created' } },
      },
    },
  },
  components: {
    securitySchemes: {
      cc: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://auth.example.test/token', scopes: {} } },
      },
    },
  },
  security: [{ cc: [] }],
};

const UPLOAD_SPEC = {
  openapi: '3.1.0',
  info: { title: 'Upload', version: '1' },
  paths: {
    '/image': {
      put: {
        operationId: 'putImage',
        requestBody: {
          required: true,
          content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: { '204': { description: 'stored' } },
      },
    },
  },
};

// A PNG header for a 4x3 image
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);

let dir: string;
let api: Server;
let auth: Server;
const requests: string[] = [];

const listen = async (name: string): Promise<{ server: Server; origin: string }> => {
  const server = createServer((req, res) => {
    requests.push(`${name} ${req.method ?? ''} ${req.url ?? ''}`);
    res.writeHead(500);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { server, origin: `http://127.0.0.1:${String(port)}` };
};

let apiOrigin: string;
let authOrigin: string;

const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: dir,
  USERPROFILE: dir,
  API_KEY: SENTINEL,
  CLIENT_ID: SENTINEL,
  CLIENT_SECRET: SENTINEL,
});

const options = (): string[] => [
  '--spec',
  'spec.json',
  '--base-url',
  apiOrigin,
  '--allow',
  'path:/**',
  '--header-env',
  `X-Api-Key=API_KEY`,
  '--upstream-oauth-client-id-env',
  'CLIENT_ID',
  '--upstream-oauth-client-secret-env',
  'CLIENT_SECRET',
  '--upstream-oauth-token-url',
  `${authOrigin}/token`,
  // The token server listens on loopback
  '--allow-private-network',
];

const callProcess = async (
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const child = spawn(process.execPath, [CLI_ENTRY, '--json', 'call', ...args], {
    cwd: dir,
    env: env(),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, 'close')) as [number];
  return { code, stdout, stderr };
};

// The text a host gets from `serve` for one tools/call
const serveCall = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const child = spawn(process.execPath, [CLI_ENTRY, 'serve', ...options()], {
    cwd: dir,
    env: env(),
  });
  let buffer = '';
  const replies = new Map<number, string>();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter((entry) => entry !== '')) {
      const message = JSON.parse(line) as {
        id?: number;
        result?: { content?: { text?: string }[] };
      };
      if (message.id !== undefined) {
        replies.set(message.id, message.result?.content?.[0]?.text ?? '');
      }
    }
  });
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: meta } })}\n`,
  );
  try {
    const started = Date.now();
    while (!replies.has(1) && Date.now() - started < SUBPROCESS_WAIT_MS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return replies.get(1) ?? '';
  } finally {
    await stopChild(child);
  }
};

describe('call --dry-run as a process (issue #78)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-call-process-'));
    await writeFile(join(dir, 'spec.json'), JSON.stringify(SPEC));
    await writeFile(join(dir, 'upload.json'), JSON.stringify(UPLOAD_SPEC));
    const uploads = defaultUploadDir(dir, join(dir, 'upload.json'), dir);
    await mkdir(uploads, { recursive: true, mode: 0o700 });
    await writeFile(join(uploads, 'photo.png'), PNG);
    ({ server: api, origin: apiOrigin } = await listen('api'));
    ({ server: auth, origin: authOrigin } = await listen('auth'));
  });

  afterAll(async () => {
    api.close();
    auth.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('describes the request, sends nothing and prints no secret', async () => {
    requests.length = 0;
    const result = await callProcess([
      'createThing',
      '--dry-run',
      '--args-json',
      JSON.stringify({ name: 'box', dryRunTag: 'a' }),
      ...options(),
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(report.ok).toBe(true);
    expect(report.data).toMatchObject({
      tool: 'createThing',
      method: 'POST',
      origin: apiOrigin,
      path: '/things',
      query: ['dryRunTag'],
      body: { mediaType: 'application/json', bytes: JSON.stringify({ name: 'box' }).length },
      checks: { route: { status: 'allowed' }, budgets: { status: 'allowed' } },
    });
    expect(report.data['headers']).toEqual(
      expect.arrayContaining([
        { name: 'x-api-key', credential: 'set' },
        { name: 'authorization', credential: 'not evaluated' },
      ]),
    );
    expect(requests).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SENTINEL);
  });

  it('refuses invalid arguments with the text serve gives a host', async () => {
    requests.length = 0;
    const args = { name: 7, extra: true };
    const result = await callProcess([
      'createThing',
      '--dry-run',
      '--args-json',
      JSON.stringify(args),
      ...options(),
    ]);
    expect(result.code).toBe(3);
    const envelope = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('tool_error');
    expect(envelope.error.message).toMatch(/^invalid tool arguments:/u);
    expect(envelope.error.message).toBe(await serveCall('createThing', args));
    expect(requests).toEqual([]);
  });

  it('names an upload with its size', async () => {
    requests.length = 0;
    const result = await callProcess([
      'putImage',
      '--dry-run',
      '--args-json',
      JSON.stringify({ body: { file: 'photo.png' } }),
      '--spec',
      join(dir, 'upload.json'),
      '--base-url',
      apiOrigin,
      '--allow',
      'path:/**',
      '--uploads',
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { data: Record<string, unknown> };
    expect(report.data).toMatchObject({
      body: { mediaType: 'image/png', bytes: PNG.byteLength },
      uploads: [{ field: 'body', file: 'photo.png', bytes: PNG.byteLength }],
    });
    expect(requests).toEqual([]);
  });
});
