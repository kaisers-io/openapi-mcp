import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import type { fetch as undiciFetchType } from 'undici';
import type { PinnedAgentPool } from './agent-pool.ts';
import { classifyAddress, METADATA_HOSTNAMES } from './egress.ts';
import { captureResponseHeaders } from './response-headers.ts';

// The SSRF connection-pinning core. undici's custom connect.lookup resolves
// the hostname exactly once via the injected `resolve`, validates EVERY
// answer with the hardened classifyAddress BEFORE any socket is opened, and
// connects only to the validated IPs — so there is a single DNS resolution
// per connection and no separate "validate, then resolve again" TOCTOU
// window. undici preserves the original Host header and TLS SNI/cert against
// the hostname regardless of which IP the lookup callback selects. A plain
// Agent with a custom `connect` never consults HTTP(S)_PROXY — there is no
// proxy-dispatch code path for it to reach.
//
// Node skips `lookup` entirely for an IP-literal hostname, so this Agent
// alone does not protect a hop whose URL is already an IP literal (e.g. a
// redirect to 127.0.0.1 or 169.254.169.254) — that synchronous per-hop check
// is validateHopUrlSync's job, called from pinnedRequest before every hop.

export type PinnedPolicy = {
  allowPrivateNetwork: boolean;
  // Hop 0 from --base-url: skip the private-address deny (metadata is still
  // always denied). A redirect hop is never trusted.
  trusted: boolean;
};

// Bound to an abort signal by the caller: pinnedRequest binds the call's
// signal for a per-hop Agent; the agent pool binds a per-lookup timeout,
// since a long-lived Agent outlives any one call.
export type Resolve = (hostname: string) => Promise<readonly string[]>;

// Bounds the cost of validating a hostile/misconfigured resolver's answer
// set, and the size of the address array handed to undici's connector.
export const MAX_DNS_ANSWERS = 32;

// Undici's fetch surfaces a connect-time lookup failure as a generic
// `TypeError("fetch failed")` whose `.cause` carries the ORIGINAL lookup
// error — `.message` alone cannot discriminate an egress policy denial from a
// genuine network failure. Every policy-driven rejection below
// (zero/too-many/non-IP answers, metadata, private) is thrown as this
// branded class so pinnedRequest can walk `err.cause`/`err.cause.errors` and
// classify reliably via `instanceof` rather than matching a message string. A
// resolver's OWN thrown/rejected error (a genuine DNS/network failure, not a
// policy decision) stays a plain Error via `asError` below and is classified
// 'network'.
export class EgressError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

// Exported so the lookup contract's edge cases (the options.all fallback and
// the sync-throw wrapping) can be unit-tested directly — undici's own
// connector always calls back with options.all === true, so the fallback
// branch below is otherwise unreachable through a real fetch.
//
// A callback-once latch is required here: V8's Promise/thenable dedup alone
// does not make a second settle call unreachable. If the SUCCESS-path settle
// call itself (the `.then` handler's own `settle(...)`) throws synchronously
// — e.g. a misbehaving downstream lookup callback — that throw rejects the
// `.then`'s promise, which is then caught by the trailing `.catch` below,
// which calls settle a SECOND time with the thrown error. V8's dedup
// guarantees a thenable settles only once; it says nothing about a handler
// that settles once successfully and then throws. The latch below keeps the
// "exactly once" contract true in that case too.
export const pinnedLookup =
  (policy: PinnedPolicy, resolve: Resolve): LookupFunction =>
  (hostname, options, callback) => {
    let settled = false;
    // Aliased to a non-"callback"-shaped name: calling the LookupFunction's
    // own `callback` parameter from inside a `.then`/`.catch` handler (below)
    // is exactly the shape oxlint's promise/no-callback-in-promise flags —
    // this IS a `.then`/`.catch`-driven settle by design (the lookup
    // contract itself is a Node-style callback), not the callback-inside-
    // promise anti-pattern the rule targets. Latched so the underlying
    // `callback` fires at most once even if the success path itself throws
    // and re-enters via `.catch`.
    const settle: typeof callback = (err, address, family) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(err, address, family);
    };
    // Wrapped in Promise.resolve().then(...) so a SYNCHRONOUS throw inside
    // `resolve` still reaches the .catch below instead of leaving the
    // callback — and the request — hanging.
    Promise.resolve()
      // oxlint-disable-next-line promise/prefer-await-to-then -- bridges into LookupFunction's Node-style (hostname, options, callback) contract; the callback has no async form to await into
      .then(() => resolve(hostname))
      // oxlint-disable-next-line promise/prefer-await-to-then -- continues the same callback-contract bridge chain as the .then above
      .then((addresses) => {
        if (addresses.length === 0) {
          return settle(
            new EgressError(`egress: "${hostname}" did not resolve to any address`),
            [],
          );
        }
        if (addresses.length > MAX_DNS_ANSWERS) {
          return settle(new EgressError(`egress: "${hostname}" returned too many DNS answers`), []);
        }
        for (const address of addresses) {
          if (isIP(address) === 0) {
            return settle(new EgressError(`egress: "${hostname}" returned a non-IP answer`), []);
          }
          const classification = classifyAddress(address);
          if (classification === 'metadata') {
            return settle(
              new EgressError(`egress: "${hostname}" resolves to a cloud-metadata address`),
              [],
            );
          }
          if (classification === 'private' && !(policy.trusted || policy.allowPrivateNetwork)) {
            return settle(
              new EgressError(`egress: "${hostname}" resolves to a private/loopback address`),
              [],
            );
          }
        }
        // The array-callback form is valid only when options.all === true, so
        // that flag is checked rather than ignored. Node/undici's connector
        // always requests it that way, but a defensive single-address
        // fallback keeps the contract honest.
        if (options.all === true) {
          return settle(
            null,
            addresses.map((address) => ({ address, family: isIP(address) })),
          );
        }
        const [first] = addresses;
        // Unreachable via undici in practice (it always passes all:true);
        // kept total per the lookup contract's non-`all` form.
        return settle(null, first ?? '', first === undefined ? undefined : isIP(first));
      })
      // oxlint-disable-next-line promise/prefer-await-to-then -- terminal handler of the same callback-contract bridge chain; settles the LookupFunction callback on any rejection
      .catch((error: unknown) => settle(asError(error), []));
  };

export const createPinnedAgent = (policy: PinnedPolicy, resolve: Resolve): Agent =>
  new Agent({ connect: { lookup: pinnedLookup(policy, resolve) } });

// The shared, SSRF-safe redirect transport built on top of createPinnedAgent
// above. Manual redirects capped at MAX_REDIRECTS, a per-hop pinned Agent
// (pooled per origin+policy when the caller supplies a pool; never trusted
// past hop 0), monotonic cross-origin header stripping,
// a write-method redirect abort, a merged client+timeout deadline, and a
// decompressed-byte cap. Never produces a ToolCallOutcome (SDK-neutral) —
// bytes+status+contentType or a typed error the caller maps.

export type PinnedErrorReason =
  | 'timeout'
  | 'cancelled'
  | 'egress'
  | 'too-large'
  | 'redirect-loop'
  | 'redirect-write-method'
  | 'redirect-invalid'
  | 'network';

export type PinnedResponse = {
  kind: 'response';
  status: number;
  // Raw response Content-Type header, undefined if absent.
  contentType?: string;
  // Decompressed, capped.
  bodyBytes: Uint8Array;
  // The allowlisted, size-bounded response headers (lowercased names) —
  // raw upstream values; see http/response-headers.ts.
  headers: Readonly<Record<string, string>>;
  // The URL of the hop that produced this response (after redirects), so
  // a relative `Location`/`Link` target resolves against the right base.
  url: string;
};

export type PinnedOutcome =
  | PinnedResponse
  | {
      kind: 'error';
      reason: PinnedErrorReason;
      detail?: string;
      // True only when the failure happened before any response (status
      // line) arrived — the request may not have reached the upstream at
      // all, so an idempotent retry cannot observe a partial response.
      beforeResponse?: true;
    };

export type HopHeaders = {
  // Sent only while still on the original origin (auth + tool + content).
  sameOriginHeaders: Record<string, string>;
  // The minimal safe set for a foreign origin (content only).
  crossOriginHeaders: Record<string, string>;
};

export type PinnedRequestOptions = {
  method: string;
  headers: HopHeaders;
  // Already-serialized; never sent on GET/HEAD or after hop 0.
  body?: Uint8Array;
  // Hop 0 trust (from --base-url).
  baseTrusted: boolean;
  allowPrivateNetwork: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  // The MCP client-cancel signal (extra.signal).
  signal: AbortSignal;
  // An extra, caller-specific check applied to EVERY hop (hop 0 and each
  // redirect target) before it is requested: returns an error description
  // to refuse the hop as egress, or undefined to allow it. Used where the
  // caller's own URL rules (e.g. https-only) must also bind redirects.
  checkHop?: (url: URL) => string | undefined;
};

// Typed via undici's own fetch, never Node's global fetch (dual-package
// hazard: the global fetch rejects an installed-undici Agent) — a type-only
// import, so it does not pull in a fetch VALUE and keeps this module free of
// a module-level singleton.
type UndiciFetch = typeof undiciFetchType;
type UndiciResponse = Awaited<ReturnType<UndiciFetch>>;

export type PinnedDeps = {
  fetch: UndiciFetch;
  resolve: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  // Default () => AbortSignal.timeout(ms); injectable for tests.
  timeoutSignal: (ms: number) => AbortSignal;
  // Long-lived pinned Agents keyed by (origin, trust policy), owned by the
  // caller (the executor). When present, every hop borrows its Agent from
  // the pool and never closes it, so connections are reused across calls;
  // when absent, a fresh Agent is built and closed per hop (spec fetch, and
  // any caller without a lifecycle to own a pool).
  agents?: PinnedAgentPool;
};

export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Only GET and HEAD follow a 301/302/307/308. A write would be re-sent or
// silently rewritten. A QUERY carries its query in the body, which is sent on
// the first hop only, so following would repeat it without its content; RFC
// 10008 §2.5 lets a client resend it, this one refuses, as for a write. Any
// other method (OpenAPI 3.2 `additionalOperations`) is refused like a write.
const GET_HEAD_METHODS = new Set(['GET', 'HEAD']);

// The cloud-metadata hostname set is imported from egress.ts (single source
// of truth) so this guard and egress.ts's async assertAllowedRedirectTarget
// can never diverge.

// URL.hostname keeps brackets around an IPv6 literal; strip them for isIP()
// (mirrors egress.ts's private hostnameOf).
const hostnameOf = (url: URL): string => {
  const raw = url.hostname;
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
};

const describeCause = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Sync try/catch confined entirely to this helper — `new URL` throws
// synchronously on an invalid Location header. A `.catch()` chain has no
// meaning for a non-Promise call, and this stays purely local: no lock,
// abort, or cleanup boundary is crossed by extracting it.
const parseRedirectLocation = (location: string, base: URL): URL | undefined => {
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
};

type AbortWinner = 'cancelled' | 'timeout';

// Discriminates the abort WINNER by which component signal actually fired
// FIRST, captured at fire time via a `{ once: true }` listener on EACH of the
// client signal and the timeout signal — never by re-checking `.aborted` at
// error-handling time. Re-checking `.aborted` later misclassifies a
// timeout-then-client race: the timeout signal fires and wins first, but by
// the time the error path reads `opts.signal.aborted` the client signal has
// ALSO since aborted (e.g. an MCP client cancelling right after a
// server-side timeout already committed) — a check based on `.aborted` alone
// would then wrongly report 'cancelled'. A signal already aborted before
// this function runs never re-fires its 'abort'
// event, so an already-aborted signal is recorded immediately instead of via
// a listener. Whichever is recorded FIRST (by call order below, or by
// firing order once both are live) wins; later recordings are no-ops.
const trackAbortWinner = (
  clientSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): (() => AbortWinner | undefined) => {
  let winner: AbortWinner | undefined;
  const record =
    (which: AbortWinner): (() => void) =>
    () => {
      if (winner === undefined) {
        winner = which;
      }
    };
  if (clientSignal.aborted) {
    record('cancelled')();
  } else {
    clientSignal.addEventListener('abort', record('cancelled'), { once: true });
  }
  if (timeoutSignal.aborted) {
    record('timeout')();
  } else {
    timeoutSignal.addEventListener('abort', record('timeout'), { once: true });
  }
  return () => winner;
};

// Falls back to re-checking `.aborted` only if `trackAbortWinner` somehow
// recorded neither signal — unreachable in practice (the merged
// `AbortSignal.any([client, timeout])` firing guarantees at least one
// component fired before this is ever called), kept only as a defensive,
// not-modelled-as-reachable fallback per the design note above `AbortWinner`.
const isCancel = (winner: AbortWinner | undefined, clientSignal: AbortSignal): PinnedErrorReason =>
  winner ?? (clientSignal.aborted ? 'cancelled' : 'timeout');

// Node/undici skip connect.lookup ENTIRELY for an IP-literal hostname, so
// createPinnedAgent's lookup never runs for a hop whose URL is already an IP literal (a
// redirect target, or even hop 0). This synchronous check closes that gap
// for EVERY hop, classifying under the SAME trust policy the Agent for that
// hop would apply, BEFORE any Agent is built or request issued. Returns an
// error-description string, or undefined when the hop is allowed.
export const validateHopUrlSync = (url: URL, policy: PinnedPolicy): string | undefined => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `unsupported scheme "${url.protocol}"`;
  }
  if (url.username !== '' || url.password !== '') {
    return 'URL contains userinfo credentials';
  }
  const hostname = hostnameOf(url);
  const lower = hostname.toLowerCase();
  if (METADATA_HOSTNAMES.has(lower)) {
    return `"${lower}" is a cloud-metadata endpoint`;
  }
  if (isIP(hostname) !== 0) {
    const classification = classifyAddress(hostname);
    if (classification === 'metadata') {
      return `"${lower}" is a cloud-metadata address`;
    }
    if (classification === 'private' && !(policy.trusted || policy.allowPrivateNetwork)) {
      return `"${lower}" is a private/loopback address`;
    }
  }
  return undefined;
};

// A local sentinel class (not a message match) for the over-cap outcome, so
// readCapped's caller can discriminate it from any other read failure.
export class TooLargeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

const isEgressError = (value: unknown): value is EgressError => value instanceof EgressError;

const withoutContentType = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'),
  );

// Bounds a hostile/cyclical cause chain so classification cannot loop
// forever. undici wraps a connect-time lookup failure as a generic
// TypeError("fetch failed") whose `.cause` carries the ORIGINAL EgressError;
// an AggregateError-shaped cause (an `.errors` array) is also walked, since
// some Node error aggregation paths use that shape without literally being
// an AggregateError instance.
const MAX_CAUSE_DEPTH = 8;
const containsEgressError = (err: unknown, depth = 0): boolean => {
  if (depth > MAX_CAUSE_DEPTH || err === null || typeof err !== 'object') {
    return false;
  }
  if (isEgressError(err)) {
    return true;
  }
  const { errors } = err as { errors?: unknown };
  if (Array.isArray(errors) && errors.some((sub) => containsEgressError(sub, depth + 1))) {
    return true;
  }
  const { cause } = err as { cause?: unknown };
  return cause === undefined ? false : containsEgressError(cause, depth + 1);
};

// Never read err.message (undici's generic "fetch failed" TypeError tells us
// nothing); walk the cause chain for the branded EgressError instead.
// Anything else is a genuine network failure.
const classifyFetchError = (err: unknown): PinnedErrorReason =>
  containsEgressError(err) ? 'egress' : 'network';

// Content-length fast-reject applies when content-encoding is ABSENT or
// normalizes to 'identity' — not only absent: an encoded response's declared
// length describes the WIRE size, not the decompressed size the cap is
// measured against.
const isIdentityEncoding = (value: string | null): boolean =>
  value === null || value.trim().toLowerCase() === 'identity';

// Reads response.body via getReader(), counting DECOMPRESSED bytes. Mirrors
// spec/fetch.ts's readBodyCapped, adapted to a content-encoding-aware
// pre-check and a local TooLargeError sentinel (not a message match).
// Cancels the reader/body for any incompletely-consumed body — the
// fast-reject, the over-cap stream, and an unexpected reader error alike —
// before this function returns or throws, so the caller's Agent teardown
// never races a live response.
const readCapped = async (
  response: UndiciResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get('content-length');
  if (isIdentityEncoding(response.headers.get('content-encoding')) && contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new TooLargeError(
        `declared content-length ${declared} exceeds the ${maxBytes}-byte budget`,
      );
    }
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  // Defensive belt-and-suspenders alongside the `signal` already bound to
  // the fetch() call itself: forces the pending read to unblock even if a
  // given undici version does not error an in-flight body stream promptly
  // on abort.
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    // oxlint-disable-next-line promise/prefer-await-to-then -- detached from a synchronous 'abort' event listener, which cannot be awaited; a rejection here has nowhere to go but this catch
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (aborted || signal.aborted) {
        throw new Error('response body read aborted');
      }
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TooLargeError(`decompressed body exceeds the ${maxBytes}-byte budget`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!(error instanceof TooLargeError)) {
      await reader.cancel().catch(() => {});
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks);
};

export const pinnedRequest = async (
  initialUrl: URL,
  opts: PinnedRequestOptions,
  deps: PinnedDeps,
): Promise<PinnedOutcome> => {
  const timeoutSig = deps.timeoutSignal(opts.timeoutMs);
  // AbortSignal.any keeps a strong reference to timeoutSig for as long as
  // `signal` is reachable, so its timer is not eligible for GC before it
  // fires.
  const signal = AbortSignal.any([opts.signal, timeoutSig]);
  // Set up BEFORE any request is issued so both component signals have a
  // live listener for the whole call (see trackAbortWinner's design note).
  const getAbortWinner = trackAbortWinner(opts.signal, timeoutSig);
  const originalOrigin = initialUrl.origin;
  // Imperative on purpose: `url`/`crossed` carry state across redirect hops
  // and `hop` bounds a loop whose body performs a real network fetch per
  // iteration — map/filter cannot express a sequential, early-returning,
  // side-effecting hop chain capped at MAX_REDIRECTS.
  let url = initialUrl;
  let crossed = false;
  // A 303 See Other turns any method into a body-less GET (RFC 9110
  // §15.4.4); every other redirect keeps the original method.
  let method = opts.method.toUpperCase();
  let seeOther = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Only the trusted base origin itself carries the caller's trust (from
    // --base-url): hop 0, and a redirect that stays on exactly that origin
    // (scheme+host+port) without ever having left it — the same monotonic
    // rule as the header stripping below. A same-host trailing-slash or
    // `/v1` -> `/v1/` redirect on a private --base-url therefore works,
    // while any other origin (and anything after a cross-origin hop) stays
    // untrusted. The DNS answer for the hop is still validated per socket.
    const onTrustedOrigin = hop === 0 || (url.origin === originalOrigin && !crossed);
    const trusted = opts.baseTrusted && onTrustedOrigin;
    const policy: PinnedPolicy = { allowPrivateNetwork: opts.allowPrivateNetwork, trusted };
    // oxlint-disable-next-line node/no-sync -- validateHopUrlSync does pure in-memory URL/IP classification, no I/O; the name only signals it returns synchronously, not that it wraps a blocking syscall
    const sync = validateHopUrlSync(url, policy) ?? opts.checkHop?.(url);
    if (sync !== undefined) {
      return { kind: 'error', reason: 'egress', detail: sync };
    }
    // A pooled Agent is shared with other calls: it is never closed or
    // destroyed here — an exceptional path aborts only this request (via
    // `signal`), and undici discards that request's socket on its own.
    const pooled = deps.agents !== undefined;
    const agent =
      deps.agents?.acquire(url.origin, policy) ??
      createPinnedAgent(policy, (hostname) => deps.resolve(hostname, signal));
    // MONOTONIC: once the chain has left the original origin, it never
    // regains credentials, even bouncing back to the original origin later.
    const onOriginalOrigin = url.origin === originalOrigin && !crossed;
    const hopHeaders = onOriginalOrigin
      ? opts.headers.sameOriginHeaders
      : opts.headers.crossOriginHeaders;
    // After a 303 the request has no body, so it carries no content-type.
    const headers = seeOther ? withoutContentType(hopHeaders) : hopHeaders;
    const sendBody = hop === 0 && opts.body !== undefined && !GET_HEAD_METHODS.has(method);
    // Declared then assigned inside try/catch (not `.catch()`): a fetch
    // rejection must first destroy() the agent and classify the error
    // (cancelled vs timeout vs egress vs network) before this function can
    // decide what to return — that sequence cannot be expressed as a value
    // produced by a `.catch()` handler without duplicating the
    // classification logic.
    let response: UndiciResponse;
    try {
      response = await deps.fetch(url, {
        method,
        headers,
        ...(sendBody ? { body: opts.body } : {}),
        dispatcher: agent,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      // Exceptional path: destroy(), never the graceful close() that may
      // await a live response.
      if (!pooled) {
        await agent.destroy().catch(() => {});
      }
      if (signal.aborted) {
        return { kind: 'error', reason: isCancel(getAbortWinner(), opts.signal) };
      }
      return {
        kind: 'error',
        reason: classifyFetchError(error),
        detail: describeCause(error),
        beforeResponse: true,
      };
    }
    // Threaded through the try/catch/finally below on purpose: the finally
    // block chooses destroy() vs close() based on whether the try body
    // threw, and that choice must be made in the SAME finally regardless of
    // which return path fired above — extracting it would move cleanup
    // across the try/finally boundary.
    let exceptional = false;
    try {
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        // 303 is always safe to follow as a GET: it points at a different
        // resource describing the outcome (the "created, see here"
        // pattern), never at a place to resend the write. 301/302/307/308
        // after a write are still refused — re-sending (307/308) or
        // silently rewriting (301/302) a write is not this client's call.
        if (response.status === 303 && method !== 'HEAD') {
          seeOther ||= method !== 'GET';
          method = 'GET';
        } else if (!GET_HEAD_METHODS.has(method)) {
          return { kind: 'error', reason: 'redirect-write-method' };
        }
        const location = response.headers.get('location');
        if (location === null) {
          return { kind: 'error', reason: 'redirect-invalid', detail: 'no Location header' };
        }
        const next = parseRedirectLocation(location, url);
        if (next === undefined) {
          return { kind: 'error', reason: 'redirect-invalid', detail: 'invalid Location header' };
        }
        if (next.origin !== originalOrigin) {
          crossed = true;
        }
        url = next;
        continue;
      }
      const bodyBytes = await readCapped(response, opts.maxResponseBytes, signal);
      const contentType = response.headers.get('content-type');
      return {
        kind: 'response',
        status: response.status,
        ...(contentType === null ? {} : { contentType }),
        bodyBytes,
        headers: captureResponseHeaders(response.headers),
        url: url.href,
      };
    } catch (error) {
      exceptional = true;
      if (signal.aborted) {
        return { kind: 'error', reason: isCancel(getAbortWinner(), opts.signal) };
      }
      if (error instanceof TooLargeError) {
        return { kind: 'error', reason: 'too-large' };
      }
      return { kind: 'error', reason: 'network', detail: describeCause(error) };
    } finally {
      // Every non-exceptional path (a plain 200, or a redirect hop whose
      // body was already cancelled above) closes gracefully; every
      // exceptional path above already destroyed. Runs even on `continue`.
      if (!pooled) {
        await (exceptional ? agent.destroy() : agent.close()).catch(() => {});
      }
    }
  }
  return { kind: 'error', reason: 'redirect-loop' };
};
