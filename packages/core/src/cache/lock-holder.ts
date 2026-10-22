// The lock RECORD: what a lock file says about its holder, read as the
// untrusted input it is, and how that is put into words for an operator.
// Split from lock.ts, which owns acquisition and release.
import { isCacheAbsence } from './errors.ts';
import type { CacheFs, CacheRuntime } from './fs.ts';
import type { CacheLayout } from './paths.ts';

// The record is a single small JSON object. An over-cap lock file is NOT
// treated as "malformed, therefore stale" — readFileTextCapped raises a typed
// validationError on the cap and the narrowed catch propagates it. That is
// deliberate: a truncated record is a plausible crash artefact, but a lock
// file larger than a kilobyte is evidence of tampering, and the same
// fail-closed reasoning that governs a corrupt cache entry applies here too —
// fail closed and let an operator decide.
const LOCK_FILE_MAX_BYTES = 1024;

export type LockHolder = {
  owner: string;
  acquiredAt: number;
  // Who holds it (#65), when the writer had a runtime to record. Optional:
  // records written by earlier versions carry neither.
  pid?: number;
  hostname?: string;
};

// A lock file is untrusted input and the hostname is echoed to the
// operator's terminal, so only an RFC 1123-shaped name is believed; anything
// else is dropped rather than printed.
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/u;

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
export const readLockHolder = async (
  layout: CacheLayout,
  fs: CacheFs,
): Promise<LockHolder | undefined> => {
  // Imperative on purpose: the catch below `return`s `undefined` — a type
  // distinct from the `string` this variable holds on success — so folding
  // it into `.catch(...)` would need a sentinel checked afterward, i.e. a
  // control-flow restructuring, and this lock primitive's imperative shape
  // is deliberately left alone.
  let raw: string;
  try {
    raw = await fs.readFileTextCapped(layout.lockPath, LOCK_FILE_MAX_BYTES);
  } catch (error) {
    if (!isCacheAbsence(error)) {
      throw error;
    }
    return undefined;
  }
  // Imperative on purpose: JSON.parse is synchronous, so there is no promise
  // to `.catch`, and a try-as-expression here would need an IIFE this repo's
  // style forbids for its own sake.
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
  const { pid, hostname } = parsed as Record<string, unknown>;
  return {
    owner,
    acquiredAt,
    ...(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof hostname === 'string' && HOSTNAME_RE.test(hostname) ? { hostname } : {}),
  };
};

// "held by pid 1234 on this host, process not running". The liveness probe is
// only asked about a pid recorded on THIS host: a pid from another machine
// (a shared home over NFS) says nothing about our process table. A dead pid
// on this host is a strong signal, not proof — another PID namespace (a
// container sharing the cache directory under the same hostname) can hide a
// live owner — so it only informs the operator; it never authorizes removal.
//
// `alive` is set only when the probe could answer (same host), so callers
// decide on it rather than on the wording of `text`.
export const describeLockHolder = (
  holder: { pid?: number | undefined; hostname?: string | undefined },
  runtime: CacheRuntime | undefined,
): { text: string; alive?: boolean } | undefined => {
  if (holder.pid === undefined) {
    return undefined;
  }
  const pid = String(holder.pid);
  if (holder.hostname === undefined) {
    return { text: `held by pid ${pid}` };
  }
  if (runtime === undefined || holder.hostname !== runtime.hostname) {
    return { text: `held by pid ${pid} on host ${holder.hostname}` };
  }
  const alive = runtime.isProcessAlive(holder.pid);
  return {
    text: `held by pid ${pid} on this host, ${alive ? 'process running' : 'process not running'}`,
    alive,
  };
};
