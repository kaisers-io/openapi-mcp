import type { CacheMeta } from '../schemas/cache.ts';

export type FreshnessDecision =
  | { kind: 'fresh' }
  | { kind: 'revalidate'; etag?: string | undefined; lastModified?: string | undefined };

// A baseline inside the TTL is served with no network traffic; an expired one
// is revalidated with whatever validators the entry recorded.
// Absence is not a decision here — it is a readCacheEntry outcome.
export const evaluateFreshness = (
  meta: CacheMeta,
  nowMs: number,
  ttlMs: number,
): FreshnessDecision => {
  const ageMs = nowMs - meta.fetchedAt;
  // A negative age means the recorded timestamp is in the future — a clock
  // change or a hand-edited entry. Revalidate rather than trust it indefinitely.
  if (ageMs >= 0 && ageMs < ttlMs) {
    return { kind: 'fresh' };
  }
  return {
    kind: 'revalidate',
    ...(meta.etag === undefined ? {} : { etag: meta.etag }),
    ...(meta.lastModified === undefined ? {} : { lastModified: meta.lastModified }),
  };
};
