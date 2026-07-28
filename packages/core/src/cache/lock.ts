import { randomUUID } from 'node:crypto';
import { conflictError, notFoundError } from '../errors.ts';
// `isCacheAbsence` is called by readLockHolder below and `withCacheErrors`
// wraps the two exports at the bottom of this file, so both are imported
// HERE. Both come from the dependency-neutral `cache/errors.ts`: `store.ts`
// already imports `lock.ts`, so taking them from the store instead would be
// an import cycle.
import { isCacheAbsence, withCacheErrors } from './errors.ts';
import type { CacheFs } from './fs.ts';
import type { CacheLayout } from './paths.ts';

// This does NOT authorize a takeover. A held lock is always a conflict;
// this threshold only enriches the contention message and decides whether
// "cache unlock" needs --force.
export const LOCK_STALE_MS = 60_000;

// The record is a single small JSON object. An over-cap lock file is NOT
// treated as "malformed, therefore stale" — readFileTextCapped raises a typed
// validationError on the cap and the narrowed catch propagates it. That is
// deliberate: a truncated record is a plausible crash artefact, but a lock
// file larger than a kilobyte is evidence of tampering, and the same
// fail-closed reasoning that governs a corrupt cache entry applies here too —
// fail closed and let an operator decide.
const LOCK_FILE_MAX_BYTES = 1_024;

interface LockHolder {
  owner: string;
  acquiredAt: number;
}

// Returns undefined for a lock file that is genuinely ABSENT or MALFORMED —
// two states that carry no expiry information.
//
// It must NOT return undefined for an EACCES or EIO. Catching every read
// failure here would turn an unreadable lock during contention into a typed
// `conflictError` (exit 5) and an unreadable lock during release into "not
// ours, leave it alone" — and because both outcomes are either non-errors or
// already-typed errors, the definition-level wrapper could not correct either
// afterward: a wrapper cannot recover information an inner catch has already
// discarded. The non-absence error is therefore propagated from here, and the
// boundary types it as validation exit 3.
const readLockHolder = async (
  layout: CacheLayout,
  fs: CacheFs,
): Promise<LockHolder | undefined> => {
  let raw: string;
  try {
    raw = await fs.readFileTextCapped(layout.lockPath, LOCK_FILE_MAX_BYTES);
  } catch (err) {
    if (!isCacheAbsence(err)) {
      throw err;
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { owner, acquiredAt } = parsed as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof acquiredAt !== 'number') {
    return undefined;
  }
  if (!Number.isSafeInteger(acquiredAt)) {
    return undefined;
  }
  return { owner, acquiredAt };
};

// Refresh, promote, and any accepted/candidate write run under a
// per-namespace writer lock, which is what makes promoteCandidate's hash
// check a real compare-and-swap. Readers take no lock — they rely on meta.json
// being the sole commit point and on verifying the hashes it records.
//
// The holder record carries a random owner token rather than a process id:
// core takes no process globals, and the token additionally lets the release
// step confirm it still owns the lock before removing it.
const withNamespaceLockImpl = async <T>(
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
  run: () => Promise<T>,
): Promise<T> => {
  await fs.mkdirSecure(layout.dir);
  const owner = randomUUID();
  const record = `${JSON.stringify({ owner, acquiredAt: nowMs })}\n`;
  const acquired = await fs.createExclusive(layout.lockPath, record);
  if (!acquired) {
    // A held lock is ALWAYS a conflict. There is no automatic stale takeover,
    // because it cannot be made safe at a distance: B reads a stale record
    // belonging to A, C removes it and acquires a fresh lock, and B then
    // unlinks C's LIVE lock. The owner token protects release, not takeover,
    // and re-reading before the unlink only shrinks the window. Recovery is
    // the explicit "openapi-mcp cache unlock" instead.
    const holder = await readLockHolder(layout, fs);
    const heldForMs = holder === undefined ? undefined : nowMs - holder.acquiredAt;
    throw conflictError(
      `cache entry ${layout.namespace} is locked by another openapi-mcp process${
        heldForMs === undefined || heldForMs < LOCK_STALE_MS
          ? ' — retry once it finishes'
          : ` (held for ${String(Math.floor(heldForMs / 1000))}s) — retry once it finishes, or run "openapi-mcp cache unlock" if the owning process is gone`
      }`,
    );
  }
  try {
    return await run();
  } finally {
    // Release unlinks ONLY on an affirmative owner-token match. Releasing
    // whenever readLockHolder returns `undefined` would be wrong: that value
    // means ABSENT or MALFORMED, and a malformed record covers a third party's
    // partially-written lock just as much as it covers a corrupt one. Deleting
    // on absence of evidence is how a release ends up removing someone else's
    // live lock. (A genuinely unreadable lock — EACCES, EIO — no longer reaches
    // here at all: readLockHolder propagates it, and the boundary types it as
    // validation exit 3.)
    //
    // Leaving a malformed lock behind is the safe direction: it is exactly
    // the state "openapi-mcp cache unlock" exists to resolve, and an operator
    // resolving it knowingly is the whole point of requiring that explicit step.
    const holder = await readLockHolder(layout, fs);
    if (holder !== undefined && holder.owner === owner) {
      await fs.removeFile(layout.lockPath);
    }
  }
};

// The explicit operator recovery path that replaces automatic stale breaking.
// It is deliberately a separate, named action rather than something a
// write silently performs: removing a lock that a live process still holds
// re-admits a second writer to the namespace, so the operator has to say so.
const unlockNamespaceImpl = async (
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
  opts: { force: boolean },
): Promise<{ heldForMs: number }> => {
  if (!(await fs.pathExists(layout.lockPath))) {
    throw notFoundError(`cache entry ${layout.namespace} holds no lock`);
  }
  const holder = await readLockHolder(layout, fs);
  // An absent-or-malformed record carries no timestamp, so it can only be
  // removed with --force: absent evidence of age, we do not get to assume the
  // holder is dead
  const heldForMs = holder === undefined ? 0 : nowMs - holder.acquiredAt;
  if (!opts.force && (holder === undefined || heldForMs < LOCK_STALE_MS)) {
    throw conflictError(
      `the lock on cache entry ${layout.namespace} is not known to be stale — wait for the owning process, or pass --force to remove it anyway`,
    );
  }
  await fs.removeFile(layout.lockPath);
  return { heldForMs };
};

// The one error boundary, applied at the DEFINITION so coverage is structural
// rather than a checklist of call sites (store.ts applies the identical
// treatment). An unwrapped export would let a raw createExclusive or
// removeFile failure surface as an unexpected exit 1 instead of the declared
// validation exit 3. `asCacheError` passes a typed OpenapiMcpError through
// untouched, so the contention conflictError above keeps exit 5 and its message.
//
// The generic matters: withCacheErrors is declared <A extends unknown[], R>
// over the whole signature precisely so withNamespaceLock keeps its own type
// parameter T here.
export const withNamespaceLock = withCacheErrors(
  'acquire the namespace lock',
  withNamespaceLockImpl,
);
export const unlockNamespace = withCacheErrors('unlock the namespace', unlockNamespaceImpl);
