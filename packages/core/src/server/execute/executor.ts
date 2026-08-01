import { isIP } from 'node:net';
import { pinnedRequest } from '../../http/pinned-dispatcher.ts';
import type { HopHeaders, PinnedDeps, PinnedRequestOptions } from '../../http/pinned-dispatcher.ts';
import type { Redactor } from '../../redact.ts';
import { DISPLAY_TEXT_MAX, sanitizeSpecText } from '../../spec/sanitize.ts';
import type { ToolExecutor } from '../dispatch.ts';
import { textOutcome } from '../result.ts';
import type { ToolCallOutcome } from '../result.ts';
import type { SnapshotTool } from '../types.ts';
import { buildRequest } from './request.ts';
import type { OutboundBudgets } from './request.ts';
import { mapResponse } from './response.ts';
import type { EnvelopeValidator } from './response.ts';

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
// content-type (only when a body is sent) + every operator-configured
// static/secret header + whatever headers the tool's own arguments mapped to;
// cross-origin carries only content-type — the minimal safe set for a
// redirect that has left the base origin (pinnedRequest itself enforces the
// monotonic origin-crossing switch; this module only supplies the two sets).
// Write order fixes precedence on a name collision (later write wins):
// content-type/tool-arg headers FIRST, then --header, then --header-env
// LAST — content < tool < --header < --header-env. Unreachable while the
// reserved-name gate in runUpstreamCall holds (a tool argument can never map
// onto a reserved name), but this ordering makes the fallback correct rather
// than inverted should that gate ever regress.
const assembleHeaders = (
  config: ExecutorConfig,
  contentType: string | undefined,
  toolHeaders: Readonly<Record<string, string>>,
): HopHeaders => {
  const sameOriginHeaders: Record<string, string> = {};
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
  const crossOriginHeaders: Record<string, string> =
    contentType === undefined ? {} : { 'content-type': contentType };
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
  let headerBytes = 0;
  for (const [name, value] of Object.entries(sameOriginHeaders)) {
    headerBytes += byteLength(name) + byteLength(value);
  }
  return headerBytes > budgets.maxHeaderBytes;
};

const runUpstreamCall = async (
  config: ExecutorConfig,
  deps: ExecutorDeps,
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
  const headers = assembleHeaders(config, built.ok.contentType, built.ok.headers);
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
  const outcome = await pinnedRequest(finalUrl, requestOptions, deps.transport);
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

export const createExecutor = (config: ExecutorConfig, deps: ExecutorDeps): ToolExecutor => {
  // A closure counter, NOT a module-level singleton: the caller constructs
  // exactly one createExecutor and shares it between the stdio and HTTP
  // transports, so this one counter bounds concurrency across BOTH.
  let inFlight = 0;
  return async (tool, args, signal) => {
    if (inFlight >= config.maxConcurrent) {
      return isError('too many concurrent upstream requests are already in flight');
    }
    inFlight += 1;
    try {
      return await runUpstreamCall(config, deps, tool, args, signal);
    } catch {
      // Belt-and-suspenders: the dispatcher also catches, but this module
      // never lets a raw throw (a library-internal message, a stack, a
      // reflected secret) escape its own boundary either.
      return isError('an unexpected error occurred');
    } finally {
      inFlight -= 1;
    }
  };
};
