import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSameFolder } from './folder.ts';
import type { ManagedFolder } from './folder.ts';

// Reading a file the agent named for an upload (#29), from a flat folder of
// this API, without ever leaving it.

// Letters, digits, `_` and `-`, in dot-separated parts: no separators, no
// `..`, no drive or UNC path, no `:` (Windows alternate data streams), no
// spaces, no trailing dot, nothing outside ASCII, no `~` (8.3 short names)
const NAME = /^[A-Za-z\d][\w-]*(?:\.[\w-]+)*$/u;
const NAME_MAX = 128;
// Windows device names, also with an extension (`nul.txt`)
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu;

export const isUploadName = (name: string): boolean =>
  name.length <= NAME_MAX && NAME.test(name) && !RESERVED.test(name);

export class UploadRefusedError extends Error {
  override name = 'UploadRefusedError';
}

const refuse = (name: string, reason: string): never => {
  throw new UploadRefusedError(`"${name}" ${reason}`);
};

// O_NOFOLLOW refuses a link at the name itself where the platform has it;
// Windows has neither flag, so the dev/ino comparison below is what catches
// a link, a junction or a swapped file there
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The bytes of `name` in `folder`, at most `maxBytes`. The file must be a
// regular file with one link (a hard link could reach a file elsewhere),
// and the handle that is read must be the file that was checked.
export const readUpload = async (
  folder: ManagedFolder,
  name: string,
  maxBytes: number,
): Promise<Uint8Array> => {
  // Before anything is opened: a device name would open a device
  if (!isUploadName(name)) {
    refuse(name, 'is not a plain file name in the upload folder');
  }
  await assertSameFolder(folder);
  const path = join(folder.path, name);
  const named = await lstat(path, { bigint: true }).catch(() =>
    refuse(name, 'is not in the upload folder'),
  );
  if (named.isSymbolicLink() || !named.isFile()) {
    refuse(name, 'is not a regular file');
  }
  if (named.size > BigInt(maxBytes)) {
    refuse(name, `is larger than the ${String(maxBytes)}-byte request body limit`);
  }
  const handle = await open(path, READ_FLAGS).catch(() => refuse(name, 'could not be opened'));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.nlink !== 1n
    ) {
      refuse(name, 'changed while it was opened, or has more than one link');
    }
    // The folder too: a parent swapped meanwhile would have led elsewhere
    await assertSameFolder(folder);
    // One byte past the limit shows a file that grew after the check
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
      if (filled > maxBytes) {
        refuse(name, `is larger than the ${String(maxBytes)}-byte request body limit`);
      }
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
};

// Files in the upload folder older than `maxAgeMs`, deleted at startup.
// Only for the folder this server manages: one an operator chose may hold
// their originals. Age is the latest of the modification, change and birth
// times (a copy on Windows keeps its old modification time). Only regular
// files with a valid upload name go; links are never followed, and a file
// that cannot be deleted is skipped.
export const sweepUploads = async (
  folder: ManagedFolder,
  maxAgeMs: number,
  now: number,
): Promise<number> => {
  await assertSameFolder(folder);
  const entries = await readdir(folder.path, { withFileTypes: true });
  let deleted = 0;
  for (const entry of entries) {
    if (entry.isFile() && isUploadName(entry.name)) {
      const path = join(folder.path, entry.name);
      try {
        const stats = await lstat(path);
        const newest = Math.max(stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs);
        if (stats.isFile() && now - newest > maxAgeMs) {
          await unlink(path);
          deleted += 1;
        }
      } catch {
        // Gone, or held open on Windows: the next start tries again
      }
    }
  }
  return deleted;
};
