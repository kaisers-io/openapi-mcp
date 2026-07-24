import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { DispatcherDeps } from '../dispatch.ts';
import { evaluateRequest, type RequestGuardOptions } from '../http/request-guard.ts';
import { createSessionStore, type SessionStore } from '../http/sessions.ts';
import type { ServerSnapshot } from '../types.ts';
import { createProtocolSession } from './protocol.ts';

const MAX_SESSIONS = 8;
const IDLE_MS = 30 * 60 * 1000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
// Bounded forced-close fallback for graceful shutdown (C5): if closing every
// session's transport, or the listener itself, has not finished within this
// bound, force-destroy remaining connections rather than hang the process.
const SHUTDOWN_FORCE_MS = 5000;

interface HttpSessionValue {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

export interface StreamableHttpOptions {
  name: string;
  version: string;
  snapshot: ServerSnapshot;
  dispatcherDeps: Omit<DispatcherDeps, 'snapshot'>;
  guard: RequestGuardOptions;
  port: number;
  now: () => number;
}

export interface StreamableHttpServerHandle {
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

// A JSON-RPC-shaped error response — used for EVERY rejection this module
// writes itself (guard denials aside, which have no body), so a client never
// sees a bare socket reset/500 for something this server can diagnose
// cleanly (C body-cap/parse-error fix below).
const jsonRpcError = (res: ServerResponse, status: number, code: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(
    // oxlint-disable-next-line no-null -- JSON-RPC 2.0 requires a literal `null` id when the id of the failed request cannot be determined
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
  );
};

// T1: a STRICT single-header reader for `req.headersDistinct` (`string[] |
// undefined` only — headersDistinct never yields a plain string, unlike
// `req.headers`): returns the value ONLY when EXACTLY ONE was actually sent,
// mirroring request-guard.ts's own fail-closed `singleHeader`. This module
// used to read the session-id header via `req.headers` through a LOOSE
// `value[0]`-style helper; that helper is deliberately NOT reused here
// against `headersDistinct`, since reusing it would ACCEPT a DUPLICATED
// mcp-session-id as if only the first value had been sent — a regression
// from the old `req.headers` behavior, where a duplicate comma-joins into
// `"id1, id2"`, a string that never matches a real session id and so fails
// closed via the store lookup (404). A duplicated id must keep 404ing
// exactly like a missing one, never silently resolve to its first value.
const strictSingleHeader = (value: string[] | undefined): string | undefined =>
  value !== undefined && value.length === 1 ? value[0] : undefined;

// Reads the body up to capBytes. On overflow this ENDS the read cleanly
// (does not `req.destroy()` the socket, which a client sees as an abrupt
// reset) and resolves with a sentinel so the caller can write a DELIBERATE
// 400 JSON-RPC rejection instead — a reset looks like a crash/500 to a
// well-behaved HTTP client, not an intentional application-level rejection.
type BodyReadResult = { ok: true; buffer: Buffer } | { ok: false; reason: 'too-large' };

const readBodyCapped = (req: IncomingMessage, capBytes: number): Promise<BodyReadResult> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > capBytes) {
        settled = true;
        resolve({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve({ ok: true, buffer: Buffer.concat(chunks) });
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });

// A DELIBERATE JSON-RPC parse-error 400 (code -32700) on invalid JSON —
// never a generic 500. `undefined` (an empty body) is valid for GET/DELETE
// and handled by the SDK transport itself.
type ParsedBodyResult = { ok: true; body: unknown } | { ok: false };

const parseJsonBody = (buffer: Buffer): ParsedBodyResult => {
  if (buffer.length === 0) {
    return { ok: true, body: undefined };
  }
  try {
    // A FATAL UTF-8 decode, not `buffer.toString('utf8')`:
    // `Buffer#toString('utf8')` lenient-decodes any invalid byte sequence to
    // U+FFFD instead of throwing, which would let a non-UTF-8 body silently
    // become valid JS text (and, in principle, valid JSON) here.
    // `TextDecoder`'s `fatal: true` option throws on invalid UTF-8 instead,
    // so a malformed-encoding body is rejected by the SAME catch below as
    // malformed JSON — the deliberate 400/-32700 parse-error path, never a
    // lenient pass-through.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

export const createStreamableHttpServer = (
  opts: StreamableHttpOptions,
): StreamableHttpServerHandle => {
  const sessions: SessionStore<HttpSessionValue> = createSessionStore({
    maxSessions: MAX_SESSIONS,
    idleMs: IDLE_MS,
  });
  // H3: a shutdown admission fence — deliberately CLOSURE-LOCAL (one
  // instance per createStreamableHttpServer call), NOT module-level. A
  // module-level flag would be shared across EVERY server instance in the
  // process, so once any one server closed, every later instance would
  // reject initialization forever. Flipped true at the very top of close(),
  // before that method takes its session-drain snapshot; checked again
  // immediately before the synchronous session-slot reservation in
  // handleFreshInitialize below, with no await between the check and the
  // reservation, so the two stay atomic on the event loop.
  let closing = false;

  // Closes and evicts every session idle past IDLE_MS. Called lazily at the
  // top of EVERY request (C3 fix — sweepExpired was previously never
  // called, so an expired session lingered forever, permanently occupying a
  // capacity slot and leaking its transport). A fully-idle server with no
  // further requests would not free capacity until the NEXT request
  // arrives, which is when it matters anyway (nothing needs the slot until
  // something asks for one) — a periodic background timer was considered
  // and deliberately deferred as unnecessary complexity for that reason.
  const evictExpiredSessions = (nowMs: number): void => {
    for (const expired of sessions.sweepExpired(nowMs)) {
      void expired.transport.close().catch(() => {
        // Best-effort during eviction — nothing more actionable if it fails.
      });
    }
  };

  // C4 fix: reserve the session-store SLOT synchronously — before
  // constructing a transport or awaiting anything — using OUR OWN
  // pre-generated id (`sessionIdGenerator: () => sessionId` below, rather
  // than the SDK's own `onsessioninitialized` callback pattern). Node's
  // event loop only yields to another request's callback at an actual
  // await/I-O point; since `sessions.create` here happens before any await,
  // no other concurrent initialize can interleave between the capacity
  // check and the reservation. This closes the race the officially
  // documented `onsessioninitialized`-registers-later pattern leaves open
  // (a burst of concurrent initializes could otherwise all pass a "check,
  // then await, then register" sequence before any of them registers) — see
  // the design note in Verified Facts above.
  const handleFreshInitialize = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> => {
    // Captured ONCE (plan review) and reused below for both the
    // eviction sweep and the reservation timestamp, rather than calling
    // opts.now() twice for what is conceptually the same instant.
    const nowMs = opts.now();
    evictExpiredSessions(nowMs);
    const sessionId = randomUUID();
    // A mutable holder reserved NOW; `transport`/`server` are filled in
    // below once constructed. Casting past the interface's required fields
    // is safe here because nothing else can observe this entry (via
    // `sessions.get`) until AFTER both are assigned, since no `await` runs
    // in between.
    const reserved: Partial<HttpSessionValue> = {};
    // H3: the shutdown fence, checked immediately before the reservation
    // below with no await in between, so the check-and-reserve pair stays
    // atomic on the event loop — a request racing a concurrent close() can
    // never slip a session into existence AFTER close()'s own
    // session-drain snapshot (sessions.values()) has already been taken,
    // which would otherwise leave that session undrained forever.
    if (closing) {
      jsonRpcError(res, 503, -32000, 'server is shutting down');
      return;
    }
    const reservation = sessions.create(sessionId, reserved as HttpSessionValue, nowMs);
    if (!reservation.ok) {
      jsonRpcError(res, 503, -32000, 'session capacity exceeded');
      return;
    }
    // C4-ROLLBACK fix: the slot reserved just above must be released if
    // this attempt never actually completes initialization. The SDK
    // validates a POST's Accept/Content-Type headers BEFORE touching
    // initialize semantics at all — verified directly against the v1.29.0
    // source (`webStandardStreamableHttp.js`'s `handlePostRequest`: the
    // 406/415 early-returns near the top of the method run well before the
    // `isInitializeRequest` branch further down that assigns
    // `this.sessionId` and invokes `onsessioninitialized`). A malformed
    // initialize-shaped POST (missing/wrong Accept, or a bad Content-Type)
    // is therefore rejected by the TRANSPORT itself — with a 406/415 —
    // before `onsessioninitialized` ever fires. Without this flag and the
    // rollback below, 8 such malformed requests would each permanently
    // occupy one of the 8 capacity slots reserved synchronously above,
    // without ever completing a session, exhausting capacity for every
    // legitimate client.
    let initialized = false;
    // H2 (round-3 fix): the reservation made above must be released on EVERY
    // path that does not complete initialization — not only a 406/415 returned
    // by `transport.handleRequest`, but ALSO a throw from transport
    // construction, `createProtocolSession`, or `server.connect()`. All of them
    // therefore live inside the single try whose finally rolls the reservation
    // back. `transport`/`server` are declared here (initially undefined) so the
    // finally can tear down whichever were actually built before a failure.
    let transport: StreamableHTTPServerTransport | undefined;
    let server: ReturnType<typeof createProtocolSession> | undefined;
    try {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId, // Matches the id already reserved above
        // Plain JSON responses, not the SDK's default SSE-formatted POST
        // response: this plan's client is a single local, non-streaming
        // caller (the CLI's own E2E tests use fetch()+res.json() directly),
        // and every server-initiated push this plan needs (if any, in a
        // future milestone) still goes over the separate GET/SSE stream,
        // which is unaffected by this flag (verified against the v1.29.0
        // source: enableJsonResponse only changes handlePostRequest's own
        // response formatting, not handleGetRequest's).
        enableJsonResponse: true,
        onsessioninitialized: () => {
          initialized = true;
        },
        onsessionclosed: (closedId) => {
          sessions.remove(closedId);
        },
      });
      // A FRESH low-level Server per session, connected to this session's
      // transport — the snapshot and EVERY entry in `dispatcherDeps`
      // (including the limiter) are the SAME shared references passed in via
      // `opts` for every session (Task 3's trap: constructing a NEW limiter
      // here would silently make it per-session instead of process-global).
      // `createDispatcher` itself IS still called fresh inside
      // `createProtocolSession` for each session (Task 5), but it is a pure,
      // stateless closure over these shared references — recreating that
      // closure per session is benign; only the underlying limiter/executor
      // objects being distinct per session would be the actual bug, and they
      // are not.
      server = createProtocolSession({
        name: opts.name,
        version: opts.version,
        snapshot: opts.snapshot,
        dispatcherDeps: opts.dispatcherDeps,
      });
      reserved.transport = transport;
      reserved.server = server;
      // `StreamableHTTPServerTransport implements Transport` per the SDK's
      // own declaration, but its `onclose`/`onerror`/`onmessage` are
      // get/set ACCESSORS typed `(() => void) | undefined` (verified
      // against the v1.29.0 .d.ts), whereas `Transport` declares them as
      // plain OPTIONAL properties (`onclose?: () => void`) — two shapes
      // `exactOptionalPropertyTypes` (this project's tsconfig) treats as
      // distinct, even though they are behaviorally identical. The cast
      // below is narrowly scoped to this one call site (deriving the
      // parameter type from `Server['connect']` itself, rather than
      // importing `Transport` as an 11th module dependency for this file),
      // not a blanket `any`.
      await server.connect(transport as Parameters<Server['connect']>[0]);
      await transport.handleRequest(req, res, body);
    } finally {
      if (!initialized) {
        // The reservation was never confirmed — release the slot and tear down
        // whatever resources were built before the failure. Where the server
        // exists, `server.close()` ALONE (not also `transport.close()`) is
        // deliberate: the SDK's `Protocol.close()`, which the low-level
        // `Server` inherits (`dist/esm/shared/protocol.js`, verified against the
        // v1.29.0 source), already does `await this._transport?.close()`. If a
        // throw in transport construction left the server unbuilt, close the
        // transport directly instead.
        sessions.remove(sessionId);
        if (server !== undefined) {
          await server.close().catch(() => {
            // Best-effort during rollback — nothing more actionable if it fails.
          });
        } else if (transport !== undefined) {
          await transport.close().catch(() => {
            // Best-effort during rollback.
          });
        }
      }
    }
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const nowMs = opts.now();
    evictExpiredSessions(nowMs);
    // Reads req.headersDistinct, NOT req.headers: Node silently collapses a
    // duplicate Host/Authorization header to its first value and merges a
    // duplicate Origin into one comma-joined string via the plain `.headers`
    // accessor — either would defeat evaluateRequest's array-based
    // duplicate-header rejection. `.headersDistinct.<name>` always returns
    // every value actually sent as `string[] | undefined` (verified fact
    // above), which is what that rejection logic needs to see.
    const decision = evaluateRequest(opts.guard, {
      // Bracket notation: `headersDistinct` is `NodeJS.Dict<string[]>` (an
      // index-signature type), which this project's tsconfig
      // (noPropertyAccessFromIndexSignature) requires accessing this way.
      host: req.headersDistinct['host'],
      origin: req.headersDistinct['origin'],
      authorization: req.headersDistinct['authorization'],
    });
    if (decision.outcome === 'deny') {
      res.writeHead(decision.status).end();
      return;
    }
    // T1: read via req.headersDistinct through the STRICT helper above, not
    // req.headers — same discipline as the guard just above, for the same
    // reason (a duplicated header must fail closed, not silently resolve to
    // its first value).
    const rawSessionIdHeader = req.headersDistinct['mcp-session-id'];
    const sessionId = strictSingleHeader(rawSessionIdHeader);
    // The fresh-initialize branch keys on the RAW header's absence, not on
    // sessionId being undefined: a present-but-duplicated header is
    // present-and-invalid, which must fall through to the 404 gate below,
    // never be treated as "no session id yet, so start a fresh initialize".
    if (req.method === 'POST' && rawSessionIdHeader === undefined) {
      const bodyRead = await readBodyCapped(req, BODY_CAP_BYTES);
      if (!bodyRead.ok) {
        jsonRpcError(res, 400, -32600, `request body exceeds the ${BODY_CAP_BYTES}-byte cap`);
        return;
      }
      const parsed = parseJsonBody(bodyRead.buffer);
      if (!parsed.ok) {
        jsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
        return;
      }
      if (!isInitializeRequest(parsed.body)) {
        jsonRpcError(res, 400, -32000, 'no session id and not an initialize request');
        return;
      }
      await handleFreshInitialize(req, res, parsed.body);
      return;
    }
    // T2: a single sessions.get, captured once and reused below — the two
    // call sites this replaces (the 404 gate and the subsequent re-fetch)
    // read the exact same sessionId/nowMs pair with no await in between, so
    // the second lookup was always redundant with the first.
    const existingSession = sessionId === undefined ? undefined : sessions.get(sessionId, nowMs);
    if (sessionId === undefined || existingSession === undefined) {
      jsonRpcError(res, 404, -32001, 'unknown or expired session');
      return;
    }
    sessions.touch(sessionId, nowMs);
    const { transport } = existingSession;
    if (req.method === 'POST') {
      const bodyRead = await readBodyCapped(req, BODY_CAP_BYTES);
      if (!bodyRead.ok) {
        jsonRpcError(res, 400, -32600, `request body exceeds the ${BODY_CAP_BYTES}-byte cap`);
        return;
      }
      const parsed = parseJsonBody(bodyRead.buffer);
      if (!parsed.ok) {
        jsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
        return;
      }
      await transport.handleRequest(req, res, parsed.body);
      return;
    }
    // GET (SSE stream) and DELETE (session termination) carry no body of
    // interest here; the transport handles both based on req.method.
    await transport.handleRequest(req, res);
  };

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  // H4 — slow-client LIFETIME hardening (Node's own defaults are 300_000ms
  // request / 60_000ms headers). Honest framing: these are THRESHOLDS Node
  // checks periodically (via its internal `connectionsCheckingInterval`,
  // default ~30s), not exact wall-clock deadlines — an incomplete
  // request/header phase can therefore stay open somewhat longer than the
  // nominal value before Node notices and closes it, but the values still
  // give a finite lifetime bound: a stalled client can no longer pin a
  // pre-session body read open indefinitely. They do NOT bound the NUMBER
  // of simultaneous pre-session requests or aggregate buffered memory. The
  // aggregate-memory residual (~BODY_CAP_BYTES per concurrent connection)
  // is an ACCEPTED approximation under this project's single-local-client +
  // 256-bit-bearer threat model: a semaphore around no-session body reads
  // (a real aggregate bound) and `maxConnections` (a coarse TCP cap) were
  // both deliberately NOT added — the former adds a new rejection failure
  // mode for a trusted-localhost server, the latter risks rejecting the
  // legitimate 8-session burst. Both `requestTimeout` and `headersTimeout`
  // stay safely ABOVE SHUTDOWN_FORCE_MS (5000ms) so it never interferes
  // with the bounded graceful-shutdown path or the concurrent-burst tests.
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        // The listen() call does not throw/reject on EADDRINUSE (verified
        // fact above) — the failure surfaces asynchronously via 'error'. Without
        // this listener, a port conflict would hang forever instead of
        // reaching the CLI's normal startup-error path.
        const onError = (err: Error): void => {
          httpServer.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          httpServer.removeListener('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(opts.port, '127.0.0.1');
      }),
    close: async () => {
      // H3: flip the shutdown admission fence FIRST — synchronously, before
      // the session-drain snapshot just below is taken — so a fresh
      // initialize whose body is still arriving right now can no longer
      // slip a brand-new session into existence after this snapshot has
      // already been captured (which would leave it permanently undrained).
      closing = true;
      // C5 fix: close every session's SERVER FIRST (an open SSE response
      // would otherwise keep the LISTENER's own close() pending
      // indefinitely — http.Server#close() waits for existing connections
      // to end on their own, verified fact above), THEN the listener — each
      // phase individually bounded by SHUTDOWN_FORCE_MS so a hung
      // connection can never prevent the process from exiting.
      //
      // Closing ONLY `session.server` (never ALSO `session.transport`
      // directly, concurrently) is deliberate, not an omission: the SDK's
      // `Protocol.close()` — which the low-level `Server` inherits
      // (`dist/esm/shared/protocol.js`, verified against the v1.29.0
      // source) — already does `await this._transport?.close()` itself.
      // Calling `transport.close()` a second time, concurrently, alongside
      // `server.close()`'s own internal call would race two overlapping
      // `close()` invocations on the SAME transport instance for no
      // benefit; `server.close()` alone is both sufficient and
      // deterministic (the earlier `session.transport.close()` call this
      // replaces was redundant with, not additive to, what `server.close()`
      // already does).
      //
      // Each fallback timer below is captured and CLEARED as soon as its
      // own `Promise.race` settles: an uncleared `setTimeout` keeps running
      // (and keeps Node's event loop alive) for the FULL SHUTDOWN_FORCE_MS
      // even after a fast, graceful close already WON the race, needlessly
      // delaying process exit by up to 5 extra seconds on the common,
      // fast-shutdown path. `clearTimeout` on an id whose callback has
      // ALREADY fired is a documented no-op (Node `timers` docs), so
      // clearing it unconditionally right after each race is safe either
      // way — no need to know which branch actually won.
      const sessionValues = sessions.values();
      let sessionForceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(sessionValues.map((session) => session.server.close().catch(() => {}))),
        new Promise<void>((resolve) => {
          sessionForceTimer = setTimeout(resolve, SHUTDOWN_FORCE_MS);
        }),
      ]);
      clearTimeout(sessionForceTimer);

      let listenerForceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          listenerForceTimer = setTimeout(() => {
            httpServer.closeAllConnections();
            resolve();
          }, SHUTDOWN_FORCE_MS);
        }),
      ]);
      clearTimeout(listenerForceTimer);
    },
  };
};
