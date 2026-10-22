import { describe, expect, it } from 'vitest';
import { readLockHolder } from '../src/cache/lock-holder.ts';
import type { CacheFs } from '../src/cache/fs.ts';
import type { CacheLayout } from '../src/cache/paths.ts';

// The lock record is untrusted input (issue #86 floors): absent and
// malformed records carry no holder, an unreadable one is not mistaken for
// absent.
const layout = { lockPath: '/cache/entry/lock' } as CacheLayout;

const fsReading = (read: () => Promise<string>): CacheFs =>
  ({ readFileTextCapped: read }) as unknown as CacheFs;

const errorWithCode = (code: string): Error => Object.assign(new Error(code), { code });

describe('readLockHolder', () => {
  it('returns undefined for an absent lock file', async () => {
    const fs = fsReading(() => Promise.reject(errorWithCode('ENOENT')));
    await expect(readLockHolder(layout, fs)).resolves.toBeUndefined();
  });

  it('propagates a read failure that is not an absence', async () => {
    const fs = fsReading(() => Promise.reject(errorWithCode('EACCES')));
    await expect(readLockHolder(layout, fs)).rejects.toThrow('EACCES');
  });

  it.each([
    ['JSON null', 'null'],
    ['a JSON string', '"owner"'],
    ['a fractional acquiredAt', '{"owner":"o","acquiredAt":1.5}'],
    ['an unsafe acquiredAt', `{"owner":"o","acquiredAt":${String(2 ** 60)}}`],
  ])('returns undefined for %s', async (_label, text) => {
    await expect(
      readLockHolder(
        layout,
        fsReading(() => Promise.resolve(text)),
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps only a plausible pid and hostname', async () => {
    const text = '{"owner":"o","acquiredAt":5,"pid":-1,"hostname":"bad host\\n"}';
    await expect(
      readLockHolder(
        layout,
        fsReading(() => Promise.resolve(text)),
      ),
    ).resolves.toEqual({
      owner: 'o',
      acquiredAt: 5,
    });
  });
});
