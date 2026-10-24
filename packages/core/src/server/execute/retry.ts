import { parseRetryAfter } from '../../http/response-headers.ts';
import type { PinnedOutcome } from '../../http/pinned-dispatcher.ts';

// Optional, opt-in retries (--retries, default 0) for upstream calls that
// are safe to repeat. A retry is attempted only when ALL of these hold:
// - the method is idempotent by HTTP semantics (GET, HEAD, PUT, DELETE —
//   RFC 9110 §9.2.2), or it is a POST/PATCH whose operation declares an
//   `Idempotency-Key` header, which the executor then pins to ONE value
//   for every attempt of the call;
// - the failure is transient: a 429/502/503/504 response, or a network
//   error that happened before any response arrived — except for DELETE:
//   such an error is ambiguous (the upstream may have processed the request
//   and lost the connection while answering), and a retried DELETE would
//   then report 404 for a resource the first attempt removed;
// - the caller has not cancelled, and the backoff still fits inside the
//   call's overall deadline.
// Redirect, egress, size and every other 4xx/5xx outcome are final.
// Backoff is exponential with full jitter; an upstream Retry-After (seconds
// or HTTP-date) on a 429/503 replaces the jittered delay (the statuses for
// which it is reported as upstreamRetryAfterMs too). Every attempt stays inside the
// one concurrency slot and the one rate-limit charge of the tool call.

export const MAX_RETRIES = 3;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
// QUERY is safe and idempotent (RFC 10008 §2)
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'QUERY']);
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5000;

export const isRetryableMethod = (method: string, hasIdempotencyKey: boolean): boolean =>
  IDEMPOTENT_METHODS.has(method) ||
  ((method === 'POST' || method === 'PATCH') && hasIdempotencyKey);

// The statuses whose Retry-After is honoured (RFC 9110 §10.2.3: 503; 429
// per RFC 6585) — the same set forwarded-headers.ts reports.
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([429, 503]);

// Whether a connection error before any response may be retried: never for
// DELETE (see above).
export const retriesConnectionErrors = (method: string): boolean => method !== 'DELETE';

const isTransient = (outcome: PinnedOutcome, connectionErrors: boolean): boolean =>
  outcome.kind === 'response'
    ? RETRYABLE_STATUSES.has(outcome.status)
    : connectionErrors && outcome.reason === 'network' && outcome.beforeResponse === true;

export type RetryDeps = {
  // Resolves after `ms`, or rejects/resolves early when `signal` aborts.
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
  now: () => number;
};

export type RetryOptions = {
  retries: number;
  // The call's overall deadline, shared by every attempt and backoff.
  timeoutMs: number;
  // Whether a network error before any response is retried (not for DELETE).
  connectionErrors: boolean;
  signal: AbortSignal;
};

// The delay before attempt `attempt + 1` (attempt counts from 0): the
// upstream's Retry-After when it sent one, else full jitter over an
// exponentially growing, capped window.
const backoffMs = (outcome: PinnedOutcome, attempt: number, deps: RetryDeps): number => {
  const retryAfter =
    outcome.kind === 'response' &&
    RETRY_AFTER_STATUSES.has(outcome.status) &&
    outcome.headers['retry-after'] !== undefined
      ? parseRetryAfter(outcome.headers['retry-after'], deps.now())
      : undefined;
  if (retryAfter !== undefined) {
    return retryAfter;
  }
  const window = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(deps.random() * window);
};

// Runs `attempt` (one pinned request, given the time left) and retries as
// described above. Returns the last outcome — so a final 503 still reports
// its upstream Retry-After — or a timeout/cancel when the deadline or the
// caller ended the call first.
export const withRetries = async (
  attempt: (remainingMs: number) => Promise<PinnedOutcome>,
  options: RetryOptions,
  deps: RetryDeps,
): Promise<{ outcome: PinnedOutcome; attempts: number }> => {
  const deadline = deps.now() + options.timeoutMs;
  let outcome = await attempt(options.timeoutMs);
  let attempts = 1;
  // Imperative on purpose: each iteration depends on the previous attempt's
  // outcome and on the time it consumed.
  while (attempts <= options.retries && isTransient(outcome, options.connectionErrors)) {
    const delay = backoffMs(outcome, attempts - 1, deps);
    if (deps.now() + delay >= deadline) {
      break;
    }
    try {
      await deps.sleep(delay, options.signal);
    } catch {
      // A sleep rejected by the caller's abort: fall through to the check.
    }
    if (options.signal.aborted) {
      return { outcome: { kind: 'error', reason: 'cancelled' }, attempts };
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      return { outcome: { kind: 'error', reason: 'timeout' }, attempts };
    }
    outcome = await attempt(remaining);
    attempts += 1;
  }
  return { outcome, attempts };
};

export const realSleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) {
    resolve();
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
};
