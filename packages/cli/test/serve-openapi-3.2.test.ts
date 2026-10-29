import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY, FIXTURES_DIR, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_TEST_TIMEOUT_MS, SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #33: an OpenAPI 3.2 QUERY operation, a querystring parameter, an
// additionalOperations method and sequential media types end to end. The
// real CLI over stdio, against a local upstream that records what it
// receives. QUERY is safe, so the read-only default exposes it; LINK needs
// --allow.

type Received = { method?: string; url?: string; contentType?: string; body: string };

describe('serve — OpenAPI 3.2 QUERY, querystring and additionalOperations (issue #33)', () => {
  let home: string;
  let upstream: Server;
  let baseUrl: string;
  const received: Received[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp-query-'));
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        received.push({
          ...(req.method === undefined ? {} : { method: req.method }),
          ...(req.url === undefined ? {} : { url: req.url }),
          ...(req.headers['content-type'] === undefined
            ? {}
            : { contentType: req.headers['content-type'] }),
          body,
        });
        // Sequential media types: JSON Lines and Server-Sent Events
        const sequential: Record<string, readonly [string, string]> = {
          '/orders/export': ['application/jsonl', '{"id":"o1","note":null}\n{"id":"o2"}\n'],
          '/events': ['text/event-stream', ': ping\nevent: created\ndata: o1\nid: 1\n\n'],
        };
        const [type, payload] = sequential[req.url ?? ''] ?? [
          'application/json',
          JSON.stringify([{ id: 'o1', note: null }]),
        ];
        res.writeHead(200, { 'content-type': type });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
    rmSync(home, { recursive: true, force: true });
  });

  // The real CLI over stdio with the given extra arguments; `request` sends
  // one JSON-RPC request and waits for its result
  const serve = (extraArgs: readonly string[]) => {
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'serve',
        '--trust-spec-updates',
        '--spec',
        'shop-3.2.yaml',
        '--base-url',
        baseUrl,
        '--header-env',
        'Authorization=QUERY_TEST_TOKEN',
        ...extraArgs,
      ],
      {
        cwd: FIXTURES_DIR,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          QUERY_TEST_TOKEN: 'Bearer test-token-not-a-secret',
        },
      },
    );
    const responses = new Map<number, { result?: Record<string, unknown> }>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((entry) => entry !== '')) {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
      }
    });
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const request = async (id: number, method: string, params: Record<string, unknown>) => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })}\n`,
      );
      const started = Date.now();
      while (!responses.has(id) && Date.now() - started < SUBPROCESS_WAIT_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      return responses.get(id)?.result ?? {};
    };
    return { child, request };
  };

  it(
    'exposes a QUERY operation by default and sends its body with the QUERY method',
    async () => {
      received.length = 0;
      const { child, request } = serve([]);
      try {
        const list = await request(1, 'tools/list', {});
        const tools = list['tools'] as { name: string; annotations?: Record<string, unknown> }[];
        const queryTool = tools.find((tool) => tool.name === 'queryOrders');
        expect(queryTool?.annotations).toMatchObject({ readOnlyHint: true });
        // The read-only default still hides the PATCH and the LINK
        expect(tools.map((tool) => tool.name)).not.toContain('updateOrder');
        expect(tools.map((tool) => tool.name)).not.toContain('linkOrders');

        const called = await request(2, 'tools/call', {
          name: 'queryOrders',
          // An object body's properties are the tool's arguments
          arguments: { status: 'open', noteContains: 'gift' },
        });
        expect(called['isError']).toBe(false);
        expect(called['structuredContent']).toEqual({
          status: 200,
          contentType: 'application/json',
          data: [{ id: 'o1', note: null }],
        });
        expect(received).toEqual([
          {
            method: 'QUERY',
            url: '/orders',
            contentType: 'application/json',
            body: JSON.stringify({ status: 'open', noteContains: 'gift' }),
          },
        ]);

        // The request body schema is enforced before anything is sent
        const refused = await request(3, 'tools/call', {
          name: 'queryOrders',
          arguments: { status: 'lost' },
        });
        expect(refused['isError']).toBe(true);
        expect(received).toHaveLength(1);

        // A 3.2 querystring parameter becomes the whole query string
        const searched = await request(4, 'tools/call', {
          name: 'searchOrders',
          arguments: { q: { text: 'gift & card' } },
        });
        expect(searched['isError']).toBe(false);
        expect(received[1]).toEqual({ method: 'GET', url: '/search?text=gift+%26+card', body: '' });
      } finally {
        await stopChild(child);
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'returns a JSON Lines and an event-stream response as the array of their items',
    async () => {
      received.length = 0;
      const { child, request } = serve([]);
      try {
        const exported = await request(1, 'tools/call', { name: 'exportOrders', arguments: {} });
        expect(exported['isError']).toBe(false);
        expect(exported['structuredContent']).toEqual({
          status: 200,
          contentType: 'application/jsonl',
          data: [{ id: 'o1', note: null }, { id: 'o2' }],
        });
        const events = await request(2, 'tools/call', { name: 'streamEvents', arguments: {} });
        expect(events['isError']).toBe(false);
        expect(events['structuredContent']).toEqual({
          status: 200,
          contentType: 'text/event-stream',
          data: [{ event: 'created', data: 'o1', id: '1' }],
        });
      } finally {
        await stopChild(child);
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'exposes an additionalOperations method when allowed and sends it as declared',
    async () => {
      received.length = 0;
      const { child, request } = serve(['--allow', 'route:LINK /orders']);
      try {
        const list = await request(1, 'tools/list', {});
        const tools = list['tools'] as { name: string; annotations?: Record<string, unknown> }[];
        expect(tools.map((tool) => tool.name)).toEqual([
          'openapi_mcp_status',
          'linkOrders',
          'execute_code',
        ]);
        expect(tools.find((tool) => tool.name === 'linkOrders')?.annotations).toEqual({
          destructiveHint: true,
          openWorldHint: true,
        });

        const linked = await request(2, 'tools/call', {
          name: 'linkOrders',
          arguments: { target: '/orders/o2' },
        });
        expect(linked['isError']).toBe(false);
        expect(received).toEqual([
          {
            method: 'LINK',
            url: '/orders',
            contentType: 'application/json',
            body: JSON.stringify({ target: '/orders/o2' }),
          },
        ]);
      } finally {
        await stopChild(child);
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
