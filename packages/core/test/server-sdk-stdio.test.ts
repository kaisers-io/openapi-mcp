import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  createMetaExecutor,
  createRedactor,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { NamedOperation } from '../src/index.ts';
import { serveStdioSession } from '../src/server/sdk/stdio.ts';

const namedOp: NamedOperation = {
  toolName: 'listThings',
  operation: {
    method: 'get',
    path: '/things',
    tags: [],
    deprecated: false,
    parameters: [],
    responses: { '200': { description: 'ok' } },
  },
};

// The per-request envelope that selects the 2026-07-28 era: on stdio there is
// no header layer, so this claim in `params._meta` is the only signal the
// entry classifies the opening exchange from.
const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

type WireResponse = { id?: number; result?: Record<string, unknown> };

// Answers "did the lifetime end?" without ever hanging the run: the losing
// side of this race is a meaningful outcome in both directions.
const lifetimeWithin = (closed: Promise<void>, ms: number): Promise<'ended' | 'still-open'> =>
  Promise.race([
    closed.then(() => 'ended' as const),
    new Promise<'still-open'>((resolve) => {
      setTimeout(() => resolve('still-open'), ms);
    }),
  ]);

// A stdin that cannot be listened to. `StdioServerTransport.start()` does
// nothing but register listeners, so refusing the 'data' registration is the
// one way to make the start the entry performs internally fail.
const unstartableStdin = (): PassThrough => {
  const stream = new PassThrough();
  const register = stream.on.bind(stream);
  stream.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === 'data') {
      throw new Error('stdin is not readable');
    }
    return register(event, listener);
  }) as PassThrough['on'];
  return stream;
};

// Drives the session over an in-memory stream pair instead of the process's
// own stdio, so the whole binding — factory, era selection, lifetime, close —
// is exercised in-process with no child to spawn.
const openSession = (onError?: (error: Error) => void, stdin: PassThrough = new PassThrough()) => {
  const built = buildTools([namedOp], {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
  });
  const snapshot = buildSnapshot(built, {
    spec: { title: 'Test', specVersion: '1.0.0', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
  const stdout = new PassThrough();
  const lines: string[] = [];
  let buffered = '';
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    lines.push(...parts.filter((line) => line !== ''));
  });
  const session = serveStdioSession(
    {
      name: 'test-server',
      version: '1.0.0',
      snapshot,
      dispatcherDeps: {
        limiter: { consume: () => true, retryAfterMs: () => 0 },
        now: () => 0,
        executor: () => Promise.resolve({ isError: false, content: [] as const }),
        metaExecutor: createMetaExecutor(),
        redactor: createRedactor([]),
      },
    },
    { stdin, stdout, ...(onError === undefined ? {} : { onError }) },
  );
  const request = (id: number, method: string): void => {
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { _meta: MODERN_ENVELOPE } })}\n`,
    );
  };
  const nextResponse = async (id: number): Promise<WireResponse> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = lines
        .map((line) => JSON.parse(line) as WireResponse)
        .find((message) => message.id === id);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for response ${String(id)}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  };
  return { session, stdin, lines, request, nextResponse };
};

describe('serveStdioSession', () => {
  it('serves a 2026-07-28 request over the streams it was given, cache hint and all', async () => {
    const { session, request, nextResponse } = openSession();
    request(1, 'tools/list');
    const response = await nextResponse(1);
    const tools = response.result?.['tools'] as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual(['openapi_mcp_status', 'listThings']);
    expect(response.result?.['ttlMs']).toBe(3_600_000);
    expect(response.result?.['cacheScope']).toBe('private');
    await session.close();
  });

  it('ends the session lifetime on stdin EOF', async () => {
    const { session, stdin, request, nextResponse } = openSession();
    request(1, 'tools/list');
    await nextResponse(1);
    // Serving a request must NOT end the lifetime — only the client going
    // away does, so the losing side of this race is the meaningful outcome.
    expect(await lifetimeWithin(session.closed, 20)).toBe('still-open');
    stdin.end();
    await session.closed;
    await session.close();
  });

  // EOF handling lives in the SDK transport, not this module: these two pin
  // the paths a plain `end()` does not reach, so an SDK bump that drops them
  // fails here.
  it('ends the session lifetime when stdin is destroyed without an EOF', async () => {
    const { session, stdin, request, nextResponse } = openSession();
    request(1, 'tools/list');
    await nextResponse(1);
    stdin.destroy();
    expect(await lifetimeWithin(session.closed, 500)).toBe('ended');
    await session.close();
  });

  it('ends the session lifetime when stdin is already gone before the session starts', async () => {
    const stdin = new PassThrough();
    stdin.destroy();
    const { session } = openSession(undefined, stdin);
    expect(await lifetimeWithin(session.closed, 500)).toBe('ended');
    await session.close();
  });

  it('ends the session lifetime when the connection is torn down without an EOF', async () => {
    const { session, stdin, request, nextResponse } = openSession();
    request(1, 'tools/list');
    await nextResponse(1);
    await session.close();
    await expect(session.closed).resolves.toBeUndefined();
    // The streams are the caller's and may outlive this session: closing it
    // must leave nothing of it attached to them.
    expect(stdin.listenerCount('end')).toBe(0);
    expect(stdin.listenerCount('close')).toBe(0);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('ends the session lifetime when the transport closes itself on an oversized frame', async () => {
    const onError = vi.fn<(error: Error) => void>();
    const { session, stdin, lines } = openSession(onError);
    // Past the transport's 10 MB read buffer: it reports the overflow and
    // closes itself from the inside, with stdin still open. Nothing here may
    // reject — the SDK tears the pinned instance down fire-and-forget.
    stdin.write(`${'x'.repeat(11 * 1024 * 1024)}\n`);
    expect(await lifetimeWithin(session.closed, 500)).toBe('ended');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(lines).toEqual([]);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('survives an onError sink that THROWS — the SDK isolates the callback, so the binding needs no guard of its own', async () => {
    // The HTTP transport has to isolate its own sink (its request-level catch
    // has no other observer, and an escaping exception there becomes an
    // unhandled rejection). This pins the reason the stdio binding does NOT:
    // `serveStdio` invokes `options.onerror` only through its own
    // try/catch-wrapped reporter, so a throwing sink cannot escape the same
    // way. If a future SDK version drops that isolation, this fails here
    // instead of surfacing as a crash in the field.
    const unhandled: unknown[] = [];
    const trapRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', trapRejection);
    try {
      const { session, stdin } = openSession(() => {
        throw new Error('sink exploded: EPIPE');
      });
      // The same overflow the test above drives, with a sink that throws on
      // the way out.
      stdin.write(`${'x'.repeat(11 * 1024 * 1024)}\n`);
      expect(await lifetimeWithin(session.closed, 500)).toBe('ended');
      await expect(session.close()).resolves.toBeUndefined();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', trapRejection);
    }
  });

  it('ends the session lifetime when the transport never starts', async () => {
    const onError = vi.fn<(error: Error) => void>();
    const { session } = openSession(onError, unstartableStdin());
    // A failed start is reported through onerror only — the entry never calls
    // onclose for a connection that never opened. Without the lifetime ending
    // here the caller would wait on a session that can never serve anything.
    expect(await lifetimeWithin(session.closed, 200)).toBe('ended');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('reports a malformed frame through onError instead of writing anything to the wire', async () => {
    const onError = vi.fn<(error: Error) => void>();
    const { session, stdin, lines } = openSession(onError);
    // Parses as JSON but is not a JSON-RPC message: there is no id to answer,
    // so the only place this can surface is the out-of-band callback.
    stdin.write(`${JSON.stringify({ not: 'jsonrpc' })}\n`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(lines).toEqual([]);
    await session.close();
  });
});
