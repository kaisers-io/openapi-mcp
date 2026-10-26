import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createPinnedAgentPool } from '../../http/agent-pool.ts';
import { pinnedRequest } from '../../http/pinned-dispatcher.ts';
import type {
  HopHeaders,
  PinnedDeps,
  PinnedErrorReason,
  PinnedOutcome,
  PinnedRequestOptions,
} from '../../http/pinned-dispatcher.ts';
import type { Redactor } from '../../redact.ts';
import { DISPLAY_TEXT_MAX, sanitizeSpecText } from '../../spec/sanitize.ts';
import type { ToolExecutor } from '../dispatch.ts';
import {
  isSafeMethod,
  rememberEffect,
  withEffect,
  withEffectWarning,
  withMetaEntry,
} from '../effect.ts';
import type { CallEffect } from '../effect.ts';
import { retryableErrorOutcome, textOutcome } from '../result.ts';
import type { ToolCallOutcome } from '../result.ts';
import { DEFAULT_RESPONSE_IS_ERROR_FLAG } from '../../toolgen/output-schema.ts';
import type { CallOutcomeKind, CallTelemetry } from '../telemetry.ts';
import type { TraceContext } from '../trace.ts';
import type { SnapshotTool } from '../types.ts';
import { buildRequest } from './request.ts';
import type { OutboundBudgets } from './request.ts';
import { hopAuthorizer } from './hop-authorizer.ts';
import { routeKey } from './route-table.ts';
import type { RouteTable } from './route-table.ts';
import { mapResponse, mismatchOf } from './response.ts';
import { imageOutcome, isImageResponse } from './image-result.ts';
import { decorateResponseOutcome } from './forwarded-headers.ts';
import { resolveUploads } from './uploads.ts';
import type { Uploads } from './uploads.ts';
import type { ImageResponses } from './image-result.ts';
import type { EnvelopeValidator, EnvelopeValidators } from './envelope-validators.ts';
import type { PageInput } from './forwarded-headers.ts';
import { NO_NEXT_PAGE, nextPageHint } from '../../toolgen/pagination.ts';
import { PROJECTION_FIELD } from '../../toolgen/projection.ts';
import type { PaginationPlan } from '../../toolgen/pagination.ts';
import {
  isRetryableMethod,
  MAX_RETRIES,
  realSleep,
  retriesConnectionErrors,
  withRetries,
} from './retry.ts';
import type { RetryDeps } from './retry.ts';
import { createSlotQueue } from './slots.ts';

// The integration point wiring request-building, the pinned transport,
// response-mapping, redaction, and a global outbound-concurrency semaphore
// into a real ToolExecutor. Every guard here is defense in depth, not the
// FIRST line of defense — toolgen/layout.ts already drops reserved header
// names and dangerous path segments at build time, and buildRequest already
// budgets its own components — but this module is the last place before a
// byte leaves the process, so it re-checks fail-closed rather than trusting
// an earlier stage never regresses.

export type ExecutorConfig = {
  // Resolved+validated final base (resolved from --base-url or serverUrl).
  baseUrl: string;
  // True iff from --base-url.
  baseTrusted: boolean;
  // Every operation of the spec with its exposure decision (issue #40): each
  // hop of a request must resolve to an exposed operation, hop 0 to the
  // tool's own. Absent only for callers that build tools without a spec
  // inventory; `serve` always sets it.
  routes?: RouteTable;
  // --allow-offsite-redirects: follow a redirect off the API base URL
  allowOffsiteRedirects?: boolean;
  allowPrivateNetwork: boolean;
  allowInsecureHttp: boolean;
  secretHeaders: { name: string; value: string; envVar: string }[];
  staticHeaders: { name: string; value: string }[];
  reservedHeaderNames: ReadonlySet<string>;
  redactor: Redactor;
  timeoutMs: number;
  maxResponseBytes: number;
  outboundBudgets: OutboundBudgets;
  // Global outbound-concurrency cap (default 16).
  maxConcurrent: number;
  // Calls allowed to WAIT for a slot once maxConcurrent are in flight
  // (default 4 x maxConcurrent); a call beyond that is refused at once.
  maxQueued?: number;
  // Extra attempts for a transient failure of a retry-safe request
  // (--retries; default 0 = never retry; see retry.ts).
  retries?: number;
  // Forward a call's validated W3C trace context (from `_meta`) upstream as
  // traceparent/tracestate headers, same-origin hops only. Off unless set
  // (serve turns it on; --no-trace-propagation turns it off).
  propagateTraceContext?: boolean;
  // By tool name: a Map compiled at server startup, or
  // lazyEnvelopeValidators, which compiles on a tool's first call. This
  // module only looks a tool up per call, before anything is sent.
  validators: EnvelopeValidators;
  // OAuth2 client-credentials (--upstream-oauth-*): every call carries
  // `Authorization: Bearer <token>` from this source, and an upstream 401
  // invalidates the token and replays the request ONCE with a fresh one.
  // `envVarHint` names the client id/secret env vars for error hints.
  // `tokens` is structurally http/oauth-client-credentials.ts's TokenSource
  // (spelled out here to keep this module's dependency set unchanged).
  // --image-responses (#14): an upstream image becomes an MCP image block or
  // a saved file. Absent means off: an image is an unsupported media type.
  images?: ImageResponses;
  // --uploads (#29): a binary field may name a file in this folder
  uploads?: Uploads;
  // `--log json` (issue #24): a refused response also says why, in the
  // call log only
  diagnoseMismatches?: boolean;
  oauth?: {
    tokens: {
      getToken: () => Promise<{ ok: string } | { error: string }>;
      invalidate: (token: string) => boolean;
    };
    envVarHint: string;
  };
};

export type ExecutorDeps = {
  // { fetch, resolve, timeoutSignal } — the narrow project-owned interface.
  transport: PinnedDeps;
  // Retry clock/sleep/jitter, injectable for tests.
  retry?: Partial<RetryDeps>;
  // Clock (ms) used to charge the queue wait against the call's time
  // budget and to time the queue; defaults to the retry clock.
  now?: () => number;
};

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// A single, stable, redacted prefix for every failure this module produces —
// never the underlying detail, which could carry a hostname, header name, or
// library-internal message never meant for a tool-call response.
const isError = (message: string): ToolCallOutcome =>
  textOutcome(`tool execution failed: ${message}`, true);

// The observability outcome for a call that reached the transport.
const PINNED_OUTCOME: Readonly<Record<PinnedErrorReason, CallOutcomeKind>> = {
  timeout: 'timeout',
  cancelled: 'cancelled',
  egress: 'egress_denied',
  network: 'network_error',
  'too-large': 'response_error',
  'redirect-loop': 'response_error',
  'redirect-write-method': 'response_error',
  'redirect-invalid': 'response_error',
  'route-refused': 'refused',
  'route-overlap': 'refused',
  'redirect-refused': 'response_error',
  'redirect-offsite': 'response_error',
};

// What the final outcome of a sent call says about its effect (issue #25).
// Only a first-hop refusal proves nothing was sent, and only a single
// attempt makes a 4xx a rejection of the whole call; a 2xx was applied at
// least once.
const effectAfterSend = (outcome: PinnedOutcome, attempts: number): CallEffect => {
  if (outcome.kind === 'error') {
    return outcome.notSent === true && attempts === 1 ? 'not_sent' : 'outcome_unknown';
  }
  // A status speaks for the call only when it answers its one request:
  // after a redirect it answers the follow-up (`POST` → 303 → `GET`), and
  // after a retry an earlier attempt may have been applied
  if (attempts > 1 || outcome.redirected === true) {
    return 'outcome_unknown';
  }
  if (outcome.status >= 200 && outcome.status < 300) {
    return 'upstream_reported_success';
  }
  return outcome.status >= 400 && outcome.status < 500 ? 'upstream_rejected' : 'outcome_unknown';
};

const classifyUpstream = (outcome: PinnedOutcome, mapped: ToolCallOutcome): CallOutcomeKind => {
  if (outcome.kind === 'error') {
    return PINNED_OUTCOME[outcome.reason];
  }
  if (outcome.status >= 300) {
    return 'http_error';
  }
  return mapped.isError ? 'response_error' : 'ok';
};

// An overloaded executor cannot know when a slot frees up (that depends on
// upstream latency), so the refusal suggests a short, fixed back-off.
export const OVERLOADED_RETRY_AFTER_MS = 1000;

const overloaded = (message: string): ToolCallOutcome =>
  withEffect(
    retryableErrorOutcome(`tool execution failed: ${message}`, {
      error: 'overloaded',
      retryAfterMs: OVERLOADED_RETRY_AFTER_MS,
    }),
    'not_sent',
  );

// A refusal before anything was sent (issue #25)
const unsent = (message: string): ToolCallOutcome => withEffect(isError(message), 'not_sent');

// URL.hostname keeps brackets around an IPv6 literal; strip them before
// classifying (mirrors egress.ts's/pinned-dispatcher.ts's own hostnameOf).
const stripBrackets = (hostname: string): string =>
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

// The cleartext gate's own narrow "loopback" test: 'localhost'/'*.localhost',
// an IPv4 127.0.0.0/8 literal, or the IPv6 loopback ::1. Deliberately
// independent of egress.ts's broader classifyAddress ('private' also covers
// RFC1918/link-local/etc., which must NOT exempt an operator from the
// cleartext-secret warning — only genuine loopback does).
const isLoopbackHost = (hostname: string): boolean => {
  const bare = stripBrackets(hostname).toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    return true;
  }
  if (isIP(bare) === 4) {
    return bare.startsWith('127.');
  }
  return isIP(bare) === 6 && bare === '::1';
};

// CLEARTEXT gate, mandatory: a secret header sent in the clear over a
// non-loopback http: origin is a credential-leak footgun — refuse the call
// entirely (no request is ever sent) unless the operator explicitly opted in
// via --allow-insecure-http.
const cleartextBlocked = (config: ExecutorConfig, base: URL): boolean =>
  (config.secretHeaders.length > 0 || config.oauth !== undefined) &&
  base.protocol === 'http:' &&
  !config.allowInsecureHttp &&
  !isLoopbackHost(base.hostname);

// Explicit path-join (never `new URL(relativePath, base)`, which resolves
// `..`/`.`-style segments against the base's own directory and can escape
// it): strip exactly one trailing slash off the base pathname, concatenate
// the built pathname verbatim, then parse the assembled ABSOLUTE string.
// `joinFinalUrl` never throws; a malformed result is caught by the
// origin/boundary assertion in `runUpstreamCall` below.
const joinFinalUrl = (base: URL, pathname: string, query: string): URL | undefined => {
  const normalizedBase = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  const finalPathAndQuery = `${normalizedBase}${pathname}${query === '' ? '' : `?${query}`}`;
  try {
    return new URL(`${base.origin}${finalPathAndQuery}`);
  } catch {
    return undefined;
  }
};

// SEGMENT-BOUNDARY check on the final URL assertion: a bare
// `startsWith(basePath)` would admit `/api-evil` under base `/api` — the
// escaped path must land exactly ON the base path or continue at a `/`
// boundary.
const withinBasePath = (finalPath: string, basePath: string): boolean =>
  finalPath === basePath ||
  finalPath.startsWith(basePath.endsWith('/') ? basePath : `${basePath}/`);

// Assembles the two HopHeaders sets pinnedRequest needs: same-origin carries
// the derived accept + content-type (only when a body is sent) + every
// operator-configured static/secret header + whatever headers the tool's own
// arguments mapped to; cross-origin carries only accept and content-type —
// the minimal safe set for a
// redirect that has left the base origin (pinnedRequest itself enforces the
// monotonic origin-crossing switch; this module only supplies the two sets).
// Write order fixes precedence on a name collision (later write wins):
// accept/content-type/tool-arg headers FIRST, then --header, then
// --header-env LAST — derived < tool < --header < --header-env. Unreachable while the
// reserved-name gate in runUpstreamCall holds (a tool argument can never map
// onto a reserved name), but this ordering makes the fallback correct rather
// than inverted should that gate ever regress.
const assembleHeaders = (
  config: ExecutorConfig,
  accept: string,
  contentType: string | undefined,
  toolHeaders: Readonly<Record<string, string>>,
  bearer: string | undefined,
): HopHeaders => {
  // Kept as sequential bracket assignments (not a spread build): the write
  // ORDER is the precedence contract, and bracket assignment on a plain
  // object routes a header literally named "__proto__" through the
  // prototype setter — silently dropping it — while a spread/fromEntries
  // build would create it as an own property and change what goes on the
  // wire. Preserving that exact key semantics matters more here than the
  // functional shape.
  // Accept is written FIRST, so an operator's --header Accept:... wins; a
  // tool argument can never reach it (`accept` is a reserved name).
  const sameOriginHeaders: Record<string, string> = { accept };
  if (contentType !== undefined) {
    sameOriginHeaders['content-type'] = contentType;
  }
  for (const [name, value] of Object.entries(toolHeaders)) {
    sameOriginHeaders[name] = value;
  }
  for (const header of config.staticHeaders) {
    sameOriginHeaders[header.name.toLowerCase()] = header.value;
  }
  for (const header of config.secretHeaders) {
    sameOriginHeaders[header.name.toLowerCase()] = header.value;
  }
  // The OAuth2 access token, last of all. --header-env Authorization is a
  // startup usage error alongside --upstream-oauth-*, so nothing is overwritten.
  if (bearer !== undefined) {
    sameOriginHeaders['authorization'] = `Bearer ${bearer}`;
  }
  // Accept is content negotiation, not a credential: it survives a
  // cross-origin redirect (as browsers keep it too).
  const crossOriginHeaders: Record<string, string> =
    contentType === undefined ? { accept } : { accept, 'content-type': contentType };
  return { sameOriginHeaders, crossOriginHeaders };
};

// FINAL outbound budgets, re-checked AFTER the base-URL join and the full
// header assembly: buildRequest only budgets the relative pathname/query
// and the tool-argument headers it itself produced —
// it cannot see the base URL or the operator's static/secret headers. This
// is the one place that sees the whole wire request.
const overFinalBudget = (
  finalUrl: URL,
  sameOriginHeaders: Readonly<Record<string, string>>,
  budgets: OutboundBudgets,
): boolean => {
  if (finalUrl.href.length > budgets.maxUrlLength) {
    return true;
  }
  // Loop body is a pure sum expression over an already-assembled, bounded
  // header record — a single-expression `reduce` rewrite.
  const headerBytes = Object.entries(sameOriginHeaders).reduce(
    (sum, [name, value]) => sum + byteLength(name) + byteLength(value),
    0,
  );
  return headerBytes > budgets.maxHeaderBytes;
};

// The executor's ToolExecutor plus the lifecycle of the pooled upstream
// connections it owns: `close()` must run on server shutdown so no pooled
// socket keeps the process alive.
export type UpstreamExecutor = ToolExecutor & { close: () => Promise<void> };

// One caller's wait for an OAuth2 token, raced against that caller's
// cancellation and the rest of its time budget (issue #21). The token request
// is shared by every waiting caller and bounded by its own timeout, so it is
// never aborted here: an abandoned wait only stops listening, and the token
// still reaches the callers that keep waiting. A caller that is already
// cancelled or out of time asks for no token at all. Promise.race subscribes
// to the request, so a request that settles (or fails) after its waiter left
// never goes unhandled.
const waitForToken = async <Result>(
  request: () => Promise<Result>,
  signal: AbortSignal,
  deadline: AbortSignal,
): Promise<Result | 'cancelled' | 'timeout'> => {
  if (signal.aborted) {
    return 'cancelled';
  }
  if (deadline.aborted) {
    return 'timeout';
  }
  const pending = request();
  const stopped = Promise.withResolvers<'cancelled' | 'timeout'>();
  const onCancel = (): void => {
    stopped.resolve('cancelled');
  };
  const onDeadline = (): void => {
    stopped.resolve('timeout');
  };
  signal.addEventListener('abort', onCancel, { once: true });
  deadline.addEventListener('abort', onDeadline, { once: true });
  try {
    return await Promise.race([pending, stopped.promise]);
  } finally {
    signal.removeEventListener('abort', onCancel);
    deadline.removeEventListener('abort', onDeadline);
  }
};

const runUpstreamCall = async (
  config: ExecutorConfig,
  transport: PinnedDeps,
  retryDeps: RetryDeps,
  tool: SnapshotTool,
  args: unknown,
  signal: AbortSignal,
  trace: TraceContext | undefined,
  report: (telemetry: CallTelemetry) => void,
  // What is left of the call's time budget after any queue wait.
  timeoutMs: number,
): Promise<ToolCallOutcome> => {
  const { generated } = tool;
  if (generated === undefined) {
    // The dispatcher routes a meta-kind tool to metaExecutor, never here —
    // defensive, unreachable in the real wiring (the caller constructs
    // exactly one createExecutor and passes it only as the upstream
    // ToolExecutor).
    report({ outcome: 'internal_error' });
    return unsent('this tool has no upstream operation to execute');
  }
  // Validators FAIL-CLOSED, mandatory: a missing map entry is a wiring bug
  // (the caller must build one entry per upstream tool, `undefined` for a
  // genuine no-outputSchema tool) — never fall through to a silent
  // unvalidated text path.
  if (!config.validators.has(tool.name)) {
    report({ outcome: 'internal_error' });
    return unsent('no response validator is registered for this tool');
  }
  // A validator compiled on demand can fail here. That happens before the
  // request is built, so a refused schema never follows a sent write. The
  // cause is the operator's to read (lazyEnvelopeValidators reports it);
  // the caller gets fixed text.
  let validator: EnvelopeValidator | undefined;
  try {
    validator = config.validators.get(tool.name);
  } catch {
    report({ outcome: 'internal_error' });
    return unsent(
      "this tool's output schema could not be compiled, so its response cannot be validated; the request was not sent",
    );
  }
  // Imperative on purpose (security-module rule: no control-flow
  // restructuring / helper extraction across a guard boundary here):
  // `new URL` can throw synchronously on a malformed string, and the catch
  // branch below returns early — extracting this into a helper that returns
  // a tagged result would move the try/catch across this function's own
  // early-return boundary for no provable benefit.
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    // Defensive: baseUrl is resolved and validated before this point.
    report({ outcome: 'internal_error' });
    return unsent('the configured base URL is invalid');
  }
  if (cleartextBlocked(config, base)) {
    // Operator policy, not a bad argument: counted as `refused`.
    report({
      outcome: 'refused',
      method: generated.operation.method.toUpperCase(),
      pathTemplate: generated.operation.path,
    });
    return unsent(
      'refusing to send a secret header in cleartext over a non-loopback http:// origin (pass --allow-insecure-http to override)',
    );
  }
  const method = generated.operation.method.toUpperCase();
  const given = isRecord(args) ? args : {};
  // A named upload is read before anything is sent; a refusal sends nothing.
  // Reading it counts against the call's time budget, so a slow disk cannot
  // send a request after the deadline (review of #58).
  const uploadStarted = retryDeps.now();
  const uploaded =
    config.uploads === undefined
      ? { ok: given }
      : await resolveUploads(given, generated.mapper, config.uploads);
  if ('error' in uploaded) {
    report({ outcome: 'validation_error' });
    return unsent(sanitizeSpecText(uploaded.error, DISPLAY_TEXT_MAX));
  }
  // What is left of the budget; the check before sending refuses at zero
  const callTimeoutMs = timeoutMs - (retryDeps.now() - uploadStarted);
  const data = uploaded.ok;
  const built = buildRequest(
    generated.mapper,
    method,
    generated.operation.path,
    data,
    config.outboundBudgets,
  );
  if ('error' in built) {
    // `buildRequest`'s `{error}` strings embed spec-derived text verbatim
    // (e.g. `mapping.wireName`, a hostile spec's own param name) — see
    // request.ts's own comment on wireName being untrusted text. The
    // dispatcher's finalizeOutcome redacts SECRETS but never strips
    // control/bidi characters, so a spec field named with e.g. an RLO
    // (U+202E) would otherwise echo raw in this outcome's text. This is the
    // single choke point where every buildRequest error becomes a tool
    // outcome, so sanitizeSpecText here (the untrusted-text rule) covers
    // every wireName-bearing message from this module in one place.
    return unsent(sanitizeSpecText(built.error, DISPLAY_TEXT_MAX));
  }
  // DEFENSIVE reserved-name check, mandatory rather than merely defensive in
  // effect: toolgen/layout.ts already drops any reserved header name from a
  // tool's input schema at build time, so this is unreachable through the
  // real pipeline — but it is re-checked here fail-closed rather than ever
  // trusting that upstream guard silently. HTTP header names are
  // case-insensitive, so the comparison lowercases the built name itself:
  // today this is correct even without the `.toLowerCase()` because
  // buildRequest already lowercases built header keys and resolveApiConfig
  // already lowercases reservedHeaderNames — but this is the mandatory
  // auth-collision gate and must not depend on those unstated upstream
  // invariants for a security guard.
  for (const name of Object.keys(built.ok.headers)) {
    if (config.reservedHeaderNames.has(name.toLowerCase())) {
      return unsent('a tool argument collided with a reserved header name');
    }
  }
  const finalUrl = joinFinalUrl(base, built.ok.pathname, built.ok.query);
  if (finalUrl === undefined) {
    return unsent('the final request URL could not be constructed');
  }
  if (finalUrl.origin !== base.origin || !withinBasePath(finalUrl.pathname, base.pathname)) {
    return unsent('the final request URL escaped the configured base URL');
  }
  const authorizeHop =
    config.routes === undefined
      ? undefined
      : hopAuthorizer(
          config.routes,
          base,
          routeKey(method, generated.operation.path),
          config.allowOffsiteRedirects === true,
        );
  const { accept } = generated;
  const retries = Math.min(config.retries ?? 0, MAX_RETRIES);
  const idempotencyKeyField = Object.values(generated.mapper.fields).some(
    (mapping) =>
      mapping.destination === 'header' && mapping.wireName.toLowerCase() === 'idempotency-key',
  );
  const keyed = retries > 0 && idempotencyKeyField && (method === 'POST' || method === 'PATCH');
  // ONE key per tool call, identical on every attempt (a 401 token replay
  // included) — the caller's own value when it passed one, else this fresh
  // UUID — so the upstream can deduplicate a retried write.
  const generatedKey = keyed ? randomUUID() : undefined;
  // The wire headers for one send with the given bearer token (none without
  // --upstream-oauth-*), or undefined when they exceed the final budgets —
  // re-checked per send, since a refreshed token can differ in length.
  const headersFor = (bearer: string | undefined): HopHeaders | undefined => {
    const headers = assembleHeaders(config, accept, built.ok.contentType, built.ok.headers, bearer);
    if (config.propagateTraceContext === true && trace !== undefined) {
      // Same-origin set only: a trace id is client correlation data, and a
      // redirect to a foreign origin must not receive it. `traceparent` and
      // `tracestate` are reserved tool-header names, so only an operator's
      // own --header could already hold them — and that one wins.
      for (const [name, value] of Object.entries(trace)) {
        headers.sameOriginHeaders[name] ??= value;
      }
    }
    if (generatedKey !== undefined) {
      headers.sameOriginHeaders['idempotency-key'] ??= generatedKey;
    }
    return overFinalBudget(finalUrl, headers.sameOriginHeaders, config.outboundBudgets)
      ? undefined
      : headers;
  };
  const operationFacts = { method, pathTemplate: generated.operation.path };
  // `sentAttempts`: the attempts already sent when an exit follows a 401 (the
  // replay path), so the report counts them; undefined before any send.
  const factsAfter = (sentAttempts?: number) =>
    sentAttempts === undefined ? operationFacts : { ...operationFacts, attempts: sentAttempts };
  const overBudget = (sentAttempts?: number): ToolCallOutcome => {
    report({ outcome: 'refused', ...factsAfter(sentAttempts) });
    return unsent('the final request exceeds the outbound resource budget');
  };
  const { oauth } = config;
  // A token failure is a tool error naming the env vars to check; its text
  // never carries endpoint-supplied prose (see oauth-client-credentials.ts).
  // For the first token no API request was sent; for a refresh after a 401
  // it was, and was not sent again.
  const tokenError = (error: string, sentAttempts?: number): ToolCallOutcome => {
    report({ outcome: 'token_error', ...factsAfter(sentAttempts) });
    return unsent(`${error} (check the ${oauth?.envVarHint ?? ''} environment variables)`);
  };
  // The call's time budget runs from here: the token request (when one is
  // needed) and every upstream attempt share it.
  const upstreamStarted = retryDeps.now();
  const budgetLeftMs = (): number =>
    Math.floor(callTimeoutMs - (retryDeps.now() - upstreamStarted));
  const remainingMs = (): number => Math.max(budgetLeftMs(), 1);
  // A token for this call, or the tool error that ends it. A cancelled or
  // expired wait sends nothing more. For the first token nothing was sent
  // at all; for a refresh after a 401 the request WAS sent before (with
  // --retries possibly more than once, an earlier attempt may have been
  // applied), so the text only says it was not sent again.
  const tokenFor = async (
    tokens: NonNullable<ExecutorConfig['oauth']>['tokens'],
    // Undefined for the first token; for a refresh, the attempts already sent
    sentAttempts?: number,
  ): Promise<{ token: string } | { failed: ToolCallOutcome }> => {
    const refresh = sentAttempts !== undefined;
    const facts = factsAfter(sentAttempts);
    const result = await waitForToken(
      async () => await tokens.getToken(),
      signal,
      transport.timeoutSignal(remainingMs()),
    );
    if (result === 'cancelled') {
      report({ outcome: 'cancelled', ...facts });
      return {
        failed: isError(
          refresh
            ? 'the request was cancelled while waiting for a fresh OAuth2 access token; it was not sent again'
            : 'the request was cancelled',
        ),
      };
    }
    if (result === 'timeout') {
      report({ outcome: 'timeout', ...facts });
      return {
        failed: isError(
          refresh
            ? 'timed out waiting for a fresh OAuth2 access token; the request was not sent again'
            : 'timed out waiting for an OAuth2 access token; no API request was sent',
        ),
      };
    }
    return 'error' in result
      ? { failed: tokenError(result.error, sentAttempts) }
      : { token: result.ok };
  };
  const send = async (
    headers: HopHeaders,
    retriesLeft: number,
  ): Promise<{ outcome: PinnedOutcome; attempts: number }> => {
    const requestOptions: PinnedRequestOptions = {
      method,
      headers,
      ...(built.ok.body === undefined ? {} : { body: built.ok.body }),
      baseTrusted: config.baseTrusted,
      ...(authorizeHop === undefined ? {} : { authorizeHop }),
      allowPrivateNetwork: config.allowPrivateNetwork,
      timeoutMs: callTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      signal,
    };
    return await withRetries(
      (attemptMs) =>
        pinnedRequest(finalUrl, { ...requestOptions, timeoutMs: attemptMs }, transport),
      {
        retries: retriesLeft,
        timeoutMs: remainingMs(),
        connectionErrors: retriesConnectionErrors(method),
        signal,
      },
      retryDeps,
    );
  };
  const first = oauth === undefined ? undefined : await tokenFor(oauth.tokens);
  if (first !== undefined && 'failed' in first) {
    return withEffect(first.failed, 'not_sent');
  }
  const firstHeaders = headersFor(first?.token);
  if (firstHeaders === undefined) {
    return withEffect(overBudget(), 'not_sent');
  }
  // A token that arrived just as the budget ran out
  if (budgetLeftMs() <= 0) {
    report({ outcome: 'timeout', ...operationFacts });
    return unsent('the call timed out before the request was sent');
  }
  const idempotencyKey =
    generatedKey === undefined ? undefined : firstHeaders.sameOriginHeaders['idempotency-key'];
  // The key the write was sent with, so a caller whose call still failed
  // (e.g. a timeout after a retry) can repeat it with the SAME key and let
  // the upstream deduplicate, instead of a fresh call getting a new key.
  const withRecoveryKey = (result: ToolCallOutcome): ToolCallOutcome =>
    idempotencyKey === undefined
      ? result
      : withMetaEntry(result, 'openapi-mcp/idempotencyKey', idempotencyKey);
  // Every exit from here on follows a sent attempt: a failure records what
  // the evidence says about its effect, and warns before a blind retry of a
  // write (issue #25)
  // The warning is added last, so the outcome returned is the one marked as
  // warned (a later boundary step that replaces its text keeps the warning)
  // A success records its effect only internally, for a boundary that may
  // still withhold it (a 2xx after a redirect or a retry is no proof)
  const finish = (result: ToolCallOutcome, effect: CallEffect): ToolCallOutcome =>
    result.isError
      ? withEffectWarning(withRecoveryKey(result), effect, method)
      : rememberEffect(withRecoveryKey(result), effect);
  const allowedRetries = isRetryableMethod(method, idempotencyKeyField) ? retries : 0;
  const sent = await send(firstHeaders, allowedRetries);
  let { outcome, attempts } = sent;
  // The attempts that speak for the call's effect: a lone first 401 had
  // none, so after its replay only the replay's attempts count
  let effectAttempts = attempts;
  let replayed = false;
  // At most one replay on 401: the request was not authorized, so it had no
  // effect — replaying it once (writes included) with a fresh token is safe.
  // No replay when the token source keeps the token (it was minted moments
  // ago, so a new one would be rejected the same way). A second 401 is
  // returned like any other.
  // The replay and --retries are separate budgets: a 401 is never a
  // transient failure, so withRetries never re-sends one; retries spent on
  // transient failures before the 401 do not prevent the replay, and the
  // replay does not use up a retry (it gets the ones the first send left).
  if (
    oauth !== undefined &&
    first !== undefined &&
    outcome.kind === 'response' &&
    outcome.status === 401 &&
    // A 401 after a redirect answers the follow-up, not the request itself,
    // which may have been applied: a write is never replayed then (issue
    // #25). A read is, as before: replaying it changes nothing
    (outcome.redirected !== true || isSafeMethod(method)) &&
    oauth.tokens.invalidate(first.token)
  ) {
    // Every exit from here on follows at least one sent attempt. The 401
    // itself had no effect, but with --retries an earlier attempt may have
    // failed ambiguously and still been applied, so each exit keeps the
    // idempotency key a repeated call needs (see the end of this function).
    // The 401 had no effect; an earlier retried attempt may have had one
    const unreplayed: CallEffect = attempts > 1 ? 'outcome_unknown' : 'upstream_rejected';
    const fresh = await tokenFor(oauth.tokens, attempts);
    if ('failed' in fresh) {
      return finish(fresh.failed, unreplayed);
    }
    // A spent budget sends no replay: the clamp in remainingMs would
    // otherwise still grant it a millisecond.
    if (budgetLeftMs() <= 0) {
      report({ outcome: 'timeout', ...operationFacts, attempts });
      return finish(
        isError(
          'the call timed out before the request could be sent again with a fresh OAuth2 access token',
        ),
        unreplayed,
      );
    }
    const replayHeaders = headersFor(fresh.token);
    if (replayHeaders === undefined) {
      return finish(overBudget(attempts), unreplayed);
    }
    const replay = await send(replayHeaders, Math.max(allowedRetries - (attempts - 1), 0));
    ({ outcome } = replay);
    effectAttempts = attempts > 1 ? attempts + replay.attempts : replay.attempts;
    replayed = true;
    attempts += replay.attempts;
  }
  const upstreamMs = Math.max(0, retryDeps.now() - upstreamStarted);
  const [firstSecretHeader] = config.secretHeaders;
  const envVarHint = oauth?.envVarHint ?? firstSecretHeader?.envVar;
  const mapRest = (): ToolCallOutcome =>
    mapResponse({
      outcome,
      validator,
      outputSchema: tool.wireTool.outputSchema,
      redactor: config.redactor,
      ...(envVarHint === undefined ? {} : { envVarHint }),
      ...(tool.generated?.outputSchemaAssumesDefaultIsError === true
        ? { undeclaredSuccessHint: DEFAULT_RESPONSE_IS_ERROR_FLAG }
        : {}),
      maxTextBytes: DISPLAY_TEXT_MAX,
      baseUrl: config.baseUrl,
      // `_fields` was validated by the tool's input schema (toolgen/projection.ts)
      // and is never mapped onto the request (buildRequest only reads mapped
      // fields).
      ...(generated.projection === true ? { projectable: true } : {}),
      safeMethod: isSafeMethod(method),
      ...(config.diagnoseMismatches === true ? { diagnose: true } : {}),
      ...(generated.projection === true && Array.isArray(data[PROJECTION_FIELD])
        ? { fields: data[PROJECTION_FIELD] as string[] }
        : {}),
      ...(generated.pagination === undefined
        ? {}
        : {
            paginate: (page: PageInput) => {
              const hint = nextPageHint(generated.pagination as PaginationPlan, {
                ...page,
                requestUrl: finalUrl.href,
                args: data,
              });
              // A hint is only worth giving if the next call can actually be
              // made with it: one the tool's own input schema would reject
              // becomes "no next page known" rather than a dead end.
              return hint.next !== NO_NEXT_PAGE &&
                !generated.inputSchema.safeParse(hint.next).success
                ? { next: NO_NEXT_PAGE }
                : hint;
            },
          }),
    });
  const mapped =
    config.images !== undefined &&
    isImageResponse(outcome, tool.wireTool.outputSchema !== undefined)
      ? decorateResponseOutcome(
          await imageOutcome(outcome, config.images, config.redactor),
          outcome,
          config.baseUrl,
          config.redactor,
          Date.now(),
        )
      : mapRest();
  const mismatch = mismatchOf(mapped);
  report({
    outcome: classifyUpstream(outcome, mapped),
    method,
    pathTemplate: generated.operation.path,
    upstreamMs,
    attempts,
    ...(mismatch === undefined ? {} : { mismatch }),
    ...(outcome.kind === 'response'
      ? { status: outcome.status, responseBytes: outcome.bodyBytes.byteLength }
      : {}),
  });
  const effect = effectAfterSend(outcome, effectAttempts);
  // A replay refused before sending still follows the rejected 401
  return finish(mapped, replayed && effect === 'not_sent' ? 'upstream_rejected' : effect);
};

export const createExecutor = (config: ExecutorConfig, deps: ExecutorDeps): UpstreamExecutor => {
  // A closure-owned admission queue, NOT a module-level singleton: the
  // caller constructs exactly one createExecutor and shares it between the
  // stdio and HTTP transports, so this one queue bounds concurrency across
  // BOTH. Calls past maxConcurrent wait in FIFO order (bounded by maxQueued
  // and by half the call timeout) instead of failing straight away.
  const slots = createSlotQueue(config.maxConcurrent, config.maxQueued ?? 4 * config.maxConcurrent);
  // Long-lived pinned Agents, pooled per (origin, trust policy) for the
  // executor's lifetime, so consecutive calls reuse upstream connections.
  // Per-Agent connections are capped at the same global concurrency limit
  // (more could never be in use at once); a DNS lookup gets the call
  // timeout as its own deadline, since a pooled Agent outlives any one call.
  const agents = createPinnedAgentPool({
    resolve: deps.transport.resolve,
    timeoutSignal: deps.transport.timeoutSignal,
    lookupTimeoutMs: config.timeoutMs,
    connections: config.maxConcurrent,
  });
  const transport: PinnedDeps = { ...deps.transport, agents };
  // One clock for the queue wait, the call budget and the timings: an
  // injected `now` also drives the per-call budget inside runUpstreamCall,
  // unless the retry clock is injected on its own.
  const retryDeps: RetryDeps = {
    sleep: realSleep,
    random: Math.random,
    now: deps.now ?? Date.now,
    ...deps.retry,
  };
  const now = deps.now ?? retryDeps.now;
  // ONE time budget per call, shared by the queue wait and the upstream
  // request, so a queued call cannot take queue wait + a full timeout
  // (~2x the timeout end-to-end, past many hosts' own tools/call limit).
  // The wait is capped at half the budget, so a call that does get a slot
  // still has at least the other half for the upstream request.
  const maxQueueWaitMs = Math.ceil(config.timeoutMs / 2);
  const execute: ToolExecutor = async (tool, args, signal, trace, report) => {
    const queuedAt = now();
    const slot = await slots.acquire(signal, () => deps.transport.timeoutSignal(maxQueueWaitMs));
    const queuedMs = Math.max(0, now() - queuedAt);
    if (slot !== 'acquired') {
      report?.({ outcome: slot === 'cancelled' ? 'cancelled' : 'overloaded', queuedMs });
    }
    // Cancelled while still queued: nothing was sent (issue #25)
    if (slot === 'cancelled') {
      return unsent('the request was cancelled');
    }
    if (slot === 'overloaded') {
      return overloaded('too many upstream requests are already in flight or queued');
    }
    if (slot === 'timeout') {
      return overloaded('timed out waiting for a free upstream request slot');
    }
    // A call stopped by its arguments before any request was sent (argument
    // mapping, a reserved-header collision, a URL that escapes the base)
    // reports nothing itself: it is recorded as a validation error. Policy
    // refusals (cleartext gate, budgets) report `refused`.
    let reported = false;
    const upstreamReport = (telemetry: CallTelemetry): void => {
      reported = true;
      report?.({ ...telemetry, queuedMs });
    };
    try {
      const remainingMs = Math.max(
        Math.floor(config.timeoutMs - Math.min(queuedMs, maxQueueWaitMs)),
        1,
      );
      const outcome = await runUpstreamCall(
        config,
        transport,
        retryDeps,
        tool,
        args,
        signal,
        trace,
        upstreamReport,
        remainingMs,
      );
      if (!reported) {
        report?.({ outcome: outcome.isError ? 'validation_error' : 'ok', queuedMs });
      }
      return outcome;
    } catch {
      // Belt-and-suspenders: the dispatcher also catches, but this module
      // never lets a raw throw (a library-internal message, a stack, a
      // reflected secret) escape its own boundary either.
      report?.({ outcome: 'internal_error', queuedMs });
      return isError('an unexpected error occurred');
    } finally {
      slots.release();
    }
  };
  return Object.assign(execute, { close: agents.close });
};
