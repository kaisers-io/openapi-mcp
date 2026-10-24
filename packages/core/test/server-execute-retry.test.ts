import { describe, expect, it } from 'vitest';
import type { PinnedOutcome } from '../src/http/pinned-dispatcher.ts';
import { isRetryableMethod, realSleep, withRetries } from '../src/server/execute/retry.ts';

const busy: PinnedOutcome = {
  kind: 'response',
  status: 503,
  bodyBytes: new Uint8Array(0),
  headers: {},
  url: 'https://api.example.test/',
};

describe('isRetryableMethod', () => {
  it.each(['GET', 'HEAD', 'PUT', 'DELETE', 'QUERY'])('%s is retry-safe', (method) => {
    expect(isRetryableMethod(method, false)).toBe(true);
  });

  it('POST/PATCH are retry-safe only with an Idempotency-Key', () => {
    expect(isRetryableMethod('POST', false)).toBe(false);
    expect(isRetryableMethod('PATCH', false)).toBe(false);
    expect(isRetryableMethod('POST', true)).toBe(true);
    expect(isRetryableMethod('PATCH', true)).toBe(true);
    expect(isRetryableMethod('OPTIONS', true)).toBe(false);
  });
});

describe('withRetries', () => {
  it('reports a timeout when the deadline passed during the backoff', async () => {
    let clock = 0;
    const attempts: number[] = [];
    const result = await withRetries(
      (remainingMs) => {
        attempts.push(remainingMs);
        return Promise.resolve(busy);
      },
      { retries: 2, timeoutMs: 1000, connectionErrors: true, signal: new AbortController().signal },
      {
        now: () => clock,
        random: () => 0.5,
        sleep: (ms) => {
          // The sleep itself overran (a slow event loop).
          clock += ms + 1000;
          return Promise.resolve();
        },
      },
    );
    expect(result).toEqual({ outcome: { kind: 'error', reason: 'timeout' }, attempts: 1 });
    expect(attempts).toEqual([1000]);
  });

  it('gives every attempt only the time left on the shared deadline', async () => {
    let clock = 0;
    const attempts: number[] = [];
    await withRetries(
      (remainingMs) => {
        attempts.push(remainingMs);
        clock += 100;
        return Promise.resolve(busy);
      },
      { retries: 2, timeoutMs: 1000, connectionErrors: true, signal: new AbortController().signal },
      {
        now: () => clock,
        random: () => 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(attempts).toEqual([1000, 900, 800]);
  });
});

describe('realSleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await realSleep(30, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('resolves early when the signal aborts, and at once when already aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = realSleep(10_000, controller.signal);
    controller.abort();
    await pending;
    await realSleep(10_000, AbortSignal.abort());
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
