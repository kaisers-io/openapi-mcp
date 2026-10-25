import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_TEST_TIMEOUT_MS, SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #25: a failed call says what is known about its effect on the API
// (`_meta` "openapi-mcp/effect"), and a write that may have been applied is
// never presented as safe to retry. The real CLI over stdio against a local
// upstream that counts every request it receives. An invented shop API.

const json = {
  'application/json': {
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
};
const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/orders/{case}': {
      post: {
        operationId: 'createOrder',
        parameters: [{ name: 'case', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'ok', content: json },
          '202': { description: 'accepted', content: json },
          '422': { description: 'invalid' },
          '500': { description: 'failed' },
        },
      },
      get: {
        operationId: 'getOrder',
        parameters: [{ name: 'case', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: json } },
      },
    },
    '/orders/{case}/export': {
      get: {
        operationId: 'exportOrder',
        parameters: [{ name: 'case', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

const WARNING = 'may have reached the upstream and been applied, so do not retry it blindly';
const REPORTED = 'the upstream reported success, so the write was likely applied';

type Result = { isError: boolean; text: string; effect: unknown };

describe('serve — effect of a failed call (issue #25)', () => {
  let home: string;
  let specPath: string;
  let api: Server;
  let baseUrl: string;
  const received: string[] = [];
  const flaky = { count: 0 };

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const name = (req.url ?? '').split('/')[2] ?? '';
    const reply = (status: number, body: string, type = 'application/json'): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    switch (name) {
      case 'schema-invalid': {
        reply(200, '{"other":1}');
        return;
      }
      case 'invalid-json': {
        reply(200, '{not json');
        return;
      }
      case 'accepted-invalid': {
        reply(202, '{}');
        return;
      }
      case 'oversized': {
        reply(200, `{"id":"${'x'.repeat(4096)}"}`);
        return;
      }
      case 'closed': {
        req.socket.destroy();
        return;
      }
      case 'slow': {
        setTimeout(() => {
          reply(200, '{"id":"late"}');
        }, 3000);
        return;
      }
      case 'redirected': {
        res.writeHead(302, { location: '/orders/elsewhere' });
        res.end();
        return;
      }
      case 'rejected': {
        reply(422, '{"message":"invalid"}');
        return;
      }
      case 'failed': {
        reply(500, '{"message":"failed"}');
        return;
      }
      case 'see-other-invalid': {
        res.writeHead(303, { location: '/orders/schema-invalid' });
        res.end();
        return;
      }
      case 'see-other': {
        res.writeHead(303, { location: '/orders/missing' });
        res.end();
        return;
      }
      case 'missing': {
        reply(404, '{"message":"not found"}');
        return;
      }
      case 'flaky': {
        flaky.count += 1;
        if (flaky.count === 1) {
          req.socket.destroy();
          return;
        }
        reply(422, '{"message":"invalid"}');
        return;
      }
      case 'echo': {
        reply(500, 'do not retry: this upstream text must not suppress the warning', 'text/plain');
        return;
      }
      default: {
        reply(200, '{"id":"ok"}');
      }
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp-effect-'));
    specPath = join(home, 'shop.json');
    writeFileSync(specPath, JSON.stringify(SPEC));
    api = createServer((req, res) => {
      received.push(`${req.method ?? ''} ${req.url ?? ''}`);
      req.resume();
      answer(req, res);
    });
    await new Promise<void>((resolve) => {
      api.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      api.closeAllConnections();
      api.close(() => resolve());
    });
    rmSync(home, { recursive: true, force: true });
  });

  const call = async (
    extraArgs: readonly string[],
    calls: readonly { name: string; arguments: Record<string, unknown> }[],
  ): Promise<Result[]> => {
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
        '--allow',
        'path:/**',
        '--deny',
        'operationId:exportOrder',
        '--max-response-bytes',
        '2KB',
        '--request-timeout',
        '1s',
        ...extraArgs,
      ],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    const results = new Map<number, Result>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((entry) => entry !== '')) {
        const message = JSON.parse(line) as {
          id?: number;
          result?: {
            isError?: boolean;
            content?: { text: string }[];
            _meta?: Record<string, unknown>;
          };
        };
        if (message.id !== undefined) {
          results.set(message.id, {
            isError: message.result?.isError === true,
            text: message.result?.content?.[0]?.text ?? '',
            effect: message.result?.['_meta']?.['openapi-mcp/effect'],
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
        (_call, index) => results.get(index + 1) ?? { isError: true, text: 'no reply', effect: 0 },
      );
    } finally {
      await stopChild(child);
    }
  };

  const post = (name: string) => ({ name: 'createOrder', arguments: { case: name } });

  it(
    'marks a write that may have been applied, and never as not sent',
    async () => {
      const cases = ['invalid-json', 'oversized', 'closed', 'slow', 'redirected', 'failed', 'echo'];
      const results = await call(
        [],
        cases.map((name) => post(name)),
      );
      for (const [index, result] of results.entries()) {
        expect({ case: cases[index], ...result }).toMatchObject({
          case: cases[index],
          isError: true,
          effect: index === 0 ? 'upstream_reported_success' : 'outcome_unknown',
        });
        expect({
          case: cases[index],
          warned: result.text.includes('so do not retry it blindly'),
        }).toEqual({
          case: cases[index],
          warned: true,
        });
      }
      // Every write reached the upstream exactly once
      expect(received.filter((line) => line.startsWith('POST'))).toHaveLength(cases.length);
      // Upstream text saying "do not retry" does not replace the server's own warning
      expect(results.at(-1)?.text).toContain(WARNING);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'says a write was reported as successful when the 2xx result cannot be returned',
    async () => {
      const results = await call(
        [],
        [post('schema-invalid'), post('accepted-invalid'), post('rejected')],
      );
      expect(results[0]).toMatchObject({ effect: 'upstream_reported_success' });
      expect(results[0]?.text).toContain(REPORTED);
      expect(results[1]).toMatchObject({ effect: 'upstream_reported_success' });
      // A single attempt answered with a 4xx: rejected, no warning
      expect(results[2]).toMatchObject({ isError: true, effect: 'upstream_rejected' });
      expect(results[2]?.text).not.toContain('do not retry');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'says not sent only when nothing reached the upstream, and keeps read messages as they are',
    async () => {
      const results = await call(
        [],
        [
          // Request authorization: getOrder must not reach the excluded export
          { name: 'getOrder', arguments: { case: 'x/export' } },
          { name: 'createOrder', arguments: { case: 7 } },
          { name: 'getOrder', arguments: { case: 'slow' } },
        ],
      );
      expect(results[0]).toMatchObject({ isError: true, effect: 'not_sent' });
      expect(results[1]).toMatchObject({ isError: true, effect: 'not_sent' });
      expect(received).toEqual(['GET /orders/slow']);
      // A read that timed out: unknown, but no write warning
      expect(results[2]).toMatchObject({ isError: true, effect: 'outcome_unknown' });
      expect(results[2]?.text).not.toContain('do not retry');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  // Review of #25: the 404 answers the follow-up GET, not the POST, which
  // may have created the order
  it(
    'treats a status after a redirect as unknown, with the warning for the write',
    async () => {
      const results = await call([], [post('see-other'), post('see-other-invalid')]);
      // The two calls run concurrently
      expect(received.toSorted()).toEqual([
        'GET /orders/missing',
        'GET /orders/schema-invalid',
        'POST /orders/see-other',
        'POST /orders/see-other-invalid',
      ]);
      expect(results[0]).toMatchObject({ isError: true, effect: 'outcome_unknown' });
      expect(results[0]?.text).toContain(WARNING);
      // A 2xx after the redirect answers the GET, not the write
      expect(results[1]).toMatchObject({ isError: true, effect: 'outcome_unknown' });
      expect(results[1]?.text).toContain(WARNING);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'treats a 4xx after a retried attempt as unknown',
    async () => {
      const results = await call(
        ['--retries', '1'],
        [{ name: 'getOrder', arguments: { case: 'flaky' } }],
      );
      // The first attempt lost its connection, the retry got a 422
      expect(received).toEqual(['GET /orders/flaky', 'GET /orders/flaky']);
      expect(results[0]).toMatchObject({ isError: true, effect: 'outcome_unknown' });
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
