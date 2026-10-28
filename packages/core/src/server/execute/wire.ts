import { isIP } from 'node:net';
import type { HopHeaders } from '../../http/pinned-dispatcher.ts';
import type { ExecutorConfig } from './executor.ts';
import type { OutboundBudgets } from './request.ts';

// The wire-level guards of an upstream request (issue #78): the cleartext
// gate, the base-URL join and its boundary, the header sets, and the final
// budgets. Shared by the executor and `call --dry-run` through prepare.ts.

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;

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
export const cleartextBlocked = (config: ExecutorConfig, base: URL): boolean =>
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
export const joinFinalUrl = (base: URL, pathname: string, query: string): URL | undefined => {
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
export const withinBasePath = (finalPath: string, basePath: string): boolean =>
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
export const assembleHeaders = (
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
export const overFinalBudget = (
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
