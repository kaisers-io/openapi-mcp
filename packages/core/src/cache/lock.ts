import { randomUUID } from 'node:crypto';
import { conflictError, notFoundError } from '../errors.ts';
// `withCacheErrors` wraps the exports at the bottom of this file. It comes
// from the dependency-neutral `cache/errors.ts`: `store.ts` already imports
// `lock.ts`, so taking it from the store instead would be an import cycle.
import { withCacheErrors } from './errors.ts';
import type { CacheFs } from './fs.ts';
import { describeLockHolder, readLockHolder } from './lock-holder.ts';
import type { CacheLayout } from './paths.ts';

// This does NOT authorize a takeover. A held lock is always a conflict;
// this threshold only enriches the contention message and decides whether
// "cache unlock" needs --force.
export const LOCK_STALE_MS = 60_000;

// Bounded retry before a STRICT acquisition reports a conflict (#65), so two
// writers that merely overlap for a moment serialize instead of one failing.
// Exponential with "equal jitter" (half fixed, half random — see AWS,
// "Exponential Backoff And Jitter"): the random half de-synchronizes
// processes that started together, the fixed half keeps every wait
// meaningful. The schedule sums to at most ~2 s, after which a holder is
// assumed not to be finishing soon (a long refresh, or a crashed owner) and
// the conflict is reported exactly as before.
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400, 600, 600];

// A caller that knows how long the operator is prepared to wait (the spec
// pipeline passes --timeout through CacheRuntime.lockWaitMs) extends the
// schedule with further LOCK_RETRY_TAIL_MS steps until the nominal total
// reaches that budget. A first-use write of a large spec (serialize up to
// 64 MiB, fsync, rename) can hold the lock for longer than ~2 s, and a
// concurrent first use should wait for it rather than exit 5.
const LOCK_RETRY_TAIL_MS = 600;

export const lockRetrySchedule = (waitMs: number | undefined): readonly number[] => {
  const base = LOCK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  const extra =
    waitMs === undefined || waitMs <= base ? 0 : Math.ceil((waitMs - base) / LOCK_RETRY_TAIL_MS);
  return [...LOCK_RETRY_DELAYS_MS, ...Array.from({ length: extra }, () => LOCK_RETRY_TAIL_MS)];
};

const jittered = (delayMs: number): number =>
  Math.round(delayMs / 2 + Math.random() * (delayMs / 2));

// `stale` on a refusal: the holder looks gone (aged past LOCK_STALE_MS, or
// its pid is not running on this host), so the lock will not clear by
// itself and needs "openapi-mcp cache unlock"
type Acquisition =
  | { acquired: true; owner: string }
  | { acquired: false; message: string; stale: boolean };

// One acquisition, with or without the bounded retry. Never throws for a held
// lock: it returns the operator message instead, so the strict and the
// best-effort entry points below share every word of it.
const acquire = async (
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
  retry: boolean,
): Promise<Acquisition> => {
  await fs.mkdirSecure(layout.dir);
  const owner = randomUUID();
  const { runtime } = fs;
  // The recorded acquiredAt is the caller's clock plus the time slept so far, so a lock
  // obtained after backing off does not record itself as older than it is
  const recordAt = (atMs: number): string =>
    `${JSON.stringify({
      owner,
      acquiredAt: atMs,
      ...(runtime === undefined ? {} : { pid: runtime.pid, hostname: runtime.hostname }),
    })}\n`;
  // Without a runtime there is no sleep to back off with, so a fake
  // filesystem keeps the old single-attempt behaviour
  const delays = retry && runtime !== undefined ? lockRetrySchedule(runtime.lockWaitMs) : [];
  // Imperative on purpose: each attempt depends on the previous one failing,
  // and the backoff sleeps in between — a sequential loop by nature
  let sleptMs = 0;
  for (let attempt = 0; ; attempt += 1) {
    if (await fs.createExclusive(layout.lockPath, recordAt(nowMs + sleptMs))) {
      return { acquired: true, owner };
    }
    const delay = delays[attempt];
    if (delay === undefined || runtime === undefined) {
      break;
    }
    const wait = jittered(delay);
    await runtime.sleep(wait);
    sleptMs += wait;
  }
  const atMs = nowMs + sleptMs;
  // A held lock is ALWAYS a conflict. There is no automatic stale takeover,
  // because it cannot be made safe at a distance: B reads a stale record
  // belonging to A, C removes it and acquires a fresh lock, and B then
  // unlinks C's LIVE lock. The owner token protects release, not takeover,
  // and re-reading before the unlink only shrinks the window. Recovery is
  // the explicit "openapi-mcp cache unlock" instead. The pid/hostname in the
  // record do not change this: they let an operator (and the message below)
  // tell a dead owner from a live one, but a decision taken on them at a
  // distance would have exactly the same B/C race.
  const holder = await readLockHolder(layout, fs);
  const heldForMs = holder === undefined ? undefined : atMs - holder.acquiredAt;
  const who = holder === undefined ? undefined : describeLockHolder(holder, runtime);
  const details = [
    ...(who === undefined ? [] : [who.text]),
    ...(heldForMs === undefined || heldForMs < LOCK_STALE_MS
      ? []
      : [`held for ${String(Math.floor(heldForMs / 1000))}s`]),
  ];
  // The recovery hint matches what `cache unlock` will accept: an aged lock
  // needs no flag; a young one whose owner looks dead on this host still
  // needs --force (see describeLockHolder)
  const aged = heldForMs !== undefined && heldForMs >= LOCK_STALE_MS;
  const ownerGone = who?.alive === false;
  let hint = ' — retry once it finishes';
  if (aged) {
    hint += ', or run "openapi-mcp cache unlock" if the owning process is gone';
  } else if (ownerGone) {
    hint += ', or run "openapi-mcp cache unlock --force" if the owning process is gone';
  }
  return {
    acquired: false,
    stale: aged || ownerGone,
    message: `cache entry ${layout.namespace} is locked by another openapi-mcp process${
      details.length === 0 ? '' : ` (${details.join(', ')})`
    }${hint}`,
  };
};

// Refresh, promote, and any accepted/candidate write run under a
// per-namespace writer lock, which is what makes promoteCandidate's hash
// check a real compare-and-swap. Readers take no lock — they rely on meta.json
// being the sole commit point and on verifying the hashes it records.
//
// The holder record's identity is a random owner token, not the process id:
// a pid can be reused and is meaningless on another host, while the token
// lets the release step confirm it still owns the lock before removing it.
// The pid and hostname recorded beside it (injected through CacheFs.runtime,
// since core takes no process globals) are diagnostics for the operator only.
const runHolding = async <T>(
  layout: CacheLayout,
  fs: CacheFs,
  owner: string,
  run: () => Promise<T>,
): Promise<T> => {
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

// The strict lock every write that changes what is accepted goes through:
// bounded retry, then a conflictError (exit 5).
const withNamespaceLockImpl = async <T>(
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
  run: () => Promise<T>,
): Promise<T> => {
  const acquisition = await acquire(layout, fs, nowMs, true);
  if (!acquisition.acquired) {
    throw conflictError(acquisition.message);
  }
  return runHolding(layout, fs, acquisition.owner, run);
};

// The best-effort variant (#65), for writes that are only bookkeeping on an
// entry the caller has already verified (a 304, or a 200 with unchanged
// bytes, refreshing fetchedAt and validators). One attempt, no retry: when
// several servers start together, the first to get the lock records the
// revalidation and the others need not wait for it. A held lock is reported
// as a value, never thrown, so the caller can keep serving the verified
// baseline with a warning. Anything else (I/O failure, a corrupt entry found
// under the lock) still throws.
const tryWithNamespaceLockImpl = async <T>(
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
  run: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false; message: string; stale: boolean }> => {
  const acquisition = await acquire(layout, fs, nowMs, false);
  if (!acquisition.acquired) {
    return acquisition;
  }
  return { acquired: true, value: await runHolding(layout, fs, acquisition.owner, run) };
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
): Promise<{ heldForMs: number; holder?: string | undefined }> => {
  if (!(await fs.pathExists(layout.lockPath))) {
    throw notFoundError(`cache entry ${layout.namespace} holds no lock`);
  }
  const holder = await readLockHolder(layout, fs);
  // An absent-or-malformed record carries no timestamp, so it can only be
  // removed with --force: absent evidence of age, we do not get to assume the
  // holder is dead
  const heldForMs = holder === undefined ? 0 : nowMs - holder.acquiredAt;
  const who = holder === undefined ? undefined : describeLockHolder(holder, fs.runtime);
  // The age rule is unchanged even when the owner looks dead on this host:
  // see describeLockHolder for why a dead pid informs but does not authorize
  if (!opts.force && (holder === undefined || heldForMs < LOCK_STALE_MS)) {
    throw conflictError(
      `the lock on cache entry ${layout.namespace}${
        who === undefined ? '' : ` (${who.text})`
      } is not known to be stale — wait for the owning process, or pass --force to remove it anyway`,
    );
  }
  await fs.removeFile(layout.lockPath);
  return { heldForMs, ...(who === undefined ? {} : { holder: who.text }) };
};

// The one error boundary, applied at the DEFINITION so coverage is structural
// rather than a checklist of call sites (store.ts applies the identical
// treatment). An unwrapped export would let a raw createExclusive or
// removeFile failure surface as an unexpected exit 1 instead of the declared
// validation exit 3. `asCacheError` passes a typed OpenapiMcpError through
// untouched, so the contention conflictError above keeps exit 5 and its message.
//
// The generic matters: withCacheErrors is declared <TArgs extends unknown[], TResult>
// over the whole signature precisely so withNamespaceLock keeps its own type
// parameter T here.
export const withNamespaceLock = withCacheErrors(
  'acquire the namespace lock',
  withNamespaceLockImpl,
);
export const tryWithNamespaceLock = withCacheErrors(
  'acquire the namespace lock',
  tryWithNamespaceLockImpl,
);
export const unlockNamespace = withCacheErrors('unlock the namespace', unlockNamespaceImpl);
