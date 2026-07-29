import { describe, expect, it } from 'vitest';
import { LOCK_STALE_MS, cacheLayout, unlockNamespace, withNamespaceLock } from '../src/index.ts';
import { type MemoryCacheFs, memoryCacheFs } from './helpers/cache-fs.ts';

const LAYOUT = cacheLayout('/cache', 'abcdef0123456789');

describe('withNamespaceLock', () => {
  it('creates the namespace directory, holds the lock, and releases it', async () => {
    const fs = memoryCacheFs();
    const result = await withNamespaceLock(LAYOUT, fs, 1000, async () => {
      expect(await fs.pathExists(LAYOUT.lockPath)).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(fs.dirs.has(LAYOUT.dir)).toBe(true);
    expect(await fs.pathExists(LAYOUT.lockPath)).toBe(false);
  });

  it('records the holder as a JSON object with an owner token and a timestamp', async () => {
    const fs = memoryCacheFs();
    await withNamespaceLock(LAYOUT, fs, 1234, () => {
      const record = JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '') as {
        owner: string;
        acquiredAt: number;
      };
      expect(record.acquiredAt).toBe(1234);
      expect(record.owner).toMatch(/^[0-9a-f-]{36}$/u);
      return Promise.resolve();
    });
  });

  it('refuses a second holder while the lock is live', async () => {
    const fs = memoryCacheFs();
    await withNamespaceLock(LAYOUT, fs, 1000, async () => {
      await expect(
        withNamespaceLock(LAYOUT, fs, 1000, () => Promise.resolve('inner')),
      ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    });
  });

  it('names the namespace but nothing else in the contention message', async () => {
    const fs = memoryCacheFs();
    await withNamespaceLock(LAYOUT, fs, 1000, async () => {
      await expect(
        withNamespaceLock(LAYOUT, fs, 1000, () => Promise.resolve(0)),
      ).rejects.toThrowError(new RegExp(LAYOUT.namespace, 'u'));
    });
  });

  it('still contends one millisecond before the staleness threshold', async () => {
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'dead', acquiredAt: 0 }));
    await expect(
      withNamespaceLock(LAYOUT, fs, LOCK_STALE_MS - 1, () => Promise.resolve('ok')),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does NOT break a lock held past LOCK_STALE_MS — staleness is not a licence', async () => {
    // A naive implementation might acquire once the lock looks stale; that is
    // unsafe — see the three-owner case below for why.
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'dead', acquiredAt: 0 }));
    await expect(
      withNamespaceLock(LAYOUT, fs, LOCK_STALE_MS * 10, () => Promise.resolve('ok')),
    ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    // The incumbent record is untouched — nothing was deleted on the way out
    expect(JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '')).toMatchObject({ owner: 'dead' });
  });

  it('names cache unlock as the recovery path once the lock looks stale', async () => {
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'dead', acquiredAt: 0 }));
    await expect(
      withNamespaceLock(LAYOUT, fs, LOCK_STALE_MS * 2, () => Promise.resolve('ok')),
    ).rejects.toThrowError(/cache unlock/u);
  });

  it('contends on an unparsable or malformed lock file rather than assuming it is dead', async () => {
    // A record that cannot be read carries NO expiry evidence. Treating that
    // as stale and acquiring would be unsafe; absent evidence, the safe
    // reading is that someone holds it.
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, 'not json at all');
    await expect(
      withNamespaceLock(LAYOUT, fs, 1, () => Promise.resolve('ok')),
    ).rejects.toMatchObject({ code: 'conflict' });
    const other = memoryCacheFs();
    await other.mkdirSecure(LAYOUT.dir);
    await other.createExclusive(LAYOUT.lockPath, JSON.stringify({ acquiredAt: 'soon' }));
    await expect(
      withNamespaceLock(LAYOUT, other, 1, () => Promise.resolve('ok')),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never deletes a third party live lock — the three-owner takeover race', async () => {
    // This is the exact interleaving that made automatic stale breaking unsafe,
    // driven deterministically rather than by timing:
    //   1. A holds a lock whose record is already older than LOCK_STALE_MS
    //   2. B observes A's stale record and decides it may take over
    //   3. C removes A's record and acquires a FRESH lock of its own
    //   4. B proceeds — and an unsafe implementation would unlink C's live lock
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'A', acquiredAt: 0 }));

    // Step 3, performed before B is allowed to act
    await fs.removeFile(LAYOUT.lockPath);
    await fs.createExclusive(
      LAYOUT.lockPath,
      JSON.stringify({ owner: 'C', acquiredAt: LOCK_STALE_MS * 5 }),
    );

    // Step 4: B must fail, and C's lock must survive byte for byte
    await expect(
      withNamespaceLock(LAYOUT, fs, LOCK_STALE_MS * 5, () => Promise.resolve('B ran')),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '')).toMatchObject({ owner: 'C' });
  });

  it('releases the lock when the guarded work throws', async () => {
    const fs = memoryCacheFs();
    await expect(
      withNamespaceLock(LAYOUT, fs, 1000, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrowError('boom');
    expect(await fs.pathExists(LAYOUT.lockPath)).toBe(false);
  });

  it('does not delete a lock that a different holder now owns', async () => {
    // A process that legitimately broke a stale lock must not then delete the
    // fresh lock a third process took while it was running — this is what the
    // owner token buys that a pid could not (pids are reused)
    const fs = memoryCacheFs();
    await withNamespaceLock(LAYOUT, fs, 1000, async () => {
      await fs.removeFile(LAYOUT.lockPath);
      await fs.createExclusive(
        LAYOUT.lockPath,
        JSON.stringify({ owner: 'someone-else', acquiredAt: 2000 }),
      );
    });
    expect(await fs.pathExists(LAYOUT.lockPath)).toBe(true);
  });

  it('exposes the documented staleness window', () => {
    expect(LOCK_STALE_MS).toBe(60_000);
  });

  it('propagates a non-absence read failure hit during contention instead of reporting a conflict', async () => {
    // An EACCES/EIO on the lock file carries no absence-or-malformed evidence
    // at all — it must not be folded into the "someone else holds it" story.
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner: 'other', acquiredAt: 0 }));
    fs.readFileTextCapped = (path) => {
      if (path === LAYOUT.lockPath) {
        return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      }
      return Promise.reject(new Error('unexpected path'));
    };
    await expect(
      withNamespaceLock(LAYOUT, fs, 1000, () => Promise.resolve('ok')),
    ).rejects.toMatchObject({ code: 'validation', exitCode: 3 });
  });

  it('propagates a non-absence read failure hit while releasing instead of completing silently', async () => {
    const fs = memoryCacheFs();
    await expect(
      withNamespaceLock(LAYOUT, fs, 1000, () => {
        // Fails only once acquisition is done and the guarded work is running,
        // so this exercises the release-time readLockHolder call, not the
        // contention one.
        fs.readFileTextCapped = (path) => {
          if (path === LAYOUT.lockPath) {
            return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
          }
          return Promise.reject(new Error('unexpected path'));
        };
        return Promise.resolve('ok');
      }),
    ).rejects.toMatchObject({ code: 'validation', exitCode: 3 });
  });
});

describe('unlockNamespace — the explicit recovery path', () => {
  const held = async (acquiredAt: number, owner = 'dead'): Promise<MemoryCacheFs> => {
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, JSON.stringify({ owner, acquiredAt }));
    return fs;
  };

  it('removes a lock held past the staleness window and reports its age', async () => {
    const fs = await held(0);
    await expect(unlockNamespace(LAYOUT, fs, LOCK_STALE_MS, { force: false })).resolves.toEqual({
      heldForMs: LOCK_STALE_MS,
    });
    expect(await fs.pathExists(LAYOUT.lockPath)).toBe(false);
  });

  it('refuses a lock that is not known to be stale without --force', async () => {
    const fs = await held(0);
    await expect(
      unlockNamespace(LAYOUT, fs, LOCK_STALE_MS - 1, { force: false }),
    ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    expect(await fs.pathExists(LAYOUT.lockPath)).toBe(true);
  });

  it('removes a fresh lock only under --force', async () => {
    const fs = await held(0);
    await expect(unlockNamespace(LAYOUT, fs, 1, { force: true })).resolves.toMatchObject({
      heldForMs: 1,
    });
    expect(await fs.pathExists(LAYOUT.lockPath)).toBe(false);
  });

  it('refuses an unreadable record without --force, because it proves no age', async () => {
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await fs.createExclusive(LAYOUT.lockPath, 'not json');
    await expect(
      unlockNamespace(LAYOUT, fs, LOCK_STALE_MS * 100, { force: false }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      unlockNamespace(LAYOUT, fs, LOCK_STALE_MS * 100, { force: true }),
    ).resolves.toBeDefined();
  });

  it('reports not-found when there is no lock at all', async () => {
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.dir);
    await expect(unlockNamespace(LAYOUT, fs, 1, { force: true })).rejects.toMatchObject({
      code: 'not_found',
      exitCode: 4,
    });
  });

  it('lets a writer back in once the lock is released', async () => {
    const fs = await held(0);
    await unlockNamespace(LAYOUT, fs, LOCK_STALE_MS, { force: false });
    await expect(
      withNamespaceLock(LAYOUT, fs, LOCK_STALE_MS, () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });

  it('does not remove the lock file when the holder read fails with a non-absence error', async () => {
    // Even under --force this must not proceed to the unlink: a non-absence
    // read failure is not evidence of anything, staleness included.
    const fs = await held(0);
    fs.readFileTextCapped = (path) => {
      if (path === LAYOUT.lockPath) {
        return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      }
      return Promise.reject(new Error('unexpected path'));
    };
    await expect(
      unlockNamespace(LAYOUT, fs, LOCK_STALE_MS * 100, { force: true }),
    ).rejects.toMatchObject({ code: 'validation', exitCode: 3 });
    expect(await fs.pathExists(LAYOUT.lockPath)).toBe(true);
  });
});

describe('memoryCacheFs createExclusive (fidelity to the real "wx" open)', () => {
  it('refuses a path that already exists as a directory, not just as a file', async () => {
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.lockPath);
    await expect(fs.createExclusive(LAYOUT.lockPath, 'data')).resolves.toBe(false);
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
  });
});
