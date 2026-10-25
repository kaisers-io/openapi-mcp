import { randomBytes } from 'node:crypto';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSameFolder, openManagedFolder } from '../files/folder.ts';
import type { ManagedFolder } from '../files/folder.ts';
import type { ImageKind } from './sniff.ts';

// Saves upstream images for `--image-responses file` (#14) and keeps the
// folder under its byte cap.
export type ImageStore = {
  readonly dir: string;
  // The absolute path of the saved image
  save: (bytes: Uint8Array, kind: ImageKind) => Promise<string>;
};

// Only names this server makes are ever touched: `img-<UTC>-<random>.<ext>`,
// and the temporary name of one being written
const OWN_NAME = /^img-\d{8}T\d{6}Z-[\da-f]{16}\.(?:png|jpg|gif|webp)(?:\.tmp)?$/u;
// A temporary file younger than this may still be written by another process
const TEMP_GRACE_MS = 60_000;
const RENAME_ATTEMPTS = 4;
// Windows refuses a rename while a scanner or viewer holds the file
const BUSY_CODES: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY']);

export type ImageStoreDeps = {
  now?: () => number;
  // 16 hex characters for a name (tests pin it)
  randomHex?: () => string;
  // Tests stand in a rename that fails the way Windows can
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

const stampOf = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replaceAll(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');

// Oldest of this server's own files first, until the folder fits its cap.
// Best effort: the file just written is kept, and one that cannot be
// deleted (held open on Windows, already gone) is skipped.
const evict = async (
  folder: ManagedFolder,
  maxBytes: number,
  keep: string,
  now: number,
): Promise<void> => {
  const entries = await readdir(folder.path, { withFileTypes: true });
  const statted = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && OWN_NAME.test(entry.name))
      .map(async (entry) => {
        try {
          const stats = await lstat(join(folder.path, entry.name));
          return stats.isFile()
            ? [{ name: entry.name, size: stats.size, mtimeMs: stats.mtimeMs }]
            : [];
        } catch {
          return [];
        }
      }),
  );
  const files = statted.flat();
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const oldestFirst = files.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : 1),
  );
  for (const file of oldestFirst) {
    if (total <= maxBytes) {
      return;
    }
    const young = file.name.endsWith('.tmp') && now - file.mtimeMs < TEMP_GRACE_MS;
    if (file.name !== keep && !young) {
      try {
        await unlink(join(folder.path, file.name));
        total -= file.size;
      } catch (error) {
        if (codeOf(error) === 'ENOENT') {
          total -= file.size;
        }
      }
    }
  }
};

export const createImageStore = async (
  dir: string,
  maxBytes: number,
  deps: ImageStoreDeps = {},
): Promise<ImageStore> => {
  const folder = await openManagedFolder(dir, 'image folder');
  const now = deps.now ?? Date.now;
  const randomHex = deps.randomHex ?? ((): string => randomBytes(8).toString('hex'));
  const sleep =
    deps.sleep ??
    (async (ms: number): Promise<void> => {
      await delay(ms);
    });
  const renameFile = deps.rename ?? rename;
  const renameWithRetry = async (from: string, to: string, attempt = 1): Promise<void> => {
    try {
      await renameFile(from, to);
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !BUSY_CODES.has(codeOf(error))) {
        throw error;
      }
      await sleep(25 * 2 ** attempt);
      await renameWithRetry(from, to, attempt + 1);
    }
  };
  const evictQuietly = async (keep: string): Promise<void> => {
    try {
      await evict(folder, maxBytes, keep, now());
    } catch {
      // Best effort: the next write tries again
    }
  };
  const write = async (bytes: Uint8Array, kind: ImageKind): Promise<string> => {
    if (bytes.byteLength > maxBytes) {
      throw new Error(`the image is larger than the image folder's ${String(maxBytes)}-byte cap`);
    }
    await assertSameFolder(folder);
    const name = `img-${stampOf(now())}-${randomHex()}.${kind.extension}`;
    const target = join(folder.path, name);
    const temporary = `${target}.tmp`;
    // 'wx' creates the file or fails, also when a link sits at that name.
    // Whatever fails after it (a full disk, the rename), the temporary file
    // goes and eviction still runs, so failures cannot fill the folder.
    // Only a file this write created is ever removed: an existing one may be
    // another process's write in progress
    let created = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      await renameWithRetry(temporary, target);
    } catch (error) {
      if (created) {
        await unlink(temporary).catch(() => {});
        await evictQuietly('');
      }
      throw error;
    }
    await evictQuietly(name);
    return target;
  };
  // One write and eviction at a time, so a call never evicts the file
  // another call is about to return
  let queue: Promise<unknown> = Promise.resolve();
  return {
    dir: folder.path,
    save: async (bytes, kind) => {
      const previous = queue;
      const run = (async (): Promise<string> => {
        await previous;
        return write(bytes, kind);
      })();
      // The next write waits for this one, whether it succeeds or not
      queue = (async (): Promise<void> => {
        try {
          await run;
        } catch {
          // Reported to the caller of this write
        }
      })();
      return run;
    },
  };
};
