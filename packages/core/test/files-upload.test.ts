import { mkdtempSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openManagedFolder } from '../src/files/folder.ts';
import { isUploadName, readUpload, sweepUploads } from '../src/files/upload.ts';

// Reading an upload by name (#29). Runs on Linux, macOS and Windows in CI;
// junctions and hard links need no admin rights on Windows, file symlinks do
// (those cases skip where the platform refuses to create one).

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn<typeof actual.open>(actual.open) };
});

const isWindows = process.platform === 'win32';
const HOUR = 3_600_000;

describe('uploads (#29)', () => {
  const roots: string[] = [];
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'oamcp-uploads-'));
    roots.push(root);
    return root;
  };
  afterEach(async () => {
    vi.mocked(open).mockClear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const setUp = async () => {
    const root = scratch();
    const folder = await openManagedFolder(join(root, 'uploads'), 'upload folder');
    const outside = join(root, 'secret.txt');
    await writeFile(outside, 'outside the folder');
    return { root, folder, outside };
  };

  // A link the platform may refuse to create without privileges
  const trySymlink = async (target: string, path: string, type?: 'file' | 'dir' | 'junction') => {
    try {
      await symlink(target, path, type);
      return true;
    } catch {
      return false;
    }
  };

  it('reads a regular file in the folder', async () => {
    const { folder } = await setUp();
    await writeFile(join(folder.path, 'photo.png'), Uint8Array.from([1, 2, 3]));
    const bytes = await readUpload(folder, 'photo.png', 100);
    expect([...bytes]).toStrictEqual([1, 2, 3]);
  });

  it.each([
    '../secret.txt',
    'a/b.png',
    'a\\b.png',
    '/etc/hosts',
    'C:x.png',
    String.raw`\\?\C:\x.png`,
    String.raw`\\server\share\x.png`,
    'photo.png:hidden',
    'photo.png::$DATA',
    'CON',
    'nul.txt',
    'COM1.png',
    'lpt9',
    'photo.',
    'photo ',
    ' photo',
    'PROGRA~1',
    'fotö.png',
    '.hidden',
    'a..b',
    '',
    'x'.repeat(129),
  ])('refuses the name %j before opening anything', async (name) => {
    const { folder } = await setUp();
    expect(isUploadName(name)).toBe(false);
    await expect(readUpload(folder, name, 100)).rejects.toThrow(
      'is not a plain file name in the upload folder',
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('accepts ordinary names', () => {
    for (const name of [
      'photo.png',
      'IMG_2026-10-25.jpeg',
      'report.v2.pdf',
      'a',
      'x'.repeat(128),
    ]) {
      expect(isUploadName(name)).toBe(true);
    }
  });

  it('refuses a missing file and a directory', async () => {
    const { folder } = await setUp();
    await mkdir(join(folder.path, 'album'));
    await expect(readUpload(folder, 'missing.png', 100)).rejects.toThrow(
      'is not in the upload folder',
    );
    await expect(readUpload(folder, 'album', 100)).rejects.toThrow('is not a regular file');
  });

  it('refuses a symlink to a file outside', async () => {
    const { folder, outside } = await setUp();
    if (!(await trySymlink(outside, join(folder.path, 'link.png'), 'file'))) {
      return;
    }
    await expect(readUpload(folder, 'link.png', 100)).rejects.toThrow('is not a regular file');
  });

  it('refuses a junction or directory link inside the folder', async () => {
    const { root, folder } = await setUp();
    await mkdir(join(root, 'elsewhere'));
    await symlink(
      join(root, 'elsewhere'),
      join(folder.path, 'album'),
      isWindows ? 'junction' : 'dir',
    );
    await expect(readUpload(folder, 'album', 100)).rejects.toThrow('is not a regular file');
  });

  it('refuses a hard link to a file outside', async () => {
    const { folder, outside } = await setUp();
    await link(outside, join(folder.path, 'linked.txt'));
    await expect(readUpload(folder, 'linked.txt', 100)).rejects.toThrow('has more than one link');
  });

  it('refuses once the folder was replaced by a link to another directory', async () => {
    const { root, folder } = await setUp();
    await mkdir(join(root, 'elsewhere'));
    await writeFile(join(root, 'elsewhere', 'photo.png'), 'not from the upload folder');
    await rm(folder.path, { recursive: true });
    await symlink(join(root, 'elsewhere'), folder.path, isWindows ? 'junction' : 'dir');
    await expect(readUpload(folder, 'photo.png', 100)).rejects.toThrow(
      'is no longer the folder it was',
    );
  });

  it('refuses a file over the size limit, and reads one exactly at it', async () => {
    const { folder } = await setUp();
    await writeFile(join(folder.path, 'big.bin'), new Uint8Array(101));
    await writeFile(join(folder.path, 'fits.bin'), new Uint8Array(100));
    await expect(readUpload(folder, 'big.bin', 100)).rejects.toThrow('is larger than the 100-byte');
    expect(await readUpload(folder, 'fits.bin', 100)).toHaveLength(100);
  });

  it('never returns the bytes of a file swapped in while it is read', async () => {
    const { folder, outside } = await setUp();
    const inside = join(folder.path, 'photo.png');
    const parked = join(folder.path, 'parked.png');
    await writeFile(inside, 'inside the folder');
    const swapper = join(folder.path, 'swap.png');
    if (!(await trySymlink(outside, swapper, 'file'))) {
      return;
    }
    const state = { running: true };
    const swapping = (async () => {
      while (state.running) {
        await rename(inside, parked).catch(() => {});
        await rename(swapper, inside).catch(() => {});
        await rename(inside, swapper).catch(() => {});
        await rename(parked, inside).catch(() => {});
      }
    })();
    try {
      for (let round = 0; round < 300; round += 1) {
        let text = 'inside the folder';
        try {
          text = Buffer.from(await readUpload(folder, 'photo.png', 100)).toString('utf8');
        } catch {
          // Refused mid-swap, which is fine
        }
        expect(text).toBe('inside the folder');
      }
    } finally {
      state.running = false;
      await swapping;
    }
  });

  describe('startup sweep', () => {
    it('deletes upload files older than the limit, and keeps newer ones', async () => {
      const { folder } = await setUp();
      await writeFile(join(folder.path, 'old.png'), 'x');
      expect(await sweepUploads(folder, 24 * HOUR, Date.now() + HOUR)).toBe(0);
      expect(await readdir(folder.path)).toStrictEqual(['old.png']);
      expect(await sweepUploads(folder, 24 * HOUR, Date.now() + 25 * HOUR)).toBe(1);
      expect(await readdir(folder.path)).toStrictEqual([]);
    });

    it('never follows a link or touches a directory or an unusual name', async () => {
      const { root, folder, outside } = await setUp();
      await mkdir(join(root, 'elsewhere'));
      await writeFile(join(root, 'elsewhere', 'keep.png'), 'x');
      await symlink(
        join(root, 'elsewhere'),
        join(folder.path, 'album'),
        isWindows ? 'junction' : 'dir',
      );
      await trySymlink(outside, join(folder.path, 'link.png'), 'file');
      await writeFile(join(folder.path, 'notes txt'), 'x');
      await sweepUploads(folder, 24 * HOUR, Date.now() + 25 * HOUR);
      expect(await readdir(join(root, 'elsewhere'))).toStrictEqual(['keep.png']);
      expect(await readdir(root)).toContain('secret.txt');
      expect(await readdir(folder.path)).toContain('notes txt');
      expect(await readdir(folder.path)).toContain('album');
    });
  });
});
