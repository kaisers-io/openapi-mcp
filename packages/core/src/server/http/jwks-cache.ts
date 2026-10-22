import type { KeySet } from './jwk.ts';

// The JWKS cache policy for the OAuth resource-server mode. Transport-free:
// the fetch is handed in (oauth-discovery.ts supplies the pinned one), and
// every decision is driven by the injected clock.
//
// - A fetched set is fresh for JWKS_TTL_MS. After that, requests are still
//   verified against it immediately while ONE refresh runs in the background
//   (stale-while-revalidate), so no request waits on the authorization
//   server while a usable set is at hand.
// - An unknown `kid` (a key rotated in since the last fetch) asks for an
//   early refresh and waits for it.
// - Whatever asks, at most one fetch starts per REFETCH_COOLDOWN_MS, so
//   neither made-up kids nor a failing authorization server can turn inbound
//   requests into a stream of outbound fetches.
// - A fetch that fails (network error, non-200, not a JWKS, no usable key)
//   keeps the last good set, for at most MAX_STALE_MS after it was fetched;
//   past that, requests fail closed with 503 rather than trusting keys the
//   authorization server may have revoked.
// - A valid but EMPTY set (`{"keys": []}`) is the authorization server's
//   authoritative answer — it revoked every key — and is honoured: every
//   token is rejected until a signing key is published again.
export const JWKS_TTL_MS = 300_000;
export const REFETCH_COOLDOWN_MS = 30_000;
export const MAX_STALE_MS = 3_600_000;

export type KeySetFetch =
  | { kind: 'keys'; keys: KeySet }
  | { kind: 'revoked' }
  | { kind: 'failed'; detail: string };

export type JwksCache = {
  get: () => Promise<KeySet | undefined>;
  refreshForUnknownKid: () => Promise<KeySet | undefined>;
};

export type JwksCacheDeps = {
  // One JWKS fetch, classified.
  fetchKeySet: () => Promise<KeySetFetch>;
  // Where the keys come from, for warnings.
  location: string;
  now: () => number;
  warn: (message: string) => void;
};

export const createJwksCache = (initial: KeySet, deps: JwksCacheDeps): JwksCache => {
  let keys = initial;
  // When the authorization server last gave an authoritative answer.
  let fetchedAtMs = deps.now();
  let lastAttemptMs = fetchedAtMs;
  let inflight: Promise<void> | undefined;

  const fetchKeys = async (): Promise<void> => {
    let outcome: KeySetFetch;
    try {
      outcome = await deps.fetchKeySet();
    } catch (error) {
      outcome = { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.kind === 'keys') {
      ({ keys } = outcome);
      fetchedAtMs = deps.now();
      return;
    }
    if (outcome.kind === 'revoked') {
      keys = new Map();
      fetchedAtMs = deps.now();
      deps.warn(
        `the authorization server published an EMPTY JWKS at ${deps.location}: every access token is rejected until it publishes a signing key again`,
      );
      return;
    }
    const ageSeconds = Math.round((deps.now() - fetchedAtMs) / 1000);
    deps.warn(
      `JWKS refresh failed (${outcome.detail}); still using the key set from ${String(ageSeconds)} s ago, for at most ${String(MAX_STALE_MS / 60_000)} min after it was fetched`,
    );
  };
  const runFetch = async (): Promise<void> => {
    try {
      await fetchKeys();
    } finally {
      inflight = undefined;
    }
  };
  // Single-flight, and at most one fetch per REFETCH_COOLDOWN_MS whatever
  // asked for it. Resolves when the running fetch (if any) has settled.
  const refresh = (): Promise<void> => {
    if (inflight === undefined && deps.now() - lastAttemptMs >= REFETCH_COOLDOWN_MS) {
      lastAttemptMs = deps.now();
      inflight = runFetch();
    }
    return inflight ?? Promise.resolve();
  };
  const current = (): KeySet | undefined =>
    deps.now() - fetchedAtMs < MAX_STALE_MS ? keys : undefined;

  return {
    get: async () => {
      if (deps.now() - fetchedAtMs < JWKS_TTL_MS) {
        return keys;
      }
      const usable = current();
      if (usable !== undefined) {
        // Stale-while-revalidate: answer now, refresh in the background.
        void refresh();
        return usable;
      }
      await refresh();
      return current();
    },
    refreshForUnknownKid: async () => {
      await refresh();
      return current();
    },
  };
};
