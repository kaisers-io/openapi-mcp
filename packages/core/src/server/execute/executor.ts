import { isIP } from 'node:net';
import { createPinnedAgentPool } from '../../http/agent-pool.ts';
import { pinnedRequest } from '../../http/pinned-dispatcher.ts';
import type { HopHeaders, PinnedDeps, PinnedRequestOptions } from '../../http/pinned-dispatcher.ts';
import type { Redactor } from '../../redact.ts';
import { DISPLAY_TEXT_MAX, sanitizeSpecText } from '../../spec/sanitize.ts';
import type { ToolExecutor } from '../dispatch.ts';
import { retryableErrorOutcome, textOutcome } from '../result.ts';
import type { ToolCallOutcome } from '../result.ts';
import type { SnapshotTool } from '../types.ts';
import { deriveAccept } from './accept.ts';
import { buildRequest } from './request.ts';
import type { OutboundBudgets } from './request.ts';
import { mapResponse } from './response.ts';
import type { EnvelopeValidator } from './response.ts';
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
  // By tool name; compiled eagerly once at server startup — this module only
  // looks the map up per call.
  validators: ReadonlyMap<string, EnvelopeValidator | undefined>;
};

export type ExecutorDeps = {
  // { fetch, resolve, timeoutSignal } — the narrow project-owned interface.
  transport: PinnedDeps;
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

// An overloaded executor cannot know when a slot frees up (that depends on
// upstream latency), so the refusal suggests a short, fixed back-off.
export const OVERLOADED_RETRY_AFTER_MS = 1000;

const overloaded = (message: string): ToolCallOutcome =>
  retryableErrorOutcome(`tool execution failed: ${message}`, {
    error: 'overloaded',
    retryAfterMs: OVERLOADED_RETRY_AFTER_MS,
  });

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
  config.secretHeaders.length > 0 &&
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

const runUpstreamCall = async (
  config: ExecutorConfig,
  transport: PinnedDeps,
  tool: SnapshotTool,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolCallOutcome> => {
  const { generated } = tool;
  if (generated === undefined) {
    // The dispatcher routes a meta-kind tool to metaExecutor, never here —
    // defensive, unreachable in the real wiring (the caller constructs
    // exactly one createExecutor and passes it only as the upstream
    // ToolExecutor).
    return isError('this tool has no upstream operation to execute');
  }
  // Validators FAIL-CLOSED, mandatory: a missing map entry is a wiring bug
  // (the caller must build one entry per upstream tool, `undefined` for a
  // genuine no-outputSchema tool) — never fall through to a silent
  // unvalidated text path.
  if (!config.validators.has(tool.name)) {
    return isError('no response validator is registered for this tool');
  }
  const validator = config.validators.get(tool.name);
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
    return isError('the configured base URL is invalid');
  }
  if (cleartextBlocked(config, base)) {
    return isError(
      'refusing to send a secret header in cleartext over a non-loopback http:// origin (pass --allow-insecure-http to override)',
    );
  }
  const method = generated.operation.method.toUpperCase();
  const data = isRecord(args) ? args : {};
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
    return isError(sanitizeSpecText(built.error, DISPLAY_TEXT_MAX));
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
      return isError('a tool argument collided with a reserved header name');
    }
  }
  const finalUrl = joinFinalUrl(base, built.ok.pathname, built.ok.query);
  if (finalUrl === undefined) {
    return isError('the final request URL could not be constructed');
  }
  if (finalUrl.origin !== base.origin || !withinBasePath(finalUrl.pathname, base.pathname)) {
    return isError('the final request URL escaped the configured base URL');
  }
  const headers = assembleHeaders(
    config,
    deriveAccept(generated.operation.responses),
    built.ok.contentType,
    built.ok.headers,
  );
  if (overFinalBudget(finalUrl, headers.sameOriginHeaders, config.outboundBudgets)) {
    return isError('the final request exceeds the outbound resource budget');
  }
  const requestOptions: PinnedRequestOptions = {
    method,
    headers,
    ...(built.ok.body === undefined ? {} : { body: built.ok.body }),
    baseTrusted: config.baseTrusted,
    allowPrivateNetwork: config.allowPrivateNetwork,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    signal,
  };
  const outcome = await pinnedRequest(finalUrl, requestOptions, transport);
  const [firstSecretHeader] = config.secretHeaders;
  return mapResponse({
    outcome,
    validator,
    outputSchema: tool.wireTool.outputSchema,
    redactor: config.redactor,
    ...(firstSecretHeader === undefined ? {} : { envVarHint: firstSecretHeader.envVar }),
    maxTextBytes: DISPLAY_TEXT_MAX,
  });
};

export const createExecutor = (config: ExecutorConfig, deps: ExecutorDeps): UpstreamExecutor => {
  // A closure-owned admission queue, NOT a module-level singleton: the
  // caller constructs exactly one createExecutor and shares it between the
  // stdio and HTTP transports, so this one queue bounds concurrency across
  // BOTH. Calls past maxConcurrent wait in FIFO order (bounded by maxQueued
  // and by the call timeout) instead of failing straight away.
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
  const execute: ToolExecutor = async (tool, args, signal) => {
    const slot = await slots.acquire(signal, () => deps.transport.timeoutSignal(config.timeoutMs));
    if (slot === 'cancelled') {
      return isError('the request was cancelled');
    }
    if (slot === 'overloaded') {
      return overloaded('too many upstream requests are already in flight or queued');
    }
    if (slot === 'timeout') {
      return overloaded('timed out waiting for a free upstream request slot');
    }
    try {
      return await runUpstreamCall(config, transport, tool, args, signal);
    } catch {
      // Belt-and-suspenders: the dispatcher also catches, but this module
      // never lets a raw throw (a library-internal message, a stack, a
      // reflected secret) escape its own boundary either.
      return isError('an unexpected error occurred');
    } finally {
      slots.release();
    }
  };
  return Object.assign(execute, { close: agents.close });
};
