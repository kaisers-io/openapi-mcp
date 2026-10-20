import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { createProtocolSession } from './protocol.ts';
import type { ProtocolSessionOptions } from './protocol.ts';

export type StdioSessionDeps = {
  // Default to the process's own stdio. Overridable so the binding can be
  // driven over any stream pair (a socket, an in-memory pipe) rather than
  // being welded to the process it runs in.
  stdin?: Readable | undefined;
  stdout?: Writable | undefined;
  // Out-of-band errors — a frame that never parsed, a failed write, a
  // discarded message — have no JSON-RPC reply to ride on. Left unset they
  // are swallowed; stdout is JSON-RPC-only, so a caller that wants them must
  // route them somewhere else itself.
  onError?: ((error: Error) => void) | undefined;
};

export type StdioSessionHandle = {
  // Resolves when the connection ends: the client closed its end of the pipe
  // (stdin EOF), the transport itself went away, or it never started. Never
  // rejects — a failure that ends the connection is reported through
  // `onError`, not through this lifetime.
  readonly closed: Promise<void>;
  // Detaches this session from the given streams, and — when the connection
  // is still up (a shutdown signal) — tears down the pinned session and the
  // transport. When the transport already closed itself (stdin EOF, a failed
  // write) that teardown has run, and this only releases the streams. Safe
  // to call at any point, including after `closed` has settled.
  close: () => Promise<void>;
};

// `serveStdio` — NOT a hand-wired `Server` + `StdioServerTransport` — is what
// puts 2026-07-28 on the wire: it owns the opening exchange, classifies the
// era from the first message's `_meta` envelope claim, and pins ONE instance
// from this factory for the connection's lifetime. The same factory also
// answers a claim-less 2025-era `initialize`, so a client that never learned
// the modern revision keeps working against this exact server. The factory
// closes over the caller's `dispatcherDeps`, so a per-connection instance
// still shares one process-global rate limiter and executor.
export const serveStdioSession = (
  opts: ProtocolSessionOptions,
  deps: StdioSessionDeps = {},
): StdioSessionHandle => {
  const stdin = deps.stdin ?? process.stdin;
  const transport = new StdioServerTransport(stdin, deps.stdout ?? process.stdout);
  // One lifetime fed by two independent callback sources.
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  // `serveStdio` starts the transport itself, and a start that fails is
  // reported through `onerror` and then dropped: no session ever opens, so
  // `onclose` never fires and nothing else would ever end the lifetime
  // advertised above. A transport that cannot start is terminal — end it
  // here. The failure itself still reaches the caller through `onError`,
  // which is where every other out-of-band error goes.
  const startTransport = transport.start.bind(transport);
  transport.start = async (): Promise<void> => {
    try {
      await startTransport();
    } catch (error) {
      markClosed();
      throw error;
    }
  };
  const handle = serveStdio(() => createProtocolSession(opts), {
    transport,
    ...(deps.onError === undefined ? {} : { onerror: deps.onError }),
  });
  // The other way a connection ends: the transport closing itself — on stdin
  // EOF (the SDK transport watches 'end'/'close' on stdin) or from the inside
  // (a failed stdout write, an oversized frame) with stdin still open. On
  // stdio, that EOF IS the client disconnecting: the spec reads stdin close
  // as the shutdown signal and wants a prompt exit, so a request still in
  // flight when EOF arrives is DELIBERATELY abandoned with the connection
  // rather than drained — draining would mean waiting, unbounded, on an
  // upstream call for a client that already hung up. A client that wants
  // its response must keep its end of the pipe open until it has read it.
  // Composes onto — never replaces — the callback `serveStdio` installed
  // above, which is what tears the pinned instance down.
  const entryOnClose = transport.onclose;
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- `onclose` is a plain callback property on the SDK's Transport interface, not a DOM-style event target: there is no addEventListener to register with
  transport.onclose = () => {
    entryOnClose?.();
    markClosed();
  };
  return {
    closed,
    close: () => handle.close(),
  };
};
