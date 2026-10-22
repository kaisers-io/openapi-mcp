import { describe, expect, it } from 'vitest';
import {
  LOCK_STALE_MS,
  MAX_AGE_DURATION_MS,
  MAX_DURATION_MS,
  cacheLayout,
  hashContent,
  parseAgeDuration,
  parseDuration,
  promoteCandidate,
  writeAccepted,
  writeCandidate,
} from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

// #88: three small cache cleanups.

describe('--ttl is an age, not a timer (#88 item 1)', () => {
  it('accepts TTLs beyond the Node timer limit, up to a year', () => {
    expect(parseAgeDuration('30d')).toBe(30 * 86_400_000);
    expect(parseAgeDuration('90d')).toBe(90 * 86_400_000);
    expect(parseAgeDuration('365d')).toBe(MAX_AGE_DURATION_MS);
    expect(MAX_AGE_DURATION_MS).toBeGreaterThan(MAX_DURATION_MS);
  });

  it('still rejects zero, garbage and more than a year', () => {
    for (const raw of ['0s', '-1d', '1w', '366d', `${'9'.repeat(30)}d`]) {
      expect(() => parseAgeDuration(raw)).toThrow(/invalid duration/u);
    }
  });

  it('keeps the timer limit for real timers (--timeout)', () => {
    expect(() => parseDuration('30d')).toThrow(/Node timer limit/u);
    expect(parseDuration('24d')).toBe(24 * 86_400_000);
  });
});

describe('orphaned temp files in the entry directory are collected (#88 item 2)', () => {
  const LAYOUT = cacheLayout('/cache', 'abcdef0123456789');
  const UUID_A = '11111111-1111-1111-1111-111111111111';
  const UUID_B = '22222222-2222-2222-2222-222222222222';
  const NOW = 10_000_000;

  const input = (fetchedAt: number): Parameters<typeof writeAccepted>[2] => ({
    document: { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} },
    sourceContentHash: hashContent('s'),
    displaySource: 'https://api.example.com/openapi.json',
    title: 't',
    specVersion: '1',
    fetchedAt,
    expected: 'unchecked',
  });

  // A crash between a temp write and its rename leaves these behind
  const plant = async (fs: MemoryCacheFs, mtimes: Record<string, number>): Promise<void> => {
    await fs.mkdirSecure(LAYOUT.objectsDir);
    for (const name of Object.keys(mtimes)) {
      fs.files.set(`${LAYOUT.dir}/${name}`, 'x');
    }
    fs.modifiedAtMs = (path) => {
      const name = path.slice(LAYOUT.dir.length + 1);
      const at = mtimes[name];
      return at === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(at);
    };
  };

  const entryNames = (fs: MemoryCacheFs): readonly string[] =>
    [...fs.files.keys()]
      .filter((key) => key.startsWith(`${LAYOUT.dir}/`) && !key.startsWith(`${LAYOUT.objectsDir}/`))
      .map((key) => key.slice(LAYOUT.dir.length + 1))
      .toSorted();

  it('removes meta temps and stale lock temps after a commit, and nothing else', async () => {
    const fs = memoryCacheFs();
    await plant(fs, {
      [`.meta.json.${UUID_A}.tmp`]: NOW,
      [`.lock.${UUID_A}.tmp`]: NOW - LOCK_STALE_MS - 1,
      // A lock temp this young may belong to a process about to link() it
      [`.lock.${UUID_B}.tmp`]: NOW - 1000,
      // Not ours: wrong shape, so never touched
      [`.meta.json.${UUID_A}.tmp.keep`]: 0,
      'notes.txt': 0,
      [`.other.${UUID_A}.tmp`]: 0,
    });
    await writeAccepted(LAYOUT, fs, input(NOW));
    expect(entryNames(fs)).toStrictEqual([
      `.lock.${UUID_B}.tmp`,
      `.meta.json.${UUID_A}.tmp.keep`,
      `.other.${UUID_A}.tmp`,
      'meta.json',
      'notes.txt',
    ]);
  });

  it('collects on every commit path (candidate, promote)', async () => {
    const fs = memoryCacheFs();
    await writeAccepted(LAYOUT, fs, input(NOW));
    await plant(fs, { [`.meta.json.${UUID_A}.tmp`]: NOW });
    await writeCandidate(LAYOUT, fs, {
      document: { openapi: '3.1.0', info: { title: 't', version: '2' }, paths: { '/a': {} } },
      sourceContentHash: hashContent('s2'),
      title: 't',
      specVersion: '2',
      fetchedAt: NOW + 1,
      expected: 'unchecked',
    });
    expect(entryNames(fs)).not.toContain(`.meta.json.${UUID_A}.tmp`);
    await plant(fs, { [`.meta.json.${UUID_B}.tmp`]: NOW });
    await promoteCandidate(LAYOUT, fs, NOW + 2, {});
    expect(entryNames(fs)).not.toContain(`.meta.json.${UUID_B}.tmp`);
  });

  it('leaves lock temps alone when the filesystem cannot report their age', async () => {
    const fs = memoryCacheFs();
    await fs.mkdirSecure(LAYOUT.objectsDir);
    fs.files.set(`${LAYOUT.dir}/.lock.${UUID_A}.tmp`, 'x');
    fs.files.set(`${LAYOUT.dir}/.meta.json.${UUID_A}.tmp`, 'x');
    await writeAccepted(LAYOUT, fs, input(NOW));
    expect(entryNames(fs)).toStrictEqual([`.lock.${UUID_A}.tmp`, 'meta.json']);
  });
});
