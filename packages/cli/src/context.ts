import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, type Stats } from 'node:fs';
import {
  chmod,
  type FileHandle,
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
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  cachePathTypeError,
  type CacheFs,
  type PinnedDeps,
  validationError,
} from '@kaisers-io/openapi-mcp-core';
import { fetch as undiciFetch } from 'undici';

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  errLine: (line: string) => void;
  // Stderr terminal width when stderr is a TTY, else undefined (no soft-wrap
  // downstream). The error framing hard-wraps to this to keep hostile spec
  // text from reaching visual column zero on a dumb terminal.
  errWidth: () => number | undefined;
  // M6 Task 6 (DNS-pin stretch): undici's OWN fetch, matching `transport.fetch`
  // below — spec-fetch is now wired onto the same pinned transport the
  // upstream API executor uses (never Node's global fetch, which cannot be
  // paired with an installed-undici `Agent`; dual-package hazard, probed in
  // M5 Task 3).
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
  // M5 Task 11: the narrow, project-owned transport `pinnedRequest` needs for
  // the real upstream API executor — undici's OWN `fetch` (never Node's
  // global one, which cannot be paired with an installed-undici `Agent` —
  // the dual-package hazard probed in Task 3), `resolve` bound to this same
  // `lookup`, and a real per-call timeout signal factory.
  transport: PinnedDeps;
}

const CACHE_FS_ERROR = 'no cache filesystem configured in testContext';

// D17: only genuine absence is "no". ENOTDIR means a path component is not a
// directory, which is also absence of the target. Everything else — EACCES,
// ELOOP, EIO — propagates, because a miss is the one state that may become
// trust-on-first-use and an I/O error is not evidence of one.
const isAbsenceError = (err: unknown): boolean =>
  err !== null &&
  typeof err === 'object' &&
  'code' in err &&
  (err.code === 'ENOENT' || err.code === 'ENOTDIR');

// Round-8 finding 4: ONE `read` is not guaranteed to fill the buffer. A short
// read is legal on a *successful* call, and the round-8 draft returned whatever
// that single call happened to produce — so a valid cache file came back
// truncated, failed its hash check, and was classified `corrupt` (D5), which is
// fail-closed and clearable only by hand. Silent data loss presented as
// tampering is the worst shape this bug could take.
//
// Probed on this machine (Node 24.12.0, darwin): a single `read` requesting 8
// bytes from a FIFO holding 4 returned `bytesRead: 4`, while a 100,000-byte
// read of a local regular file filled the buffer completely. So this does NOT
// reproduce against a local disk — it is protection for a cache root on
// NFS/SMB/FUSE or a read interrupted by a signal. That is precisely why the
// loop is extracted here and tested through a fake handle that forces a
// short-read sequence: a test against the real filesystem would pass with or
// without the fix and prove nothing.
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

// Round-10 finding: `stat` FOLLOWS a symlink, so the round-9 `!isDirectory()`
// guard never caught one — a symlink to a real directory reports
// `isDirectory() === true` through `stat`, and a subsequent `chmod` (which
// also follows) would 0700 the attacker-chosen target. Callers pass an lstat
// result here instead, so a planted symlink is rejected before any chmod.
// Task 11 fix round: these two throws used to be validationError, but the
// sweep in cache-target.ts's clearAllNamespaces needs a way to tell "this
// namespace-shaped path is not a real directory" apart from EVERY OTHER
// validationError a cache operation can raise — including one whose
// interpolated PATH happens to contain the substring "is not a directory" or
// "is a symlink" (readFileTextCapped's over-budget message embeds the path
// verbatim, and it is called on layout.lockPath during the very same lock
// acquisition this function guards). A message-substring match could not
// tell those apart; a dedicated code can.
const rejectUnlessRealDirectory = (path: string, info: Stats): void => {
  if (info.isSymbolicLink()) {
    throw cachePathTypeError(`cache path "${path}" is a symlink, which is not allowed`);
  }
  if (!info.isDirectory()) {
    throw cachePathTypeError(`cache path "${path}" exists and is not a directory`);
  }
};

const realCacheFs = (): CacheFs => ({
  mkdirSecure: async (path) => {
    // D4, re-probed: mkdir(path, { recursive: true, mode: 0o700 }) does NOT
    // produce a usable tree. Under umask 0177 it fails outright with EACCES,
    // because the intermediate component is created 0600 and has no execute
    // bit, so nothing can be created inside it — and the leaf chmod the first
    // draft relied on never runs. Walk the missing suffix instead, creating
    // each component and chmod'ing it immediately.
    const missing: string[] = [];
    let cursor = path;
    for (;;) {
      try {
        await stat(cursor);
        break;
      } catch (err) {
        if (!isAbsenceError(err)) {
          throw err;
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
      } catch (err) {
        // A concurrent process may have created it between our stat and our
        // mkdir; anything else is a real failure
        if (err === null || typeof err !== 'object' || !('code' in err) || err.code !== 'EEXIST') {
          throw err;
        }
        // Round-10 finding: a symlink planted at `component` between our
        // walk-up `stat` and this `mkdir` also surfaces as EEXIST here, since
        // mkdir does not follow it — lstat tells that apart from a benign
        // concurrent creator before the chmod below, which DOES follow. A
        // genuine race (a real directory) passes this check unchanged.
        rejectUnlessRealDirectory(component, await lstat(component));
      }
      await chmod(component, 0o700);
    }
    if (missing.length === 0) {
      // The directory already existed: repair the mode of the directory we were
      // asked for (an entry created under a bad umask by an earlier version
      // must not be inherited), but never re-permission ancestors we did not
      // create — those are not ours.
      //
      // Round-9 finding: succeeding does not mean it is a directory — a
      // regular file here would otherwise be chmod'd to 0700 (executable),
      // deferring the real failure to the first write inside it. Round-10
      // finding: `stat` also follows a symlink to a real directory and
      // reports `isDirectory() === true`, so lstat replaces it here — a
      // symlink now reports `isSymbolicLink() === true` and is rejected
      // before the chmod below ever runs (chmod DOES follow).
      const info = await lstat(path);
      rejectUnlessRealDirectory(path, info);
      await chmod(path, 0o700);
    }
  },
  writeFileAtomic: async (path, data) => {
    // WriteFile's mode option is ignored for an existing file (D3), so an
    // in-place rewrite could not restore 0600. Create a fresh temp beside the
    // target, then rename: the replace is atomic and carries the mode across.
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    // "wx" rather than writeFile: an exclusive create cannot be tricked into
    // writing through a stale or planted temp path (probed: wx on an existing
    // path fails EEXIST and does not truncate). The cleanup covers create,
    // write, chmod and rename alike — the round-1 draft's try started after the
    // write, so a failed write or chmod left the temp behind.
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(tmp, path);
    } catch (err) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(tmp, { force: true });
      throw err;
    }
  },
  readFileTextCapped: async (path, maxBytes) => {
    // A cache file is untrusted input (D12): the size is checked on the open
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
    // D17: the round-1 draft swallowed EVERY stat failure into `false`, which
    // made an EACCES on a namespace indistinguishable from "nothing cached
    // here" — and a miss is exactly what may become trust-on-first-use. Only
    // genuine absence answers false; anything else propagates and fails closed.
    try {
      await stat(path);
      return true;
    } catch (err) {
      if (isAbsenceError(err)) {
        return false;
      }
      throw err;
    }
  },
  createExclusive: async (path, data) => {
    // Publish the lock atomically. Write the record to a PRIVATE temp first,
    // then link() it into place: link fails EEXIST if the lock is held (the
    // create-or-fail primitive, D12), and on ANY write failure only the temp is
    // removed — `path` is never created partial and never removed by us, so a
    // failed acquisition can neither leave an orphan lock nor delete a
    // replacement one (the round-2 TOCTOU the naive rm(path) would have had).
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
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, path);
      } catch (err) {
        if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
          return false;
        }
        throw err;
      }
      return true;
    } finally {
      // The temp is private scratch: a failure to remove it must NEVER turn a
      // successful acquisition into a rejection (which would orphan the lock
      // we just published, since withNamespaceLock has not yet entered its
      // release finally — the round-3 finding). A stray .tmp is harmless.
      await rm(tmp, { force: true }).catch(() => undefined);
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
  pending.catch(() => {
    // Consume a late rejection if the race below is lost to the deadline
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('DNS lookup aborted by the fetch deadline'));
      },
      { once: true },
    );
  });
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

export interface TestContextOverrides extends Partial<CliContext> {
  lines?: string[];
  errLines?: string[];
}

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
    errWidth: () => undefined,
    fetcher: () => Promise.reject(new Error('no fetcher configured in testContext')),
    now: () => 0,
    nodeVersion: '24.12.0',
    homeDir: () => undefined,
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
