import { isAuthorized } from './auth.ts';
import type { BearerCheck } from './auth.ts';

export type RequestGuardOptions = {
  // Exact serialized origins only — no wildcard. An empty set means every
  // PRESENT Origin is rejected (the posture for a non-browser-facing server).
  allowedOrigins: ReadonlySet<string>;
  // Exact match including port (e.g. "127.0.0.1:3044") — deliberately NOT
  // using the SDK transport's deprecated allowedHosts (which has its own
  // port-comparison quirks); this guard is the single source of truth and
  // runs before the SDK transport ever sees the request.
  allowedHost: string;
  bearer: BearerCheck;
};

export type IncomingHeaders = {
  host: string | string[] | undefined;
  origin: string | string[] | undefined;
  authorization: string | string[] | undefined;
};

export type GuardDecision =
  | { outcome: 'allow' }
  | { outcome: 'deny'; status: 403 | 401; reason: string };

// A single header value, or undefined if absent OR duplicated. Node exposes a
// repeated header as an array for some header names; a genuinely-repeated
// Host/Origin is itself suspicious (a client should never send either twice),
// so it collapses to "absent" here and is handled by the SAME fail-closed
// path as a missing header — never silently picking the first/last value.
const singleHeader = (value: string | string[] | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined;
  }
  return value;
};

export const evaluateRequest = (
  opts: RequestGuardOptions,
  headers: IncomingHeaders,
): GuardDecision => {
  const host = singleHeader(headers.host);
  const origin = singleHeader(headers.origin);

  // Host MUST match exactly (including port) or 403 — before the bearer.
  if (host === undefined || host !== opts.allowedHost) {
    return { outcome: 'deny', status: 403, reason: 'invalid or missing Host header' };
  }
  // A PRESENT Origin (including the literal string "null", which browsers
  // send for sandboxed/file-origin requests, and a duplicated header, which
  // singleHeader already turned into `undefined` while `headers.origin`
  // itself remains defined) must be exactly allowlisted, or 403 — checked
  // before the bearer, regardless of how good the bearer is.
  const originHeaderPresent = headers.origin !== undefined;
  if (originHeaderPresent && (origin === undefined || !opts.allowedOrigins.has(origin))) {
    return { outcome: 'deny', status: 403, reason: 'Origin not allowlisted' };
  }
  // Absent-or-allowed Origin: NOW check the bearer. Normalized here, not at
  // the top, as defense-in-depth — nothing touches headers.authorization
  // until Host and Origin have both already passed their 403 checks.
  const authorization = singleHeader(headers.authorization);
  if (!isAuthorized(opts.bearer, authorization)) {
    return { outcome: 'deny', status: 401, reason: 'missing or invalid bearer token' };
  }
  return { outcome: 'allow' };
};
