import { describe, expect, it } from 'vitest';
import {
  LOCK_RETRY_DELAYS_MS,
  LOCK_STALE_MS,
  cacheLayout,
  describeLockHolder,
  tryWithNamespaceLock,
  unlockNamespace,
  withNamespaceLock,
} from '../src/index.ts';
import type { CacheRuntime } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

// #65: bounded retry for strict writers, a single-attempt best-effort variant,
// and a lock record that says who holds it.
const LAYOUT = cacheLayout('/cache', 'abcdef0123456789');

const fakeRuntime = (over: Partial<CacheRuntime> = {}): CacheRuntime & { slept: number[] } => {
  const slept: number[] = [];
  return {
    pid: 4242,
    hostname: 'build-host',
    isProcessAlive: () => true,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    slept,
    ...over,
  };
};

const withRuntime = (runtime: CacheRuntime): MemoryCacheFs => {
  const fs = memoryCacheFs();
  fs.runtime = runtime;
  return fs;
};

const plantLock = async (fs: MemoryCacheFs, record: Record<string, unknown>): Promise<void> => {
  await fs.mkdirSecure(LAYOUT.dir);
  await fs.createExclusive(LAYOUT.lockPath, JSON.stringify(record));
};

describe('lock record identity', () => {
  it('records pid and hostname from the injected runtime', async () => {
    const fs = withRuntime(fakeRuntime());
    await withNamespaceLock(LAYOUT, fs, 1000, () => {
      expect(JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '')).toMatchObject({
        acquiredAt: 1000,
        pid: 4242,
        hostname: 'build-host',
      });
      return Promise.resolve();
    });
  });

  it('records neither without a runtime (a fake filesystem, or an older writer)', async () => {
    const fs = memoryCacheFs();
    await withNamespaceLock(LAYOUT, fs, 1000, () => {
      const record = JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '') as Record<string, unknown>;
      expect(Object.keys(record).toSorted()).toStrictEqual(['acquiredAt', 'owner']);
      return Promise.resolve();
    });
  });
});

describe('strict acquisition: bounded retry with jittered backoff', () => {
  it('serializes behind a short-lived holder instead of failing', async () => {
    const runtime = fakeRuntime();
    const fs = withRuntime(runtime);
    await plantLock(fs, { owner: 'other', acquiredAt: 1000 });
    // The holder releases while we back off for the third time
    const { sleep } = runtime;
    runtime.sleep = async (ms) => {
      await sleep(ms);
      if (runtime.slept.length === 3) {
        fs.files.delete(LAYOUT.lockPath);
      }
    };
    expect(await withNamespaceLock(LAYOUT, fs, 1000, () => Promise.resolve('ran'))).toBe('ran');
    expect(runtime.slept).toHaveLength(3);
    // Equal jitter: every wait lies in [delay/2, delay]
    runtime.slept.forEach((ms, index) => {
      const delay = LOCK_RETRY_DELAYS_MS[index]!;
      expect(ms).toBeGreaterThanOrEqual(delay / 2);
      expect(ms).toBeLessThanOrEqual(delay);
    });
  });

  it('gives up with exit 5 once the schedule (at most ~2 s) is spent', async () => {
    const runtime = fakeRuntime();
    const fs = withRuntime(runtime);
    await plantLock(fs, { owner: 'other', acquiredAt: 1000 });
    await expect(
      withNamespaceLock(LAYOUT, fs, 1000, () => Promise.resolve('ran')),
    ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    expect(runtime.slept).toHaveLength(LOCK_RETRY_DELAYS_MS.length);
    const worstCase = LOCK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(worstCase).toBeLessThanOrEqual(2000);
    // Nothing was taken over: the holder's record is untouched
    expect(JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '')).toMatchObject({ owner: 'other' });
  });

  it('never takes over a stale lock, however old, even with a dead owner on this host', async () => {
    const runtime = fakeRuntime({ isProcessAlive: () => false });
    const fs = withRuntime(runtime);
    await plantLock(fs, { owner: 'dead', acquiredAt: 0, pid: 99, hostname: 'build-host' });
    await expect(
      withNamespaceLock(LAYOUT, fs, LOCK_STALE_MS * 100, () => Promise.resolve('ran')),
    ).rejects.toThrow(/held by pid 99 on this host, process not running.*cache unlock/u);
    expect(JSON.parse(fs.files.get(LAYOUT.lockPath) ?? '')).toMatchObject({ owner: 'dead' });
  });
});

describe('the recovery hint matches what cache unlock accepts', () => {
  it.each([
    [{ acquiredAt: 1000 }, true, ' — retry once it finishes'],
    [
      { acquiredAt: 1000, pid: 9, hostname: 'build-host' },
      false,
      ', or run "openapi-mcp cache unlock --force" if the owning process is gone',
    ],
    [
      { acquiredAt: 1000 - LOCK_STALE_MS },
      true,
      ', or run "openapi-mcp cache unlock" if the owning process is gone',
    ],
  ])('%o (owner alive: %s)', async (record, alive, tail) => {
    const fs = withRuntime(fakeRuntime({ isProcessAlive: () => alive }));
    await plantLock(fs, { owner: 'x', ...record });
    const result = await tryWithNamespaceLock(LAYOUT, fs, 1000, () => Promise.resolve());
    expect(result.acquired).toBe(false);
    expect(result.acquired ? '' : result.message.endsWith(tail)).toBe(true);
  });
});

describe('best-effort acquisition (tryWithNamespaceLock)', () => {
  it('makes one attempt, never sleeps, and reports a held lock as a value', async () => {
    const runtime = fakeRuntime();
    const fs = withRuntime(runtime);
    await plantLock(fs, { owner: 'other', acquiredAt: 0, pid: 7, hostname: 'build-host' });
    let ran = false;
    const result = await tryWithNamespaceLock(LAYOUT, fs, LOCK_STALE_MS * 60, () => {
      ran = true;
      return Promise.resolve();
    });
    expect(ran).toBe(false);
    expect(runtime.slept).toStrictEqual([]);
    expect(result).toStrictEqual({
      acquired: false,
      message: `cache entry ${LAYOUT.namespace} is locked by another openapi-mcp process (held by pid 7 on this host, process running, held for 3600s) — retry once it finishes, or run "openapi-mcp cache unlock" if the owning process is gone`,
    });
  });

  it('runs and releases like the strict lock when the lock is free', async () => {
    const fs = withRuntime(fakeRuntime());
    const result = await tryWithNamespaceLock(LAYOUT, fs, 1, () => Promise.resolve(42));
    expect(result).toStrictEqual({ acquired: true, value: 42 });
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
  });
});

describe('describeLockHolder', () => {
  const runtime = fakeRuntime({ isProcessAlive: (pid) => pid === 1 });

  it.each([
    [{}, undefined],
    [{ pid: 5 }, 'held by pid 5'],
    [{ pid: 5, hostname: 'elsewhere' }, 'held by pid 5 on host elsewhere'],
    [{ pid: 1, hostname: 'build-host' }, 'held by pid 1 on this host, process running'],
    [{ pid: 5, hostname: 'build-host' }, 'held by pid 5 on this host, process not running'],
  ])('%o -> %s', (holder, expected) => {
    expect(describeLockHolder(holder, runtime)).toBe(expected);
  });

  it('never consults the process table for a pid recorded on another host', () => {
    let probed = false;
    const probe = fakeRuntime({
      isProcessAlive: () => {
        probed = true;
        return false;
      },
    });
    expect(describeLockHolder({ pid: 5, hostname: 'other' }, probe)).toBe(
      'held by pid 5 on host other',
    );
    expect(probed).toBe(false);
  });

  it('drops a hostname or pid from the record that is not well-formed (no terminal injection)', async () => {
    const fs = withRuntime(fakeRuntime());
    await plantLock(fs, {
      owner: 'x',
      acquiredAt: 0,
      pid: -3,
      hostname: '\u001B[31mevil\u001B[0m',
    });
    const result = await tryWithNamespaceLock(LAYOUT, fs, 1, () => Promise.resolve());
    expect(result.acquired).toBe(false);
    expect(JSON.stringify(result)).not.toContain('evil');
    expect(JSON.stringify(result)).not.toContain('pid');
  });
});

describe('cache unlock reports the holder', () => {
  it('names a dead owner on this host but still requires age or --force', async () => {
    const fs = withRuntime(fakeRuntime({ isProcessAlive: () => false }));
    await plantLock(fs, { owner: 'x', acquiredAt: 1000, pid: 99, hostname: 'build-host' });
    await expect(unlockNamespace(LAYOUT, fs, 2000, { force: false })).rejects.toThrow(
      /\(held by pid 99 on this host, process not running\) is not known to be stale/u,
    );
    expect(await unlockNamespace(LAYOUT, fs, 2000, { force: true })).toStrictEqual({
      heldForMs: 1000,
      holder: 'held by pid 99 on this host, process not running',
    });
    expect(fs.files.has(LAYOUT.lockPath)).toBe(false);
  });
});
