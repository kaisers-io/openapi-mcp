import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';

// `serve --tool-mode` end to end (issue kaisers-io/openapi-mcp-archive#38): the
// real binary over stdio, against a real local upstream that records what it
// receives.

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));

type Recorded = { method: string | undefined; url: string | undefined; auth: string | undefined };

const startUpstream = (): Promise<{
  port: number;
  requests: Recorded[];
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    const requests: Recorded[] = [];
    const server: Server = createServer((req: IncomingMessage, res) => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, name: 'Rex' }]));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        requests,
        close: () =>
          new Promise<void>((_resolve) => {
            server.close(() => _resolve());
          }),
      });
    });
  });

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

// One stdio session: send requests one at a time, each awaited by id.
const session = (child: ReturnType<typeof spawn>) => {
  const responses = new Map<number, JsonRpcResponse>();
  const stderr: string[] = [];
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter((entry) => entry !== '')) {
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id !== undefined) {
        responses.set(message.id, message);
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'));
  });
  let nextId = 1;
  const request = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<JsonRpcResponse> => {
    const id = nextId;
    nextId += 1;
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_ENVELOPE } })}\n`,
    );
    const started = Date.now();
    while (!responses.has(id)) {
      if (Date.now() - started > 8000) {
        throw new Error(`no response to ${method}; stderr: ${stderr.join('')}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return responses.get(id) as JsonRpcResponse;
  };
  return { request, stderr };
};

const exitOf = (child: ReturnType<typeof spawn>): Promise<number | null> =>
  new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

describe('serve --tool-mode — stdio subprocess E2E', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let tempHome: string | undefined;

  afterEach(async () => {
    if (child !== undefined) {
      // Graceful, so the child writes its coverage (cli-subprocess.ts)
      await stopChild(child);
    }
    child = undefined;
    if (tempHome !== undefined) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  const spawnServe = async (args: string[], env: Record<string, string> = {}) => {
    tempHome = await mkdtemp(join(tmpdir(), 'openapi-mcp-tool-mode-'));
    child = spawn(process.execPath, [CLI_ENTRY, 'serve', '--trust-spec-updates', ...args], {
      cwd: fixturesDir,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, ...env },
    });
    return child;
  };

  it('discover: lists four tools, then search -> describe -> call_operation reaches the real upstream', async () => {
    const upstream = await startUpstream();
    try {
      const proc = await spawnServe(
        [
          '--spec',
          'petstore.json',
          '--base-url',
          `http://127.0.0.1:${String(upstream.port)}`,
          '--header-env',
          'Authorization=UPSTREAM_TOKEN',
          '--tool-mode',
          'discover',
        ],
        { UPSTREAM_TOKEN: 'Bearer example-token-not-a-secret' },
      );
      const { request } = session(proc);
      const list = await request('tools/list');
      const listed = (list.result?.['tools'] ?? []) as { name: string }[];
      expect(listed.map((tool) => tool.name)).toEqual([
        'openapi_mcp_status',
        'search_operations',
        'describe_operation',
        'call_operation',
      ]);

      const found = await request('tools/call', {
        name: 'search_operations',
        arguments: { query: 'pets' },
      });
      // Read-only default: createPet (POST) is not exposed, so not found.
      expect(found.result?.['structuredContent']).toEqual({
        results: [{ name: 'listPets', method: 'GET', path: '/pets', summary: 'List all pets' }],
        totalMatches: 1,
      });

      const described = await request('tools/call', {
        name: 'describe_operation',
        arguments: { name: 'listPets' },
      });
      expect(described.result?.['structuredContent']).toMatchObject({ name: 'listPets' });

      const called = await request('tools/call', {
        name: 'call_operation',
        arguments: { name: 'listPets', arguments: {} },
      });
      expect(called.result?.['isError']).not.toBe(true);
      expect(called.result?.['structuredContent']).toEqual({
        status: 200,
        contentType: 'application/json',
        data: [{ id: 1, name: 'Rex' }],
      });
      expect(upstream.requests).toEqual([
        { method: 'GET', url: '/pets', auth: 'Bearer example-token-not-a-secret' },
      ]);
      expect(JSON.stringify(called)).not.toContain('example-token-not-a-secret');

      // The write operation stays out of reach: no upstream request is made.
      const refused = await request('tools/call', {
        name: 'call_operation',
        arguments: { name: 'createPet', arguments: { name: 'Rex' } },
      });
      expect(refused.result?.['isError']).toBe(true);
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await upstream.close();
    }
  });

  it('warns at startup when discover exposes a non-read-only operation through call_operation', async () => {
    const proc = await spawnServe([
      '--spec',
      'petstore.json',
      '--base-url',
      'http://127.0.0.1:9',
      '--allow',
      'listPets',
      '--allow',
      'createPet',
      '--tool-mode',
      'discover',
    ]);
    const { request, stderr } = session(proc);
    // Startup diagnostics are written before the server answers
    await request('tools/list');
    const text = stderr.join('');
    expect(text).toContain(
      '--tool-mode discover exposes 1 non-read-only operation(s) (createPet) through the single call_operation tool',
    );
    expect(text).toContain('--tool-mode per-operation');
  });

  it('does not warn about approval under discover when every exposed operation is read-only', async () => {
    const proc = await spawnServe([
      '--spec',
      'petstore.json',
      '--base-url',
      'http://127.0.0.1:9',
      '--tool-mode',
      'discover',
    ]);
    const { request, stderr } = session(proc);
    await request('tools/list');
    expect(stderr.join('')).not.toContain('non-read-only');
  });

  it('lifts the 512-tool budget for discover only: 600 exposed operations fail per-operation and serve under discover and auto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openapi-mcp-big-spec-'));
    try {
      const paths = Object.fromEntries(
        Array.from({ length: 600 }, (_unused, index) => [
          `/r${String(index)}`,
          {
            get: {
              operationId: `op${String(index)}`,
              responses: { '200': { description: 'ok' } },
            },
          },
        ]),
      );
      const specPath = join(dir, 'big.json');
      await writeFile(
        specPath,
        JSON.stringify({ openapi: '3.1.0', info: { title: 'big', version: '1' }, paths }),
      );
      const base = ['--spec', specPath, '--base-url', 'http://127.0.0.1:9'];

      const perOperation = await spawnServe(base);
      let stderr = '';
      perOperation.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      expect(await exitOf(perOperation)).toBe(3);
      expect(stderr).toContain('600 tools would be exposed after filtering');
      await rm(tempHome as string, { recursive: true, force: true });

      for (const mode of ['discover', 'auto']) {
        const proc = await spawnServe([...base, '--tool-mode', mode]);
        const { request } = session(proc);
        const list = await request('tools/list');
        expect(list.result?.['tools']).toHaveLength(4);
        const status = await request('tools/call', { name: 'openapi_mcp_status', arguments: {} });
        expect(status.result?.['structuredContent']).toMatchObject({ toolCount: 600 });
        proc.kill('SIGTERM');
        await exitOf(proc);
        await rm(tempHome as string, { recursive: true, force: true });
      }
      tempHome = undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('rejects an unknown --tool-mode as a usage error before any spec work', async () => {
    const proc = await spawnServe(['--spec', 'does-not-exist.json', '--tool-mode', 'dynamic']);
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    expect(await exitOf(proc)).toBe(2);
    expect(stderr).toContain('--tool-mode "dynamic" is not one of per-operation, discover, auto');
  });
});
