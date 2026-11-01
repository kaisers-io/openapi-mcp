import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';

// The admission queue end to end (issue #22): a real `serve` over stdio and
// an upstream that holds every request until the test releases it. With the
// default --max-concurrency 16, 16 calls are in flight and 64 more wait; the
// next is refused at once. A call cancelled while it waits leaves the queue
// and never reaches the upstream. Each call names itself in the path, so the
// upstream sees which calls arrived, not only how many.
//
// A call validates its arguments asynchronously before it queues, so the
// order calls are written in alone does not prove the earlier ones queued:
// a probe goes out only after 16 calls are in flight and a ping, answered
// after everything sent before it was read, has come back.

const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

const SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Queue', version: '1' },
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
});

type Message = { id?: number; result?: Record<string, unknown> };

type HeldUpstream = {
  port: number;
  // The item ids the upstream received, in arrival order
  seen: string[];
  waiting: () => number;
  // Answers every held request and every later one at once
  release: () => void;
  // Holds again from now on
  hold: () => void;
  close: () => Promise<void>;
};

const startHeldUpstream = async (): Promise<HeldUpstream> => {
  const seen: string[] = [];
  const held: ServerResponse[] = [];
  let open = false;
  const answer = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    seen.push(decodeURIComponent((req.url ?? '').replace(/^\/items\//u, '')));
    if (open) {
      answer(res);
      return;
    }
    held.push(res);
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    waiting: () => held.length,
    release: () => {
      open = true;
      for (const res of held.splice(0)) {
        answer(res);
      }
    },
    hold: () => {
      open = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 15_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

const isError = (message: Message | undefined): boolean => message?.result?.['isError'] === true;

describe('serve — the admission queue under a held upstream (issue #22)', () => {
  let child: ChildProcess | undefined;
  let home: string | undefined;
  let upstream: HeldUpstream | undefined;

  afterEach(async () => {
    upstream?.release();
    if (child !== undefined) {
      await stopChild(child);
    }
    child = undefined;
    await upstream?.close();
    upstream = undefined;
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  const start = async () => {
    upstream = await startHeldUpstream();
    home = await mkdtemp(join(tmpdir(), 'openapi-mcp-queue-'));
    const specPath = join(home, 'spec.json');
    await writeFile(specPath, SPEC);
    const proc = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'serve',
        '--spec',
        specPath,
        '--base-url',
        `http://127.0.0.1:${String(upstream.port)}`,
        '--trust-spec-updates',
        // Neither the rate limit nor a queue deadline may refuse a call here
        '--rate-limit',
        '100000/1m',
        '--request-timeout',
        '120s',
      ],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    child = proc;
    const answers = new Map<number, Message>();
    let buffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((candidate) => candidate !== '')) {
        const message = JSON.parse(line) as Message;
        if (message.id !== undefined) {
          answers.set(message.id, message);
        }
      }
    });
    const write = (message: Record<string, unknown>): void => {
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const call = (id: number): void => {
      write({
        id,
        method: 'tools/call',
        params: { name: 'getItem', arguments: { id: `c${String(id)}` }, _meta: MODERN_ENVELOPE },
      });
    };
    const cancel = (id: number): void => {
      write({ method: 'notifications/cancelled', params: { requestId: id, reason: 'test' } });
    };
    let pings = 0;
    const ping = async (): Promise<void> => {
      pings += 1;
      const id = 900_000 + pings;
      write({ id, method: 'server/discover', params: { _meta: MODERN_ENVELOPE } });
      await waitFor(() => answers.has(id), 'a ping');
    };
    // The first answer proves the server reads stdin
    await ping();
    // 80 calls fill the slots and the queue
    const fill = async (first: number): Promise<number[]> => {
      const ids = Array.from({ length: 80 }, (_unused, index) => first + index);
      for (const id of ids) {
        call(id);
      }
      await waitFor(() => upstream!.waiting() === 16, '16 calls in flight');
      await ping();
      return ids;
    };
    const refusedAtOnce = async (id: number): Promise<void> => {
      call(id);
      await waitFor(() => answers.has(id), `call ${String(id)} to be refused`);
      expect(isError(answers.get(id))).toBe(true);
      expect(JSON.stringify(answers.get(id))).toContain('overloaded');
    };
    return { call, cancel, ping, fill, refusedAtOnce, answers };
  };

  it('holds 16 in flight and 64 in the queue, refuses the 81st at once, then completes all 80', async () => {
    const { fill, refusedAtOnce, answers } = await start();
    const ids = await fill(100);
    await refusedAtOnce(999);
    expect(upstream!.waiting()).toBe(16);
    // Nothing else was answered while the upstream held
    expect(ids.filter((id) => answers.has(id))).toStrictEqual([]);
    upstream!.release();
    await waitFor(() => ids.every((id) => answers.has(id)), 'all 80 calls');
    expect(ids.filter((id) => isError(answers.get(id)))).toStrictEqual([]);
    expect(upstream!.seen.toSorted()).toStrictEqual(ids.map((id) => `c${String(id)}`).toSorted());
  }, 60_000);

  it('a call cancelled while it waits leaves the queue at once and never reaches the upstream', async () => {
    const { call, cancel, ping, fill, refusedAtOnce, answers } = await start();
    const ids = await fill(100);
    // Eight of the queued calls give up; their places free before release
    const cancelled = ids.slice(40, 48);
    for (const id of cancelled) {
      cancel(id);
    }
    // Eight replacements fit, the ninth is refused, the upstream still held
    const replacements = Array.from({ length: 8 }, (_unused, index) => 500 + index);
    for (const id of replacements) {
      call(id);
    }
    await ping();
    await refusedAtOnce(999);
    expect(replacements.filter((id) => answers.has(id))).toStrictEqual([]);
    upstream!.release();
    const kept = [...ids.filter((id) => !cancelled.includes(id)), ...replacements];
    await waitFor(() => kept.every((id) => answers.has(id)), 'every call not cancelled');
    expect(kept.filter((id) => isError(answers.get(id)))).toStrictEqual([]);
    expect(upstream!.seen.toSorted()).toStrictEqual(kept.map((id) => `c${String(id)}`).toSorted());
    // No slot or place is left behind: held again, the full capacity takes
    // 80 calls once more and refuses the next
    upstream!.hold();
    const again = await fill(2000);
    await refusedAtOnce(2999);
    upstream!.release();
    await waitFor(() => again.every((id) => answers.has(id)), 'the second burst');
    expect(again.filter((id) => isError(answers.get(id)))).toStrictEqual([]);
  }, 60_000);
});
