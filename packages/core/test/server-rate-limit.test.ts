import { describe, expect, it } from 'vitest';
import { createRateLimiter, DEFAULT_RATE_LIMIT } from '../src/index.ts';

describe('createRateLimiter — sliding window', () => {
  it('allows up to maxCalls within the window, then exhausts', () => {
    const limiter = createRateLimiter({ maxCalls: 3, windowMs: 1000 });
    expect(limiter.consume(0)).toBe(true);
    expect(limiter.consume(0)).toBe(true);
    expect(limiter.consume(0)).toBe(true);
    expect(limiter.consume(0)).toBe(false);
  });

  it('refills exactly at the window boundary (nowMs - windowMs strictly excludes an exact-boundary call)', () => {
    const limiter = createRateLimiter({ maxCalls: 1, windowMs: 1000 });
    expect(limiter.consume(0)).toBe(true);
    expect(limiter.consume(999)).toBe(false); // Still inside the 1000ms window
    expect(limiter.consume(1000)).toBe(true); // Exactly windowMs later: the first call has expired
  });

  it('shares exhaustion across calls attributed to different logical sessions (ONE instance is global)', () => {
    const limiter = createRateLimiter({ maxCalls: 2, windowMs: 1000 });
    // Two different "sessions" hitting the SAME limiter instance — the point
    // of a global (not per-session) rate limit.
    expect(limiter.consume(0)).toBe(true); // Session A
    expect(limiter.consume(10)).toBe(true); // Session B
    expect(limiter.consume(20)).toBe(false); // Session A again — the shared budget is spent
  });

  it('exposes a finite default — 120 calls per 60000ms, never "unlimited"', () => {
    expect(DEFAULT_RATE_LIMIT).toEqual({ maxCalls: 120, windowMs: 60_000 });
    expect(Number.isFinite(DEFAULT_RATE_LIMIT.maxCalls)).toBe(true);
  });

  it('rejects a non-finite or non-positive maxCalls/windowMs at construction (fail closed, no "unlimited" escape hatch)', () => {
    expect(() => createRateLimiter({ maxCalls: 0, windowMs: 1000 })).toThrow();
    expect(() =>
      createRateLimiter({ maxCalls: Number.POSITIVE_INFINITY, windowMs: 1000 }),
    ).toThrow();
    expect(() => createRateLimiter({ maxCalls: 10, windowMs: 0 })).toThrow();
    expect(() => createRateLimiter({ maxCalls: 1.5, windowMs: 1000 })).toThrow();
  });

  it('is not bypassable by mutating the options object after construction (the validated values are copied, not re-read)', () => {
    const opts = { maxCalls: 1, windowMs: 1000 };
    const limiter = createRateLimiter(opts);
    expect(limiter.consume(0)).toBe(true);
    expect(limiter.consume(1)).toBe(false); // Exhausted, still inside the window
    // A caller-side mutation AFTER construction — e.g. widening maxCalls to
    // "unlimited" — must not reach back into the already-built limiter.
    (opts as { maxCalls: number }).maxCalls = Number.POSITIVE_INFINITY;
    expect(limiter.consume(2)).toBe(false); // Still exhausted — the mutation had no effect
  });

  it('DEFAULT_RATE_LIMIT is frozen — mutating it is a no-op/throws, never affecting a limiter built from it', () => {
    expect(Object.isFrozen(DEFAULT_RATE_LIMIT)).toBe(true);
    expect(() => {
      (DEFAULT_RATE_LIMIT as { maxCalls: number }).maxCalls = Number.POSITIVE_INFINITY;
    }).toThrow(TypeError);
  });

  it('denies (fails closed) a non-finite nowMs sample instead of corrupting the sliding window', () => {
    const limiter = createRateLimiter({ maxCalls: 5, windowMs: 1000 });
    expect(limiter.consume(Number.NaN)).toBe(false);
    expect(limiter.consume(Number.POSITIVE_INFINITY)).toBe(false);
    // A legitimate finite call afterward still works normally — the
    // rejected samples were never recorded into the window.
    expect(limiter.consume(0)).toBe(true);
  });

  it('treats a decreasing nowMs (clock skew) as no progress rather than reopening an already-expired window', () => {
    const limiter = createRateLimiter({ maxCalls: 1, windowMs: 1000 });
    expect(limiter.consume(2000)).toBe(true); // The "real" clock has already advanced
    expect(limiter.consume(2000)).toBe(false); // Exhausted at the same instant
    // A smaller nowMs than what has already been observed must not act as
    // if the window had rewound and expired the entry above.
    expect(limiter.consume(500)).toBe(false);
  });
});
