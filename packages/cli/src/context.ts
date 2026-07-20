import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import {
  chmod,
  type FileHandle,
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
import { type CacheFs, validationError } from '@kaisers-io/openapi-mcp-core';

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  errLine: (line: string) => void;
  fetcher: typeof fetch;
  now: () => number;
  nodeVersion: string;
  homeDir: () => string | undefined;
  pathExists: (path: string) => boolean;
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
  cwd: () => string;
  lookup: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  cacheFs: CacheFs;
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
      }
      await chmod(component, 0o700);
    }
    if (missing.length === 0) {
      // The directory already existed: repair the mode of the directory we were
      // asked for (an entry created under a bad umask by an earlier version
      // must not be inherited), but never re-permission ancestors we did not
      // create — those are not ours.
      //
      // Round-9 finding: stat succeeding does not mean it is a directory. A
      // regular file sitting at the namespace path would otherwise be chmod'd
      // to 0700 (executable) here, deferring the real failure to the first
      // write inside it — refuse it explicitly instead.
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw validationError(`cache path "${path}" exists and is not a directory`);
      }
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
    // The "wx" flag is the lock primitive: an atomic create-or-fail (D12)
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
        return false;
      }
      throw err;
    }
    try {
      await handle.writeFile(data, 'utf8');
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    return true;
  },
  removeFile: (path) => rm(path, { force: true }),
});

export const realContext = (): CliContext => ({
  env: process.env,
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  errLine: (line) => {
    process.stderr.write(`${line}\n`);
  },
  fetcher: fetch,
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
  lookup: async (hostname, signal) => {
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
  },
  cacheFs: realCacheFs(),
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
    fetcher: () => Promise.reject(new Error('no fetcher configured in testContext')),
    now: () => 0,
    nodeVersion: '24.12.0',
    homeDir: () => undefined,
    pathExists: () => false,
    readFileText: () => Promise.reject(new Error('no file access configured in testContext')),
    fileSizeBytes: () => Promise.reject(new Error('no file access configured in testContext')),
    cwd: () => '/test-cwd',
    lookup: () => Promise.reject(new Error('no dns lookup configured in testContext')),
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
