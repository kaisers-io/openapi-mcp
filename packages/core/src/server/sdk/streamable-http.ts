import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler, isJsonContentType } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { usageError } from '../../errors.ts';
import type { DispatcherDeps } from '../dispatch.ts';
import type { OAuthResourceServer } from '../http/oauth.ts';
import { evaluateHostOrigin, evaluateRequest, singleHeader } from '../http/request-guard.ts';
import type { HostOriginOptions, RequestGuardOptions } from '../http/request-guard.ts';
import type { ServerSnapshot } from '../types.ts';
import { createProtocolSession } from './protocol.ts';

const BODY_CAP_BYTES = 4 * 1024 * 1024;
// Bounded forced-close fallback for graceful shutdown: if tearing the serving
// entry down, or closing the listener itself, has not finished within this
// bound, force-destroy remaining connections rather than hang the process.
const SHUTDOWN_FORCE_MS = 5000;

// The pre-parsed body handed to the SDK when this module deliberately does
// NOT parse (see the Content-Type gate below). The adapter reads the request
// stream itself ONLY when `parsedBody === undefined`, so any non-undefined
// value keeps it away from a stream this module has already consumed —
// re-entering that read yields an EMPTY body (the stream has ended), i.e. a
// body that is not the one the client sent, for anything downstream that
// looks at it. The handler's media-type rejection lands BEFORE it looks, so
// this is what keeps that ordering from being load-bearing rather than a
// coincidence this module depends on. `null` rather than a JSON-RPC-shaped
// object on purpose: it cannot be mistaken for a real message anywhere
// downstream. A FUNCTION would not work at all — the adapter maps a function
// third argument back to `undefined`, since that is Express's `next`.
// oxlint-disable-next-line no-null -- `undefined` is precisely the value that means "nothing pre-parsed, read the stream yourself", which is the behavior being suppressed here
const CONSUMED_BODY_SENTINEL = null;

// OAuth resource-server mode: the same Host/Origin checks, then a token
// validated by the resource server instead of the static bearer.
export type OAuthGuardOptions = HostOriginOptions & { oauth: OAuthResourceServer };

// The address bound when none is given. Anything else is accepted only in
// OAuth mode: the static bearer is one shared, non-expiring secret sized
// for a single local client, never a credential to expose on a network.
const LOOPBACK_BIND = '127.0.0.1';
const LOOPBACK_BINDS = new Set([LOOPBACK_BIND, '::1', 'localhost']);

export type StreamableHttpOptions = {
  name: string;
  version: string;
  snapshot: ServerSnapshot;
  dispatcherDeps: Omit<DispatcherDeps, 'snapshot'>;
  // Page size for tools/list; undefined = no paging (see tool-list.ts).
  toolsPageSize?: number;
  guard: RequestGuardOptions | OAuthGuardOptions;
  port: number;
  // Bind address; defaults to 127.0.0.1. A non-loopback address requires
  // OAuth mode (`guard.oauth`) and is refused otherwise.
  hostname?: string;
  // Out-of-band errors: everything that fails with no JSON-RPC reply to
  // attach it to — a rejected/unservable request, an adapter-level
  // conversion failure, or a body read that died with the client. Optional
  // and reporting-only: it never alters a response. Symmetric with the stdio
  // binding's own `onError`, so a caller does not have to discover that one
  // transport reports and the other silently swallows.
  onError?: (error: Error) => void;
};

export type StreamableHttpServerHandle = {
  listen: () => Promise<void>;
  close: () => Promise<void>;
};

// A JSON-RPC-shaped error response — used for EVERY rejection this module
// writes itself (guard denials aside, which have no body), so a client never
// sees a bare socket reset/500 for something this server can diagnose
// cleanly (see the method gate, the body-cap and the parse-error handling
// below). `extraHeaders` carries whatever a particular status additionally
// requires on the wire — today only the method gate's `Allow`.
const jsonRpcError = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders }).end(
    // oxlint-disable-next-line no-null -- JSON-RPC 2.0 requires a literal `null` id when the id of the failed request cannot be determined
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
  );
};

// Reads the body up to capBytes. On overflow this ENDS the read cleanly (does
// not `req.destroy()` the socket, which a client sees as an abrupt reset) and
// resolves with a sentinel so the caller can write a DELIBERATE 400 JSON-RPC
// rejection instead — a reset looks like a crash/500 to a well-behaved HTTP
// client, not an intentional application-level rejection.
type BodyReadResult = { ok: true; buffer: Buffer } | { ok: false; reason: 'too-large' };

const readBodyCapped = (req: IncomingMessage, capBytes: number): Promise<BodyReadResult> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps IncomingMessage's data/end/error event-emitter interface, which has no native promise form
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

// A DELIBERATE JSON-RPC parse-error 400 (code -32700) on invalid JSON — never a
// generic 500. An empty body yields `undefined`, which the adapter treats as
// "no pre-parsed body".
type ParsedBodyResult = { ok: true; body: unknown } | { ok: false };

// The adapter accepts a DUCK-TYPED request shape (declared structurally so it
// stays free of `node:` imports) whose `method`/`url` are plain OPTIONAL
// properties (`method?: string`), whereas Node's own `IncomingMessage` declares
// them as `string | undefined` — two shapes `exactOptionalPropertyTypes` (this
// project's tsconfig) treats as distinct, even though they are behaviorally
// identical and the adapter reads both through an `??` fallback. Derived from
// the adapter itself so the one cast below stays bound to what that function
// actually accepts rather than restating its shape.
type AdaptedRequest = Parameters<ReturnType<typeof toNodeHandler>>[0];

const parseJsonBody = (buffer: Buffer): ParsedBodyResult => {
  if (buffer.length === 0) {
    return { ok: true, body: undefined };
  }
  try {
    // A FATAL UTF-8 decode, not `buffer.toString('utf8')`:
    // `Buffer#toString('utf8')` lenient-decodes any invalid byte sequence to
    // U+FFFD instead of throwing, which would let a non-UTF-8 body silently
    // become valid JS text (and, in principle, valid JSON) here.
    // `TextDecoder`'s `fatal: true` option throws on invalid UTF-8 instead, so
    // a malformed-encoding body is rejected by the SAME catch below as
    // malformed JSON — the deliberate 400/-32700 parse-error path, never a
    // lenient pass-through.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

// Serves the RFC 9728 Protected Resource Metadata document. Answered before
// authentication — it is the document an unauthenticated client needs to
// find the authorization server — but after the Host/Origin checks, like
// every other request. Returns false when the path is not the metadata path.
const serveProtectedResourceMetadata = (
  req: IncomingMessage,
  res: ServerResponse,
  oauth: OAuthResourceServer,
): boolean => {
  let path: string;
  try {
    ({ pathname: path } = new URL(req.url ?? '/', 'http://localhost'));
  } catch {
    return false;
  }
  if ((path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path) !== oauth.metadataPath) {
    return false;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return true;
  }
  const body = JSON.stringify(oauth.metadataDocument);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
};

export const createStreamableHttpServer = (
  opts: StreamableHttpOptions,
): StreamableHttpServerHandle => {
  const hostname = opts.hostname ?? LOOPBACK_BIND;
  // Enforced here as well as in the CLI, so no caller of this module can
  // put the static bearer on a non-loopback interface.
  if (!LOOPBACK_BINDS.has(hostname) && !('oauth' in opts.guard)) {
    throw usageError(`binding ${hostname} requires OAuth resource-server mode`);
  }
  // ONE sink, handed to every hook that can produce an out-of-band error, so
  // a caller wires the transport's error reporting once instead of per layer.
  // Normalizing to Error here (rather than at each call site) keeps the
  // public option's signature honest: a caller is promised an Error, and the
  // outer request-level catch below can be handed an unknown rejection value.
  const reportError = (error: unknown): void => {
    try {
      opts.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A sink that THROWS must never become the failure: reporting is
      // best-effort by contract, and the realistic thrower is the sink's own
      // output path dying (a stderr write failing with EPIPE once a parent
      // process is gone). Swallowed deliberately, because the alternative is
      // worse than a lost report: from the request-level `.catch` below, an
      // exception here rejects that catch's promise with NOTHING left to
      // observe it, and Node's default unhandled-rejection mode ends the
      // process — a client-triggerable crash in place of a 500. Both SDK
      // hooks isolate their own callback the same way (each wraps the call
      // in try/catch), so this closes the one remaining path.
    }
  };
  // `createMcpHandler` — NOT a hand-wired transport — is what puts 2026-07-28
  // on the wire: it classifies each request's era from its `_meta` envelope
  // claim and builds ONE instance from this factory per request. Serving is
  // per request end to end — there is no session state, so GET and DELETE
  // (the 2025 session operations) have no meaning here and are answered 405
  // by the method gate below.
  //
  // The factory closes over the caller's snapshot and EVERY entry in
  // `dispatcherDeps` (including the limiter) as the SAME shared references for
  // every request: constructing a new limiter here would silently make it
  // per-request instead of process-global. `createDispatcher` IS called fresh
  // per request inside `createProtocolSession`, but it is a pure, stateless
  // closure over those shared references.
  const handler = createMcpHandler(
    () =>
      createProtocolSession({
        name: opts.name,
        version: opts.version,
        snapshot: opts.snapshot,
        dispatcherDeps: opts.dispatcherDeps,
        ...(opts.toolsPageSize === undefined ? {} : { toolsPageSize: opts.toolsPageSize }),
      }),
    {
      // Stated explicitly rather than left to the option's default: a
      // claim-less 2025-era POST keeps being served, per request, by this
      // same factory, so a client that never learned the modern revision
      // keeps working against this exact endpoint at no cost to the modern
      // path.
      legacy: 'stateless',
      // Every rejection the handler answers in band (a media-type or
      // header/body-ladder refusal, a legacy-leg failure) also reports here;
      // without this hook those reasons — the only place the SPECIFIC cause
      // is spelled out — are lost, since the wire answer carries only the
      // code and a fixed message.
      onerror: reportError,
    },
  );
  // The adapter that gives the web-standard handler a Node
  // `(req, res, parsedBody?)` face. It answers a 500 itself if the handler
  // throws, so nothing past this hand-off reaches the request-level `.catch`
  // below with headers unsent. Wrapped once — the ONE cast site for the
  // optionality gap described at AdaptedRequest above. Only a POST ever
  // reaches it (see the method gate below), always with the already-parsed
  // body; an EMPTY POST body parses to `undefined`, which is exactly
  // equivalent to omitting the argument: the adapter then reads the request
  // stream itself, already drained here, and classifies the empty body
  // itself.
  // The adapter's own `onerror` observes the ONE failure mode the handler
  // cannot report itself: a request-conversion failure, or the handler face
  // throwing outright (it throws once closed), before the adapter writes its
  // fallback 500.
  const nodeHandler = toNodeHandler(handler, { onerror: reportError });
  const dispatchToHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> => nodeHandler(req as unknown as AdaptedRequest, res, parsedBody);

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Reads req.headersDistinct, NOT req.headers: Node silently collapses a
    // duplicate Host/Authorization header to its first value and merges a
    // duplicate Origin into one comma-joined string via the plain `.headers`
    // accessor — either would defeat evaluateRequest's array-based
    // duplicate-header rejection. `.headersDistinct.<name>` always returns
    // every value actually sent as `string[] | undefined`, which is what that
    // rejection logic needs to see.
    const headers = {
      // Bracket notation: `headersDistinct` is `NodeJS.Dict<string[]>` (an
      // index-signature type), which this project's tsconfig
      // (noPropertyAccessFromIndexSignature) requires accessing this way.
      host: req.headersDistinct['host'],
      origin: req.headersDistinct['origin'],
      authorization: req.headersDistinct['authorization'],
    };
    if ('oauth' in opts.guard) {
      const { oauth } = opts.guard;
      const hostOrigin = evaluateHostOrigin(opts.guard, headers);
      if (hostOrigin.outcome === 'deny') {
        res.writeHead(hostOrigin.status).end();
        return;
      }
      if (serveProtectedResourceMetadata(req, res, oauth)) {
        return;
      }
      // A duplicated Authorization header collapses to "absent" exactly as
      // in static mode, and is answered with the 401 challenge.
      const auth = await oauth.authenticate(singleHeader(headers.authorization));
      if (auth.outcome === 'deny') {
        if (auth.reason !== undefined) {
          reportError(new Error(`oauth: ${auth.reason}`));
        }
        res.writeHead(auth.status, auth.headers).end(auth.body);
        return;
      }
    } else {
      const decision = evaluateRequest(opts.guard, headers);
      if (decision.outcome === 'deny') {
        res.writeHead(decision.status).end();
        return;
      }
    }
    // The METHOD GATE. Serving here is a SINGLE POST endpoint, so every other
    // method is answered 405 by this module itself, BEFORE any body handling
    // — deliberately NOT delegated to the handler, which would answer the
    // very same 405 (`-32000` / `Method not allowed.`) but only after a
    // hazard in the adapter's request conversion has already run: for every
    // method except GET and HEAD it EAGERLY BUFFERS the entire request body
    // into one string (`if (method !== 'GET' && method !== 'HEAD') if
    // (parsedBody === undefined) { for await (const chunk of req) ... }`)
    // before the handler ever inspects the method — with no cap anywhere on
    // that path. Measured against this adapter version: a 64 MB DELETE grew
    // the serving process by ~178 MB of RSS and its 405 arrived only after
    // the last byte was sent. Answering here instead leaves the body
    // UNREAD, which is what keeps memory flat: Node discards the remainder
    // of an unconsumed request itself once the response finishes, rather
    // than accumulating it. `Allow` names the one method this endpoint
    // serves, so a client learns the shape of the endpoint from the
    // rejection.
    if (req.method !== 'POST') {
      jsonRpcError(res, 405, -32_000, 'Method not allowed.', { allow: 'POST' });
      return;
    }
    // The body cap and the fatal-UTF-8 parse run BEFORE the hand-off, on
    // purpose — the same eager-buffering hazard as above, seen from the POST
    // side: the adapter would otherwise buffer the whole body itself while
    // converting the request, so an oversized or non-UTF-8 body would already
    // have been read in full before anything could reject it. The parsed
    // value is handed over as the pre-parsed body, so the bytes are decoded
    // exactly once — by the same fatal decoder that vetted them.
    const bodyRead = await readBodyCapped(req, BODY_CAP_BYTES);
    if (!bodyRead.ok) {
      jsonRpcError(res, 400, -32_600, `request body exceeds the ${BODY_CAP_BYTES}-byte cap`);
      return;
    }
    // CONTENT-TYPE BEFORE PARSE. The handler settles the media type before it
    // looks at a body at all — its entry answers 415 (`Unsupported Media
    // Type: Content-Type must be application/json`) for any POST that is not
    // JSON-typed, ahead of its own classification step. Parsing here first
    // would let THIS module's -32700 pre-empt that 415 whenever a request is
    // both wrong-typed AND malformed: the wrong answer, from the wrong layer.
    // So the parse is skipped and the request handed over for the canonical
    // rejection. Only the PARSE moves — the capped read above still runs
    // first, because it is the only thing bounding the body at all, and that
    // is exactly why the sentinel is needed: the stream is already consumed.
    // The predicate is the handler's OWN exported one, imported rather than
    // restated, so parameterized and odd-cased spellings
    // (`application/json; charset=utf-8`) bucket here exactly as they bucket
    // there — a hand-rolled `startsWith`/equality check would drift from it.
    if (!isJsonContentType(req.headers['content-type'])) {
      await dispatchToHandler(req, res, CONSUMED_BODY_SENTINEL);
      return;
    }
    const parsed = parseJsonBody(bodyRead.buffer);
    if (!parsed.ok) {
      jsonRpcError(res, 400, -32_700, 'Parse error: request body is not valid JSON');
      return;
    }
    // Everything past this point — the 2026-07-28 header/body agreement
    // ladder (`Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`), the era
    // classification, and the dispatch itself — belongs to the handler;
    // nothing here re-answers or swallows those rejections.
    await dispatchToHandler(req, res, parsed.body);
  };

  const httpServer = createServer((req, res) => {
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- node:http's request-event callback is synchronous void by contract; it cannot be awaited, so a rejection must be caught explicitly here instead, and the caught value has to be bound to a parameter to be reported at all
    handleRequest(req, res).catch((error: unknown) => {
      // Reported, not discarded: this catch covers the PRE-hand-off paths
      // (in practice a body read that died with its client), whose only
      // wire answer is a bodyless 500 — the exception text is the sole
      // description of what actually happened.
      reportError(error);
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  // Slow-client LIFETIME hardening (Node's own defaults are 300_000ms request
  // / 60_000ms headers). Honest framing: these are THRESHOLDS Node checks
  // periodically (via its internal `connectionsCheckingInterval`, default
  // ~30s), not exact wall-clock deadlines — an incomplete request/header phase
  // can therefore stay open somewhat longer than the nominal value before Node
  // notices and closes it, but the values still give a finite lifetime bound:
  // a stalled client cannot pin a body read open indefinitely. They do NOT
  // bound the NUMBER of simultaneous requests or aggregate buffered memory.
  // That residual (~BODY_CAP_BYTES per concurrent connection) is an ACCEPTED
  // approximation under this project's single-local-client + 256-bit-bearer
  // threat model: a semaphore around body reads (a real aggregate bound) and
  // `maxConnections` (a coarse TCP cap) were both deliberately NOT added — the
  // former adds a new rejection failure mode for a trusted-localhost server,
  // the latter risks rejecting a legitimate burst. In OAuth mode the same
  // holds per AUTHENTICATED client: no body is read before the token has
  // validated. Both values stay safely
  // ABOVE SHUTDOWN_FORCE_MS (5000ms) so neither interferes with the bounded
  // graceful-shutdown path below.
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;

  return {
    listen: () =>
      // oxlint-disable-next-line promise/avoid-new -- wraps httpServer's listening/error event-emitter interface; net.Server#listen has no promise form
      new Promise((resolve, reject) => {
        // The listen() call does not throw/reject on EADDRINUSE — the failure
        // surfaces asynchronously via 'error'. Without this listener, a port
        // conflict would hang forever instead of reaching the caller's normal
        // startup-error path. Whichever event fires removes the OTHER listener,
        // so neither outlives this one call on a server the caller may still
        // close (or retry) afterwards.
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
        httpServer.listen(opts.port, hostname);
      }),
    close: async () => {
      // Tear the serving entry down FIRST, then the listener: an in-flight
      // exchange (or an open per-request stream) would otherwise keep the
      // LISTENER's own close() pending indefinitely — http.Server#close() waits
      // for existing connections to end on their own — whereas the entry's
      // close aborts its exchanges so each response completes and its
      // connection ends. Each phase is individually bounded by
      // SHUTDOWN_FORCE_MS so a hung connection can never prevent the process
      // from exiting; a request arriving after this point is answered 500 by
      // the adapter rather than served by a torn-down entry.
      //
      // Each fallback timer below is captured and CLEARED as soon as its own
      // `Promise.race` settles: an uncleared `setTimeout` keeps running (and
      // keeps Node's event loop alive) for the FULL SHUTDOWN_FORCE_MS even
      // after a fast, graceful close already WON the race, needlessly delaying
      // process exit by up to 5 extra seconds on the common path. Clearing an
      // id whose callback has ALREADY fired is a documented no-op (Node
      // `timers` docs), so it is safe to clear unconditionally either way.
      let handlerForceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        handler.close().catch(() => {
          // Best-effort during shutdown — nothing more actionable if it fails.
        }),
        // oxlint-disable-next-line promise/avoid-new -- deadline branch racing the entry teardown; setTimeout's callback has no promise form to await directly
        new Promise<void>((resolve) => {
          handlerForceTimer = setTimeout(resolve, SHUTDOWN_FORCE_MS);
        }),
      ]);
      clearTimeout(handlerForceTimer);

      let listenerForceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        // oxlint-disable-next-line promise/avoid-new -- wraps httpServer.close(callback), which has no promise form
        new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        }),
        // oxlint-disable-next-line promise/avoid-new -- deadline branch racing the listener close above; pairs with it via Promise.race, same setTimeout-has-no-promise-form reason
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
