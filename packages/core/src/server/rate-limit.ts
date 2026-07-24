// Servers MUST rate limit tool invocations (MCP tools spec, security
// considerations). ONE instance per process, constructed OUTSIDE any
// per-session factory (a limiter built inside an HTTP per-session Server
// factory silently becomes per-session, defeating the requirement) — the
// clock is injected (`nowMs` on every call) so tests are deterministic and
// this module never touches a real timer.
export interface RateLimiter {
  consume: (nowMs: number) => boolean;
}

export interface RateLimiterOptions {
  readonly maxCalls: number;
  readonly windowMs: number;
}

// A finite default only — there is deliberately no "unlimited" option; the
// spec MUST is unconditional. Frozen so this shared module-level constant
// itself cannot be mutated out from under every caller that relies on it
// (e.g. `createRateLimiter()` called with no argument).
export const DEFAULT_RATE_LIMIT: RateLimiterOptions = Object.freeze({
  maxCalls: 120,
  windowMs: 60_000,
});

const isPositiveFiniteInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

export const createRateLimiter = (opts: RateLimiterOptions = DEFAULT_RATE_LIMIT): RateLimiter => {
  // Capture the primitives into the closure FIRST, in one single read, THEN
  // validate from these captured locals — never by re-reading `opts` again.
  // `opts` is caller-owned and could be a Proxy/accessor whose getter
  // returns a DIFFERENT value on a second read of the SAME property (e.g. a
  // valid 120 the first time, `Infinity` the second) — validating directly
  // against `opts.maxCalls`/`opts.windowMs` and THEN destructuring would let
  // such an object pass validation against one value while the closure
  // silently captures another. Capturing once, up front, closes that gap:
  // whatever this ONE read yields is both what gets validated below AND
  // what every later `consume()` call actually uses. Numbers are copied by
  // value, so no cloning/freezing of `opts` itself is needed to prevent a
  // later mutation of the SAME object from reaching an already-constructed
  // limiter either.
  const { maxCalls, windowMs } = opts;
  if (!isPositiveFiniteInteger(maxCalls)) {
    throw new Error('rate limiter maxCalls must be a positive finite integer');
  }
  if (!isPositiveFiniteInteger(windowMs)) {
    throw new Error('rate limiter windowMs must be a positive finite integer');
  }
  // Sliding-window log of call timestamps, bounded by maxCalls (it never
  // holds more than maxCalls entries), so memory is O(maxCalls) even under
  // sustained abuse.
  const timestamps: number[] = [];
  // Tracks the highest nowMs ever observed, so a later DECREASING sample
  // (clock skew, a misbehaving caller) can never be treated as if real time
  // had rewound — see the effectiveNow clamp below.
  let highWaterMs = Number.NEGATIVE_INFINITY;
  return {
    consume: (nowMs: number): boolean => {
      // A non-finite/NaN sample can never legitimately occur (the CLI's
      // injected clock always returns a real Date.now() reading) — fail
      // CLOSED (deny) rather than let it corrupt the window: `windowStart`
      // would become NaN/Infinity, and `NaN <= x`/`x <= NaN` is always
      // false, silently disabling expiry (or acceptance) forever.
      if (!Number.isFinite(nowMs)) {
        return false;
      }
      // A decreasing nowMs is "no progress": clamp to the highest value
      // already observed. This keeps `timestamps` insertion-ordered (the
      // trim loop below assumes ascending order) and guarantees a stale
      // clock reading can never reopen a window that has already, from the
      // real clock's perspective, expired.
      const effectiveNow = Math.max(nowMs, highWaterMs);
      highWaterMs = effectiveNow;
      const windowStart = effectiveNow - windowMs;
      // An entry exactly windowMs old is expired: `timestamp <= windowStart`,
      // matching the window-boundary test above.
      while (timestamps.length > 0 && (timestamps[0] as number) <= windowStart) {
        timestamps.shift();
      }
      if (timestamps.length >= maxCalls) {
        return false;
      }
      timestamps.push(effectiveNow);
      return true;
    },
  };
};
