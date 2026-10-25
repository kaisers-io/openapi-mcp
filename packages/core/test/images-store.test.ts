import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImageStore } from '../src/images/store.ts';
import type { ImageKind } from '../src/images/sniff.ts';

// The folder that `--image-responses file` saves images to (#14). Runs on
// Linux, macOS and Windows in CI; the junction cases only on Windows.

const isWindows = process.platform === 'win32';
const PNG: ImageKind = { mediaType: 'image/png', extension: 'png', width: 1, height: 1 };
const OWN_NAME = /^img-\d{8}T\d{6}Z-[\da-f]{16}\.png$/u;

const bytesOf = (size: number, fill = 1): Uint8Array => new Uint8Array(size).fill(fill);

describe('createImageStore (#14)', () => {
  const roots: string[] = [];
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'oamcp-images-'));
    roots.push(root);
    return root;
  };
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('creates the folder, saves under a name of its own and returns the absolute path', async () => {
    const dir = join(scratch(), 'images', 'api');
    const store = await createImageStore(dir, 1000);
    const path = await store.save(bytesOf(10), PNG);
    expect(path.startsWith(store.dir)).toBe(true);
    expect(path.slice(store.dir.length + 1)).toMatch(OWN_NAME);
    expect(Buffer.from(await readFile(path))).toStrictEqual(Buffer.from(bytesOf(10)));
    if (!isWindows) {
      const folderStats = await stat(dir);
      const fileStats = await stat(path);
      expect(folderStats.mode & 0o777).toBe(0o700);
      expect(fileStats.mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a folder that is a symlink', async () => {
    const root = scratch();
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'), isWindows ? 'junction' : 'dir');
    await expect(createImageStore(join(root, 'link'), 1000)).rejects.toThrow(
      'is not a plain directory',
    );
  });

  it.skipIf(isWindows)('closes a folder that an earlier run left open to others', async () => {
    const dir = join(scratch(), 'open');
    await mkdir(dir);
    await chmod(dir, 0o755);
    await createImageStore(dir, 1000);
    const stats = await stat(dir);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWindows)('refuses to write once the folder was opened to others', async () => {
    const store = await createImageStore(join(scratch(), 'images'), 1000);
    await chmod(store.dir, 0o777);
    await expect(store.save(bytesOf(10), PNG)).rejects.toThrow('is no longer the folder it was');
  });

  // The Windows counterpart of the mode checks: a folder created under the
  // user profile inherits its ACL, which grants other standard users nothing
  it.runIf(isWindows)('creates a folder other standard users cannot access', async () => {
    const store = await createImageStore(join(scratch(), 'images'), 1000);
    const path = await store.save(bytesOf(10), PNG);
    for (const target of [store.dir, path]) {
      const acl = spawnSync('icacls', [target], { encoding: 'utf8' });
      expect(acl.status).toBe(0);
      expect(acl.stdout).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|\\Guests/u);
    }
  });

  it('refuses to write once the folder was swapped for another directory', async () => {
    const root = scratch();
    const dir = join(root, 'images');
    const store = await createImageStore(dir, 1000);
    await rm(dir, { recursive: true });
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), dir, isWindows ? 'junction' : 'dir');
    await expect(store.save(bytesOf(10), PNG)).rejects.toThrow('is no longer the folder it was');
    expect(await readdir(join(root, 'elsewhere'))).toStrictEqual([]);
  });

  it('refuses an image larger than the folder cap', async () => {
    const store = await createImageStore(join(scratch(), 'images'), 100);
    await expect(store.save(bytesOf(101), PNG)).rejects.toThrow('larger than the image folder');
  });

  it('deletes its own oldest images first to stay under the cap, never the new one', async () => {
    let now = Date.parse('2026-10-25T10:00:00Z');
    const store = await createImageStore(join(scratch(), 'images'), 250, { now: () => now });
    const paths: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      paths.push(await store.save(bytesOf(100, index), PNG));
      // Distinct, increasing mtimes
      await utimes(paths[index] as string, now / 1000, now / 1000);
      now += 60_000;
    }
    const left = await readdir(store.dir);
    expect(left.toSorted()).toStrictEqual(
      paths
        .slice(2)
        .map((path) => path.slice(store.dir.length + 1))
        .toSorted(),
    );
  });

  it('never touches files it did not create, links included', async () => {
    const root = scratch();
    const outside = join(root, 'outside.png');
    await writeFile(outside, bytesOf(500));
    const store = await createImageStore(join(root, 'images'), 150);
    await writeFile(join(store.dir, 'notes.png'), bytesOf(500));
    await symlink(outside, join(store.dir, 'img-20260101T000000Z-0000000000000000.png')).catch(
      () => {},
    );
    await store.save(bytesOf(100), PNG);
    await store.save(bytesOf(100), PNG);
    const notes = await lstat(join(store.dir, 'notes.png'));
    const original = await lstat(outside);
    expect(notes.size).toBe(500);
    expect(original.size).toBe(500);
  });

  it('keeps going when a file cannot be deleted', async () => {
    const store = await createImageStore(join(scratch(), 'images'), 150);
    const first = await store.save(bytesOf(100), PNG);
    await rm(first);
    await expect(store.save(bytesOf(100), PNG)).resolves.toMatch(/\.png$/u);
  });

  it('saves concurrent images one at a time, none lost', async () => {
    const store = await createImageStore(join(scratch(), 'images'), 10_000);
    const paths = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) => store.save(bytesOf(10, index), PNG)),
    );
    expect(new Set(paths).size).toBe(12);
    expect(await readdir(store.dir)).toHaveLength(12);
  });

  it('does not write through a link planted at its temporary name', async () => {
    const root = scratch();
    const outside = join(root, 'target.png');
    await writeFile(outside, 'original');
    const store = await createImageStore(join(root, 'images'), 1000, {
      now: () => Date.parse('2026-10-25T10:00:00Z'),
      randomHex: () => 'ffffffffffffffff',
    });
    const temporary = join(store.dir, 'img-20261025T100000Z-ffffffffffffffff.png.tmp');
    await link(outside, temporary);
    // Old enough to count as abandoned, and the folder over its cap: still
    // not this write's to remove after its own open failed
    await writeFile(join(store.dir, 'img-20261025T080000Z-aaaaaaaaaaaaaaaa.png'), bytesOf(2000));
    const longAgo = Date.parse('2026-10-25T08:00:00Z') / 1000;
    await utimes(temporary, longAgo, longAgo);
    await expect(store.save(bytesOf(10), PNG)).rejects.toThrow(/EEXIST/u);
    expect(await readFile(outside, 'utf8')).toBe('original');
    // Not this write's file, so it stays (it may be another process's)
    expect(await readdir(store.dir)).toContain('img-20261025T100000Z-ffffffffffffffff.png.tmp');
  });

  it('retries a rename that Windows refuses while the file is busy', async () => {
    const failures = ['EBUSY', 'EPERM'];
    // The real backoff: 50 and 100 ms
    const store = await createImageStore(join(scratch(), 'images'), 1000, {
      rename: async (from, to) => {
        const code = failures.shift();
        if (code !== undefined) {
          throw Object.assign(new Error(code), { code });
        }
        await rename(from, to);
      },
    });
    await expect(store.save(bytesOf(10), PNG)).resolves.toMatch(/\.png$/u);
    expect(failures).toHaveLength(0);
  });

  it('removes its temporary file when the rename keeps failing', async () => {
    const store = await createImageStore(join(scratch(), 'images'), 1000, {
      sleep: () => Promise.resolve(),
      rename: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    });
    await expect(store.save(bytesOf(10), PNG)).rejects.toThrow('EACCES');
    expect(await readdir(store.dir)).toStrictEqual([]);
  });

  it('evicts an abandoned temporary file, but not one another process may still write', async () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    const store = await createImageStore(join(scratch(), 'images'), 150, { now: () => now });
    const old = join(store.dir, 'img-20261025T090000Z-aaaaaaaaaaaaaaaa.png.tmp');
    const young = join(store.dir, 'img-20261025T095959Z-bbbbbbbbbbbbbbbb.png.tmp');
    await writeFile(old, bytesOf(100));
    await writeFile(young, bytesOf(100));
    await utimes(old, (now - 3_600_000) / 1000, (now - 3_600_000) / 1000);
    await utimes(young, (now - 1000) / 1000, (now - 1000) / 1000);
    await store.save(bytesOf(10), PNG);
    const left = await readdir(store.dir);
    expect(left).not.toContain('img-20261025T090000Z-aaaaaaaaaaaaaaaa.png.tmp');
    expect(left).toContain('img-20261025T095959Z-bbbbbbbbbbbbbbbb.png.tmp');
  });
});
