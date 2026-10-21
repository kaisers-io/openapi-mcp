import { conflictError } from '../errors.ts';
import type { CacheMeta } from '../schemas/cache.ts';

// Compare-and-swap for cache writers (#34).
//
// The pipeline reads the cache entry lock-free, then fetches and validates
// (network I/O, never under the lock), and only then takes the writer lock to
// commit. The lock serializes the commits, but on its own it does not stop a
// writer from committing a decision made against a revision that is no longer
// current: two first-use loads that both saw an empty namespace, or a refresh
// that saw accepted B and resumed after B was replaced by a promoted C. Each
// writer therefore states the revision its decision was based on, and the
// store re-reads meta.json under the lock and compares before committing.
//
// `meta: undefined` means "I saw no entry" (trust-on-first-use). Leaving
// `expected` out altogether skips the check; only callers outside the
// pipeline's read-decide-write cycle (tests, the store's own internals) do so.
export type ExpectedRevision = { meta: CacheMeta | undefined };

// What identifies the revision a decision was made against: the accepted
// object, plus the waiting candidate (a decision to clear or replace it is
// only valid for the candidate that was actually seen). fetchedAt and the
// validators are deliberately NOT part of it, or every concurrent
// revalidation of an unchanged spec would invalidate every other one.
export const sameRevision = (
  expected: CacheMeta | undefined,
  current: CacheMeta | undefined,
): boolean =>
  expected?.acceptedContentHash === current?.acceptedContentHash &&
  expected?.candidate?.contentHash === current?.candidate?.contentHash;

export const STALE_REVISION_REASON =
  'it changed while this run was refreshing it (another openapi-mcp process accepted, promoted or cleared a revision in the meantime)';

// Exit 5 like a lock conflict: nothing is wrong with the entry, the command
// only has to be run again so its decision is made against what is current
export const staleRevisionError = (namespace: string): Error =>
  conflictError(
    `cache entry ${namespace} was not updated: ${STALE_REVISION_REASON} — run the command again`,
  );
