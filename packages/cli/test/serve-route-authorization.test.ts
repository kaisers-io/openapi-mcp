import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_TEST_TIMEOUT_MS, SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #40: an exposed tool must not reach an operation the filters exclude,
// neither through its arguments nor through a redirect. The real CLI over
// stdio, against local upstreams that record every request they receive.

const ok = { '200': { description: 'ok' } };
const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: ok,
      },
    },
    '/items/export': { get: { operationId: 'exportItems', responses: ok } },
    '/safe': { get: { operationId: 'safe', responses: ok } },
    '/denied': { get: { operationId: 'denied', responses: ok } },
    '/orders': { post: { operationId: 'createOrder', responses: ok } },
    '/download': { get: { operationId: 'download', responses: ok } },
    '/notes/{noteId}/items': {
      get: {
        operationId: 'listNoteItems',
        parameters: [{ name: 'noteId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: ok,
      },
    },
    '/notes/{noteId}/{part}': {
      get: {
        operationId: 'getNotePart',
        parameters: [
          { name: 'noteId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'part', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: ok,
      },
    },
  },
};
const DENY = [
  '--allow',
  'path:/**',
  '--deny',
  'route:GET /items/export',
  '--deny',
  'route:GET /denied',
  '--deny',
  'operationId:getNotePart',
];

describe('serve — request authorization (issue #40)', () => {
  let home: string;
  let specPath: string;
  let api: Server;
  let storage: Server;
  let baseUrl: string;
  const received: string[] = [];

  const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp-routes-'));
    specPath = join(home, 'shop.json');
    writeFileSync(specPath, JSON.stringify(SPEC));
    storage = createServer((req, res) => {
      received.push(`storage ${req.method ?? ''} ${req.url ?? ''}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"file":true}');
    });
    const storageUrl = await listen(storage);
    const redirects: Record<string, [number, string]> = {
      '/safe': [302, '/denied'],
      '/orders': [303, '/denied'],
      '/download': [302, `${storageUrl}/file`],
    };
    api = createServer((req, res) => {
      received.push(`api ${req.method ?? ''} ${req.url ?? ''}`);
      req.resume();
      const redirect = redirects[req.url ?? ''];
      if (redirect !== undefined) {
        res.writeHead(redirect[0], { location: redirect[1] });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    baseUrl = await listen(api);
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await Promise.all(
      [api, storage].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    rmSync(home, { recursive: true, force: true });
  });

  // One tools/call per entry; returns each call's text and error flag
  const call = async (
    extraArgs: readonly string[],
    calls: readonly { name: string; arguments: Record<string, unknown> }[],
  ): Promise<{ isError: boolean; text: string }[]> => {
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'serve',
        '--trust-spec-updates',
        '--spec',
        specPath,
        '--base-url',
        baseUrl,
        '--retries',
        '2',
        ...extraArgs,
      ],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    const results = new Map<number, { isError: boolean; text: string }>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((entry) => entry !== '')) {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { isError?: boolean; content?: { text: string }[] };
        };
        if (message.id !== undefined) {
          results.set(message.id, {
            isError: message.result?.isError === true,
            text: message.result?.content?.[0]?.text ?? '',
          });
        }
      }
    });
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    try {
      for (const [index, params] of calls.entries()) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { ...params, _meta: meta } })}\n`,
        );
      }
      const started = Date.now();
      while (results.size < calls.length && Date.now() - started < SUBPROCESS_WAIT_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      return calls.map(
        (_call, index) => results.get(index + 1) ?? { isError: true, text: 'no reply' },
      );
    } finally {
      await stopChild(child);
    }
  };

  it(
    'refuses arguments that turn the URL into an excluded operation, and sends nothing',
    async () => {
      const [refused, allowed] = await call(DENY, [
        { name: 'getItem', arguments: { id: 'export' } },
        { name: 'getItem', arguments: { id: '42' } },
      ]);
      expect(refused).toEqual({
        isError: true,
        text: "tool execution failed: the request was not sent: with these arguments its URL is not this tool's own operation of the API",
      });
      expect(allowed?.isError).toBe(false);
      expect(received).toEqual(['api GET /items/42']);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'does not follow a redirect to an excluded operation, and does not retry',
    async () => {
      const [redirected, afterWrite] = await call(DENY, [
        { name: 'safe', arguments: {} },
        { name: 'createOrder', arguments: {} },
      ]);
      expect(redirected?.isError).toBe(true);
      expect(redirected?.text).toContain(
        'redirected to a URL that is not an operation this server exposes',
      );
      // After a POST the text says the request may already have been applied
      expect(afterWrite?.text).toContain('may have been applied, so do not retry it blindly');
      // Both calls are written at once and run in parallel, so their order
      // at the upstream is not fixed
      expect(received.toSorted()).toEqual(['api GET /safe', 'api POST /orders']);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'follows a redirect off the API only with --allow-offsite-redirects',
    async () => {
      const [without] = await call(
        [...DENY, '--allow-private-network'],
        [{ name: 'download', arguments: {} }],
      );
      expect(without?.text).toContain('redirected outside the API base URL');
      expect(received).toEqual(['api GET /download']);
      received.length = 0;
      const [opted] = await call(
        [...DENY, '--allow-private-network', '--allow-offsite-redirects'],
        [{ name: 'download', arguments: {} }],
      );
      expect(opted).toEqual({ isError: false, text: '{"file":true}' });
      expect(received).toEqual(['api GET /download', 'storage GET /file']);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Issue #41: the URL is the tool's own operation, but also matches one
  // that is not exposed, so the text does not blame the arguments
  it(
    'refuses a URL another excluded template shares, and counts what is not exposed',
    async () => {
      const [refused, status] = await call(DENY, [
        { name: 'listNoteItems', arguments: { noteId: '1' } },
        { name: 'openapi_mcp_status', arguments: {} },
      ]);
      expect(refused).toEqual({
        isError: true,
        text: 'tool execution failed: the request was not sent: its URL also matches an operation this server does not expose; see the server startup diagnostics',
      });
      expect(received).toEqual([]);
      expect(JSON.parse(status?.text ?? '{}')).toMatchObject({
        notExposedCounts: {
          denied: 3,
          'not-allowed': 0,
          'read-only-default': 0,
          omitted: 0,
          withheld: 0,
          'head-without-get': 0,
        },
      });
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'applies the same check to call_operation in discover mode',
    async () => {
      const [refused] = await call(
        [...DENY, '--tool-mode', 'discover'],
        [{ name: 'call_operation', arguments: { name: 'getItem', arguments: { id: 'export' } } }],
      );
      expect(refused?.text).toContain("its URL is not this tool's own operation of the API");
      expect(received).toEqual([]);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
