import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { validationError } from '../errors.ts';

// A folder this server keeps files in (saved images, uploads; #14, #29),
// identified by its device and inode so a later swap for another directory,
// a symlink or a Windows junction is noticed. BigInt ids: on Windows the
// 64-bit file index loses precision as a Number.
//
// Privacy follows the spec cache: owner-only on POSIX (0700, this user's),
// and on Windows the ACL the folder inherits from the user profile, which
// grants only the user, SYSTEM and Administrators (checked in CI).
export type ManagedFolder = { readonly path: string; readonly dev: bigint; readonly ino: bigint };

const isWindows = process.platform === 'win32';

const ownedByThisUser = (stats: BigIntStats): boolean =>
  isWindows || process.getuid === undefined || stats.uid === BigInt(process.getuid());

const closedToOthers = (stats: BigIntStats): boolean => isWindows || (stats.mode & 0o077n) === 0n;

const plainDirectory = (stats: BigIntStats): boolean =>
  stats.isDirectory() && !stats.isSymbolicLink();

// Creates the folder if it is missing and checks what is there. A folder
// this server manages is closed to other users if an earlier run left it
// open (as the cache does); one the operator chose is refused instead, since
// its permissions are theirs to decide.
export const openManagedFolder = async (
  dir: string,
  label: string,
  repair = true,
): Promise<ManagedFolder> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await lstat(dir, { bigint: true });
  if (!plainDirectory(stats)) {
    throw validationError(`${label} ${dir} is not a plain directory`);
  }
  if (!ownedByThisUser(stats)) {
    throw validationError(`${label} ${dir} belongs to another user`);
  }
  if (!closedToOthers(stats)) {
    if (!repair) {
      throw validationError(`${label} ${dir} is open to other users; restrict it with chmod 700`);
    }
    await chmod(dir, 0o700);
  }
  // The resolved path, so later steps do not walk a link in a parent again;
  // it must still be the directory just checked
  const path = await realpath(dir);
  const resolved = await lstat(path, { bigint: true });
  if (
    !plainDirectory(resolved) ||
    resolved.dev !== stats.dev ||
    resolved.ino !== stats.ino ||
    !closedToOthers(resolved)
  ) {
    throw validationError(`${label} ${dir} changed while it was being opened`);
  }
  return { path, dev: resolved.dev, ino: resolved.ino };
};

export class FolderChangedError extends Error {
  override name = 'FolderChangedError';
}

// The folder is still the directory that was opened, still this user's and
// still closed to others
export const assertSameFolder = async (folder: ManagedFolder): Promise<void> => {
  const stats = await lstat(folder.path, { bigint: true });
  if (
    !plainDirectory(stats) ||
    stats.dev !== folder.dev ||
    stats.ino !== folder.ino ||
    !ownedByThisUser(stats) ||
    !closedToOthers(stats)
  ) {
    throw new FolderChangedError(`${folder.path} is no longer the folder it was`);
  }
};
