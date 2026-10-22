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
// `meta: undefined` means "I saw no entry" (trust-on-first-use). The exported
// writers REQUIRE a RevisionCheck, so a new call site cannot silently skip
// the check by forgetting it: 'unchecked' has to be written out, and only
// callers outside a read-decide-write cycle (tests, the store's own
// internals) do so.
export type ExpectedRevision = { meta: CacheMeta | undefined };
export type RevisionCheck = ExpectedRevision | 'unchecked';

export const expectedRevisionOf = (check: RevisionCheck): ExpectedRevision | undefined =>
  check === 'unchecked' ? undefined : check;

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
  'another openapi-mcp process changed it while this run was refreshing it';

// Errors created by staleRevisionError, so the pipeline can recognise the
// conflict it may retry without matching on message text (a lock conflict
// has the same code and exit status, and must not be retried this way)
const staleRevisionErrors = new WeakSet<Error>();

// Exit 5 like a lock conflict: nothing is wrong with the entry, the command
// only has to be run again so its decision is made against what is current
export const staleRevisionError = (namespace: string): Error => {
  const error = conflictError(
    `cache entry ${namespace} was not updated: ${STALE_REVISION_REASON} — run the command again`,
  );
  staleRevisionErrors.add(error);
  return error;
};

export const isStaleRevisionError = (error: unknown): boolean =>
  error instanceof Error && staleRevisionErrors.has(error);
