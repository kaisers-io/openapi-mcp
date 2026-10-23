import { describe, expect, it } from 'vitest';
import {
  RENAME_RETRY_BUDGET_MS,
  isDirectoryBarrierUnsupported,
  renameReplacing,
} from '../src/context.ts';
import type { RenameDeps } from '../src/context.ts';

// The two Windows behaviours the cache adapter has to absorb, measured on
// windows-latest (Node 24): fsync on a directory handle always fails EPERM, and
// rename() over a file that any process holds open fails EPERM until the
// holder closes it. Both decisions are pure functions of (error, platform), so
// they are pinned here on every runner; the Windows CI job additionally runs
// the real-filesystem suites (context.test.ts, context-durability.test.ts,
// cache-concurrency.test.ts) through them.

const fsError = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code });

describe('isDirectoryBarrierUnsupported', () => {
  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])(
    'tolerates %s on every platform (unchanged)',
    (code) => {
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        expect(isDirectoryBarrierUnsupported(fsError(code), platform)).toBe(true);
      }
    },
  );

  it('reads EPERM as "no directory barrier" on Windows only', () => {
    expect(isDirectoryBarrierUnsupported(fsError('EPERM'), 'win32')).toBe(true);
    expect(isDirectoryBarrierUnsupported(fsError('EPERM'), 'linux')).toBe(false);
    expect(isDirectoryBarrierUnsupported(fsError('EPERM'), 'darwin')).toBe(false);
  });

  it('still propagates a real I/O failure on Windows', () => {
    expect(isDirectoryBarrierUnsupported(fsError('EIO'), 'win32')).toBe(false);
    expect(isDirectoryBarrierUnsupported(fsError('EACCES'), 'win32')).toBe(false);
    expect(isDirectoryBarrierUnsupported(new Error('no code'), 'win32')).toBe(false);
  });
});

// A scripted rename plus a virtual clock: `failures` are thrown in order, then
// the rename succeeds; sleeping advances the clock, nothing really waits
const scripted = (
  platform: NodeJS.Platform,
  failures: readonly Error[],
): { deps: RenameDeps; calls: string[]; sleeps: number[] } => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let index = 0;
  const deps: RenameDeps = {
    platform,
    rename: (from, to) => {
      calls.push(`${from} -> ${to}`);
      const failure = failures[index];
      index += 1;
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { deps, calls, sleeps };
};

describe('renameReplacing', () => {
  it('retries a rename that a reader blocks on Windows, then succeeds', async () => {
    const { deps, calls, sleeps } = scripted('win32', [
      fsError('EPERM'),
      fsError('EACCES'),
      fsError('EBUSY'),
    ]);
    await expect(renameReplacing('a.tmp', 'meta.json', deps)).resolves.toBeUndefined();
    expect(calls).toHaveLength(4);
    expect(sleeps).toStrictEqual([10, 20, 30]);
  });

  it('gives up after the bounded budget and rethrows the last error (fail closed)', async () => {
    const { deps, calls, sleeps } = scripted(
      'win32',
      Array.from({ length: 1000 }, () => fsError('EPERM')),
    );
    await expect(renameReplacing('a.tmp', 'meta.json', deps)).rejects.toMatchObject({
      code: 'EPERM',
    });
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(RENAME_RETRY_BUDGET_MS);
    expect(Math.max(...sleeps)).toBe(100);
    expect(calls.length).toBeLessThan(40);
  });

  it('does not retry an error that a retry cannot fix', async () => {
    const { deps, calls } = scripted('win32', [fsError('ENOENT')]);
    await expect(renameReplacing('a.tmp', 'meta.json', deps)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(calls).toHaveLength(1);
  });

  it.each(['linux', 'darwin'] as const)(
    'makes exactly one attempt on %s, where rename never fails for an open target',
    async (platform) => {
      const { deps, calls, sleeps } = scripted(platform, [fsError('EPERM')]);
      await expect(renameReplacing('a.tmp', 'meta.json', deps)).rejects.toMatchObject({
        code: 'EPERM',
      });
      expect(calls).toHaveLength(1);
      expect(sleeps).toStrictEqual([]);
    },
  );
});
