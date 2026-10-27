import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './cli-subprocess.ts';

// Issue #77: `check` as its own process, with a throwaway home for its cache:
// the upload folder stays untouched, and a remote spec is the only request.

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Check', version: '1' },
  paths: {
    '/files': {
      get: { operationId: 'listFiles', responses: { '200': { description: 'ok' } } },
      post: {
        operationId: 'upload',
        requestBody: {
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

type Report = { data: { apis?: { baseUrl: string }[] } };

let dir: string;

const checkProcess = async (args: readonly string[]): Promise<{ code: number; stdout: string }> => {
  const child = spawn(process.execPath, [CLI_ENTRY, '--json', 'check', ...args], {
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '', HOME: dir, USERPROFILE: dir },
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const [code] = (await once(child, 'close')) as [number];
  return { code, stdout };
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('check as a process (issue #77)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-check-process-'));
    await writeFile(join(dir, 'spec.json'), JSON.stringify(SPEC));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names the upload folder but neither creates nor sweeps it', async () => {
    const result = await checkProcess([
      '--spec',
      'spec.json',
      '--base-url',
      'https://api.example.test',
      '--allow',
      'path:/**',
      '--uploads',
    ]);
    expect(result.code).toBe(0);
    const appRoot = join(dir, '.kaisers-io', 'openapi-mcp');
    expect(await exists(join(appRoot, 'cache'))).toBe(true);
    expect(await exists(join(appRoot, 'uploads'))).toBe(false);
  });

  it('resolves a relative servers[0] against the spec URL and requests nothing else', async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...SPEC, servers: [{ url: '/v1' }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    const origin = `http://127.0.0.1:${String(port)}`;
    try {
      const result = await checkProcess([
        '--spec',
        `${origin}/specs/openapi.json`,
        '--allow-private-network',
      ]);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      expect(report.data.apis?.[0]?.baseUrl).toBe(`${origin}/v1`);
      expect(paths).toEqual(['/specs/openapi.json']);
    } finally {
      server.close();
    }
  });
});
