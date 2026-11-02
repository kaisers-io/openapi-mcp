import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_TEST_TIMEOUT_MS, SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #125: --header-file renews a token without a restart. The real CLI
// over stdio against a local upstream that accepts only the renewed token
// and echoes both tokens back. An invented API.

const OLD = 'Bearer example-token-not-a-secret-old';
const NEW = 'Bearer example-token-not-a-secret-new';
const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Notes', version: '1' },
  paths: {
    '/me': {
      get: {
        operationId: 'whoAmI',
        responses: { '200': { description: 'me', content: { 'text/plain': {} } } },
      },
    },
  },
};

type Reply = { isError: boolean; text: string };

describe('serve — --header-file (issue #125)', () => {
  let home: string;
  let tokenPath: string;
  let api: Server;
  let baseUrl: string;
  const received: (string | undefined)[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp-header-file-'));
    writeFileSync(join(home, 'notes.json'), JSON.stringify(SPEC));
    tokenPath = join(home, 'api.token');
    api = createServer((req, res) => {
      const { authorization } = req.headers;
      received.push(authorization);
      if (authorization === NEW) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`renewed from ${OLD} to ${NEW}`);
      } else {
        res.writeHead(401);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      api.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      api.closeAllConnections();
      api.close(() => resolve());
    });
    rmSync(home, { recursive: true, force: true });
  });

  const writeToken = (value: string): void => {
    const temp = `${tokenPath}.tmp`;
    writeFileSync(temp, `${value}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, tokenPath);
  };

  // One call at a time on one running server
  const session = (child: ChildProcessWithoutNullStreams) => {
    const replies = new Map<number, Reply>();
    let buffer = '';
    let id = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((entry) => entry !== '')) {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { isError?: boolean; content?: { text?: string }[] };
        };
        if (message.id !== undefined) {
          replies.set(message.id, {
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
    return async (): Promise<Reply> => {
      id += 1;
      const mine = id;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: mine, method: 'tools/call', params: { name: 'whoAmI', arguments: {}, _meta: meta } })}\n`,
      );
      const started = Date.now();
      while (!replies.has(mine) && Date.now() - started < SUBPROCESS_WAIT_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      return replies.get(mine) ?? { isError: true, text: 'no reply' };
    };
  };

  it(
    'starts without the file, names it on a 401, and uses a renewed token on the next call',
    async () => {
      const child = spawn(
        process.execPath,
        [
          CLI_ENTRY,
          'serve',
          '--spec',
          join(home, 'notes.json'),
          '--base-url',
          baseUrl,
          '--header-file',
          `Authorization=${tokenPath}`,
        ],
        { env: { ...process.env, HOME: home, USERPROFILE: home } },
      );
      try {
        const call = session(child);
        const missing = await call();
        expect(missing.isError).toBe(true);
        expect(missing.text).toContain(`the header file ${JSON.stringify(tokenPath)} is missing`);
        expect(received).toHaveLength(0);

        writeToken(OLD);
        const expired = await call();
        expect(expired.text).toContain(
          `upstream request failed with status 401 (check the header file ${JSON.stringify(tokenPath)})`,
        );

        writeToken(NEW);
        const renewed = await call();
        expect(renewed.isError).toBe(false);
        expect(received).toStrictEqual([OLD, NEW]);
        // Both the replaced and the current token are withheld
        expect(renewed.text).not.toContain('example-token-not-a-secret');
      } finally {
        await stopChild(child);
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
