import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { cachePathTypeError, validationError } from '@kaisers-io/openapi-mcp-core';
import type { CacheFs, PinnedDeps } from '@kaisers-io/openapi-mcp-core';
import { fetch as undiciFetch } from 'undici';

export type CliContext = {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  errLine: (line: string) => void;
  // Stderr terminal width when stderr is a TTY, else undefined (no soft-wrap
  // downstream). The error framing hard-wraps to this to keep hostile spec
  // text from reaching visual column zero on a dumb terminal.
  errWidth: () => number | undefined;
  // Undici's OWN fetch, matching `transport.fetch` below: spec-fetch is
  // wired onto the same pinned transport the upstream API executor uses,
  // never Node's global fetch, which cannot be paired with an
  // installed-undici `Agent` (a dual-package hazard).
  fetcher: PinnedDeps['fetch'];
  now: () => number;
  nodeVersion: string;
  homeDir: () => string | undefined;
  pathExists: (path: string) => boolean;
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
  cwd: () => string;
  lookup: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  cacheFs: CacheFs;
  // The narrow, project-owned transport `pinnedRequest` needs for the real
  // upstream API executor: undici's OWN `fetch` (never Node's global one,
  // which cannot be paired with an installed-undici `Agent` — a dual-package
  // hazard), `resolve` bound to this same `lookup`, and a real per-call
  // timeout signal factory.
  transport: PinnedDeps;
};

const CACHE_FS_ERROR = 'no cache filesystem configured in testContext';

// Only genuine absence counts as "no". ENOTDIR means a path component is not
// a directory, which is also absence of the target. Everything else —
// EACCES, ELOOP, EIO — propagates, because a miss is the one state that may
// become trust-on-first-use, and an I/O error is not evidence of one.
const isAbsenceError = (err: unknown): boolean =>
  err !== null &&
  typeof err === 'object' &&
  'code' in err &&
  (err.code === 'ENOENT' || err.code === 'ENOTDIR');

// ONE `read` is not guaranteed to fill the buffer: a short read is legal on
// a *successful* call, so relying on a single call can return a truncated
// cache file that then fails its hash check and is classified `corrupt` — a
// fail-closed state clearable only by hand. Silent data loss surfacing as
// tampering is the worst shape this hazard can take. This loop retries until
// the buffer is full or a genuine EOF is reached.
//
// Probed on this machine (Node 24.12.0, darwin): a single `read` requesting 8
// bytes from a FIFO holding 4 returned `bytesRead: 4`, while a 100,000-byte
// read of a local regular file filled the buffer completely. So this does NOT
// reproduce against a local disk — it guards a cache root on NFS/SMB/FUSE, or
// a read interrupted by a signal.
//
// A zero-byte read means EOF. The file shrank between `stat` and `read`, and
// the prefix actually present is the honest answer to return.
export const readExactly = async (handle: FileHandle, buffer: Buffer): Promise<number> => {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset;
};

// `stat` FOLLOWS a symlink, so an `!isDirectory()` guard on a `stat` result
// never catches one — a symlink to a real directory reports
// `isDirectory() === true` through `stat`, and a subsequent `chmod` (which
// also follows) would 0700 the attacker-chosen target. Callers pass an lstat
// result here instead, so a planted symlink is rejected before any chmod.
// These throw a dedicated `cachePathTypeError` rather than `validationError`
// so the sweep in cache-target.ts's clearAllNamespaces can tell "this
// namespace-shaped path is not a real directory" apart from EVERY OTHER
// validationError a cache operation can raise — including one whose
// interpolated PATH happens to contain the substring "is not a directory" or
// "is a symlink" (readFileTextCapped's over-budget message embeds the path
// verbatim, and it is called on layout.lockPath during the very same lock
// acquisition this function guards). A message-substring match could not
// tell those apart; a dedicated error code can.
const rejectUnlessRealDirectory = (path: string, info: Stats): void => {
  if (info.isSymbolicLink()) {
    throw cachePathTypeError(`cache path "${path}" is a symlink, which is not allowed`);
  }
  if (!info.isDirectory()) {
    throw cachePathTypeError(`cache path "${path}" exists and is not a directory`);
  }
};

// Crash durability for the atomic writes below. rename() and link() are
// atomic with respect to OTHER PROCESSES, but not with respect to a crash:
// without a barrier the kernel may persist the new directory entry before the
// file's data blocks (ext4/XFS/btrfs delayed allocation), so after a power
// loss the target can be zero-length or torn. The cache fails closed on
// exactly that state (an unparsable meta.json or a hash-mismatched object is
// `corrupt` and never healed automatically), so a torn write would turn into
// a permanent exit 3 until a manual `cache clear`. The sequence used here is
// the standard one (LWN, "Ensuring data reaches disk"): write the temp, fsync
// it, rename it into place, then fsync the containing directory so the
// rename itself is durable.
//
// Because every writeFileAtomic fsyncs before it resolves, the store's
// "objects first, meta.json second" commit order is also the order in which
// they reach the disk: meta.json can never durably name an object whose bytes
// are not already there.
//
// FileHandle.sync() is fsync(2) on Linux. On macOS, plain fsync does not
// flush the drive's write cache, but libuv's uv_fs_fsync issues
// fcntl(F_FULLFSYNC) there (falling back to F_BARRIERFSYNC, then fsync), so
// the same call is a full flush on both supported platforms. The price is
// macOS-specific: F_FULLFSYNC typically costs several milliseconds, and every
// writeFileAtomic pays it twice (file, then directory), so a commit of N
// objects plus meta.json costs 2(N+1) full flushes. Commits are rare (only on
// a spec change), so this is accepted; it shows up when benchmarking cold
// starts on macOS.
//
// Some filesystems refuse fsync on a directory descriptor (EINVAL on several
// FUSE and network mounts, ENOTSUP/EOPNOTSUPP elsewhere). That means "this
// filesystem offers no directory barrier", not "the write failed", so it is
// tolerated. Every other failure propagates: an fsync error is the kernel
// reporting that written data may be lost (see PostgreSQL's "fsyncgate"), and
// it must not be reported as a successful write.
const isDirectoryBarrierUnsupported = (err: unknown): boolean =>
  err !== null &&
  typeof err === 'object' &&
  'code' in err &&
  (err.code === 'EINVAL' || err.code === 'ENOTSUP' || err.code === 'EOPNOTSUPP');

const syncDirectory = async (path: string): Promise<void> => {
  // Imperative on purpose: the handle must be closed on every path, including
  // a tolerated sync failure, and a close failure on a read-only directory
  // descriptor carries no information about the data being made durable
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!isDirectoryBarrierUnsupported(error)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
};

const realCacheFs = (): CacheFs => ({
  mkdirSecure: async (path) => {
    // Calling mkdir(path, { recursive: true, mode: 0o700 }) does NOT produce
    // a usable tree (probed): under umask 0177 it fails outright with
    // EACCES, because the intermediate component is created 0600 and has no
    // execute bit, so nothing can be created inside it, and a leaf-only
    // chmod never runs. Walk the missing suffix instead, creating each
    // component and chmod'ing it immediately.
    const missing: string[] = [];
    let cursor = path;
    for (;;) {
      try {
        await stat(cursor);
        break;
      } catch (error) {
        if (!isAbsenceError(error)) {
          throw error;
        }
        missing.unshift(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) {
          break;
        }
        cursor = parent;
      }
    }
    for (const component of missing) {
      try {
        await mkdir(component);
      } catch (error) {
        // A concurrent process may have created it between our stat and our
        // mkdir; anything else is a real failure
        if (
          error === null ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        ) {
          throw error;
        }
        // A symlink planted at `component` between our walk-up `stat` and
        // this `mkdir` also surfaces as EEXIST here, since mkdir does not
        // follow it — lstat tells that apart from a benign concurrent creator
        // before the chmod below, which DOES follow. A genuine race (a real
        // directory) passes this check unchanged.
        rejectUnlessRealDirectory(component, await lstat(component));
      }
      await chmod(component, 0o700);
    }
    // A freshly created directory is itself a new entry in its parent, and
    // that entry is only crash-durable once the PARENT is fsynced (the same
    // rule writeFileAtomic applies to files). Losing a namespace directory
    // after a crash would silently drop an accepted baseline and re-enter
    // trust-on-first-use. Best effort: the first parent is a directory we did
    // not create (it may not even be readable by us, e.g. a 0711 ancestor of
    // --cache-root), and an unsynced new directory is at worst a clean miss,
    // never a corrupt entry, so no failure here may fail the mkdir.
    for (const component of missing) {
      await syncDirectory(dirname(component)).catch(() => {});
    }
    if (missing.length === 0) {
      // The directory already existed: repair the mode of the directory we were
      // asked for (an entry created under a bad umask by an earlier version
      // must not be inherited), but never re-permission ancestors we did not
      // create — those are not ours.
      //
      // Succeeding does not mean it is a directory — a regular file here
      // would otherwise be chmod'd to 0700 (executable), deferring the real
      // failure to the first write inside it. `stat` also follows a symlink
      // to a real directory and reports `isDirectory() === true`, so lstat
      // replaces it here: a symlink reports `isSymbolicLink() === true` and
      // is rejected before the chmod below ever runs (chmod DOES follow).
      const info = await lstat(path);
      rejectUnlessRealDirectory(path, info);
      await chmod(path, 0o700);
    }
  },
  writeFileAtomic: async (path, data) => {
    // WriteFile's mode option is ignored for an existing file, so an in-place
    // rewrite could not restore 0600. Create a fresh temp beside the target,
    // then rename: the replace is atomic and carries the mode across.
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    // "wx" rather than writeFile: an exclusive create cannot be tricked into
    // writing through a stale or planted temp path (probed: wx on an existing
    // path fails EEXIST and does not truncate). The try block starts at the
    // open() call, so the cleanup below covers create, write, chmod and
    // rename alike: a failed write or chmod still triggers it, leaving no
    // orphaned temp file behind.
    //
    // sync() before rename and syncDirectory() after it make the replace
    // crash-durable, not only atomic — see syncDirectory above. A failed
    // file fsync aborts BEFORE the rename, so the previous target survives.
    // A failed directory fsync comes AFTER it: the call then rejects although
    // the new content is already visible, with its durability unknown (the
    // CacheFs contract in core spells out what callers may assume).
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => {});
      }
      await rm(tmp, { force: true });
      throw error;
    }
  },
  readFileTextCapped: async (path, maxBytes) => {
    // A cache file is untrusted input: the size is checked on the open
    // handle, before any bytes are turned into a string, so an oversized file
    // is refused rather than buffered
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) {
        throw validationError(
          `cache file "${path}" is ${size} bytes — exceeds the ${maxBytes}-byte budget`,
        );
      }
      const buffer = Buffer.alloc(Number(size));
      const bytesRead = await readExactly(handle, buffer);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  },
  readDirNames: (path) => readdir(path),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  pathExists: async (path) => {
    // Swallowing EVERY stat failure into `false` would make an EACCES on a
    // namespace indistinguishable from "nothing cached here" — and a miss is
    // exactly what may become trust-on-first-use. Only genuine absence
    // answers false; anything else propagates and fails closed.
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isAbsenceError(error)) {
        return false;
      }
      throw error;
    }
  },
  createExclusive: async (path, data) => {
    // Publish the lock atomically. Write the record to a PRIVATE temp first,
    // then link() it into place: link fails EEXIST if the lock is held (the
    // create-or-fail primitive), and on ANY write failure only the temp is
    // removed — `path` is never created partial and never removed by us, so a
    // failed acquisition can neither leave an orphan lock nor delete a
    // replacement one (the TOCTOU hazard a naive rm(path) would have had).
    // Follow-up (documented, not fixed here): this depends on hard-link support.
    // On a filesystem that offers exclusive create but not hard links (exFAT/
    // FAT32, some network mounts) link throws EPERM/ENOTSUP/ENOSYS — rethrown
    // below since only EEXIST is caught — and acquisition fails where a plain
    // open(path, 'wx') would have succeeded. The cache root is always under the
    // home directory, whose filesystem already has to honour the 0700/0600 mode
    // model this subsystem relies on, so a hard-link-incapable root is already
    // out of scope; a fallback would reintroduce the orphan-lock window closed here.
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(data, 'utf8');
        await handle.chmod(0o600);
        // The record is fsynced BEFORE it is published, so a lock that
        // survives a crash is always a complete, parseable record carrying its
        // acquiredAt (which `cache unlock` can age out), never a zero-length
        // file that only --force can remove
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, path);
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        ) {
          return false;
        }
        throw error;
      }
      // Best effort, and deliberately swallowed: once link() has succeeded the
      // lock is PUBLISHED, and throwing now would orphan it exactly like a
      // failing temp cleanup would (see the finally below). The next
      // writeFileAtomic in this directory fsyncs the directory anyway.
      await syncDirectory(dirname(path)).catch(() => {});
      return true;
    } finally {
      // The temp is private scratch: a failure to remove it must NEVER turn a
      // successful acquisition into a rejection (which would orphan the lock
      // we just published, since withNamespaceLock has not yet entered its
      // release finally). A stray .tmp is harmless.
      await rm(tmp, { force: true }).catch(() => {});
    }
  },
  removeFile: (path) => rm(path, { force: true }),
});

// A TTY whose columns are unavailable (0/undefined) still soft-wraps, so it
// resolves to a real fallback width rather than undefined (which downstream
// means "non-TTY, no wrap"). Pure so it is testable directly.
const STDERR_FALLBACK_WIDTH = 80;
export const resolveErrWidth = (
  isTTY: boolean,
  columns: number | undefined,
): number | undefined => {
  if (!isTTY) {
    return undefined;
  }
  return columns !== undefined && columns > 0 ? columns : STDERR_FALLBACK_WIDTH;
};

const realLookup = async (hostname: string, signal: AbortSignal): Promise<readonly string[]> => {
  signal.throwIfAborted();
  const pending = dnsLookup(hostname, { all: true });
  // oxlint-disable-next-line promise/prefer-await-to-then -- detached late-rejection handler: `pending` may still reject after `aborted` wins the race below, and an unconsumed rejection would surface as an unhandledRejection
  pending.catch(() => {
    // Consume a late rejection if the race below is lost to the deadline
  });
  // oxlint-disable-next-line promise/avoid-new -- wraps the non-abortable dns.promises.lookup race: the signal's 'abort' event has no promise form, so this bridges it into one
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('DNS lookup aborted by the fetch deadline'));
      },
      { once: true },
    );
  });
  // oxlint-disable-next-line promise/prefer-await-to-then -- detached late-rejection handler: `aborted` never resolves and would surface as an unhandledRejection once `pending` wins the race below
  aborted.catch(() => {
    // Consume the deadline rejection if the lookup won the race
  });
  const entries = await Promise.race([pending, aborted]);
  return entries.map((entry) => entry.address);
};

export const realContext = (): CliContext => ({
  env: process.env,
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  errLine: (line) => {
    process.stderr.write(`${line}\n`);
  },
  errWidth: () => resolveErrWidth(process.stderr.isTTY === true, process.stderr.columns),
  fetcher: undiciFetch,
  now: () => Date.now(),
  nodeVersion: process.versions.node,
  homeDir: () => homedir(),
  // oxlint-disable-next-line node/no-sync -- CliContext's pathExists contract returns boolean, not Promise<boolean>; existsSync is the only fs primitive matching that synchronous shape
  pathExists: (path) => existsSync(path),
  readFileText: (path) => readFile(path, 'utf8'),
  fileSizeBytes: async (path) => {
    const stats = await stat(path);
    return stats.size;
  },
  cwd: () => process.cwd(),
  lookup: realLookup,
  cacheFs: realCacheFs(),
  transport: {
    fetch: undiciFetch,
    resolve: realLookup,
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  },
});

// TestContextOverrides adds only `lines`/`errLines`, neither of which is a
// CliContext member name, so this intersection cannot silently collapse an
// inherited member's type to `never`.
export type TestContextOverrides = Partial<CliContext> & {
  lines?: string[];
  errLines?: string[];
};

export const testContext = (overrides: TestContextOverrides = {}): CliContext => {
  const { lines = [], errLines = [], ...rest } = overrides;
  return {
    env: {},
    out: (line) => {
      lines.push(line);
    },
    errLine: (line) => {
      errLines.push(line);
    },
    errWidth: () => {},
    fetcher: () => Promise.reject(new Error('no fetcher configured in testContext')),
    now: () => 0,
    nodeVersion: '24.12.0',
    homeDir: () => {},
    pathExists: () => false,
    readFileText: () => Promise.reject(new Error('no file access configured in testContext')),
    fileSizeBytes: () => Promise.reject(new Error('no file access configured in testContext')),
    cwd: () => '/test-cwd',
    lookup: () => Promise.reject(new Error('no dns lookup configured in testContext')),
    transport: {
      fetch: () => Promise.reject(new Error('no transport configured in testContext')),
      resolve: () => Promise.reject(new Error('no transport configured in testContext')),
      timeoutSignal: () => AbortSignal.timeout(0),
    },
    cacheFs: {
      mkdirSecure: () => Promise.reject(new Error(CACHE_FS_ERROR)),
      writeFileAtomic: () => Promise.reject(new Error(CACHE_FS_ERROR)),
      readFileTextCapped: () => Promise.reject(new Error(CACHE_FS_ERROR)),
      readDirNames: () => Promise.reject(new Error(CACHE_FS_ERROR)),
      removeDir: () => Promise.reject(new Error(CACHE_FS_ERROR)),
      pathExists: () => Promise.reject(new Error(CACHE_FS_ERROR)),
      createExclusive: () => Promise.reject(new Error(CACHE_FS_ERROR)),
      removeFile: () => Promise.reject(new Error(CACHE_FS_ERROR)),
    },
    ...rest,
  };
};
