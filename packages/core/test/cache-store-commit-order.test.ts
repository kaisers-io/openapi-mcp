import { describe, expect, it } from 'vitest';
import {
  cacheLayout,
  hashContent,
  objectPath,
  promoteCandidate,
  writeAccepted,
  writeCandidate,
} from '../src/index.ts';
import type { CacheFs } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';

const LAYOUT = cacheLayout('/cache', 'abcdef0123456789');

// The real adapter fsyncs inside writeFileAtomic before it resolves
// (kaisers-io/openapi-mcp-archive#69), so the store's commit is crash-ordered
// ONLY IF every object write has fully RESOLVED before the meta.json write
// STARTS. Each write here yields to the event loop before completing, so a
// commit that fired its writes concurrently (Promise.all, or a missing await)
// would interleave and fail this check, while a strictly sequential commit
// cannot.
const recordingFs = (): { fs: CacheFs; events: string[] } => {
  const inner = memoryCacheFs();
  const events: string[] = [];
  const fs: CacheFs = {
    ...inner,
    writeFileAtomic: async (path, data) => {
      const label = path === LAYOUT.metaPath ? 'meta' : 'object';
      events.push(`start ${label}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      await inner.writeFileAtomic(path, data);
      events.push(`end ${label}`);
    },
  };
  return { fs, events };
};

const assertObjectsDurableBeforeMeta = (events: readonly string[]): void => {
  const metaStart = events.indexOf('start meta');
  expect(metaStart).toBeGreaterThan(-1);
  // Every object write started before meta.json has also ENDED before it
  const before = events.slice(0, metaStart);
  expect(before.filter((event) => event === 'start object')).toHaveLength(
    before.filter((event) => event === 'end object').length,
  );
  // And no object write starts after the meta.json write began
  expect(events.slice(metaStart).some((event) => event.endsWith('object'))).toBe(false);
};

describe('commit ordering (objects durable before meta.json)', () => {
  it('writeAccepted, writeCandidate and promoteCandidate finish every object write before meta.json', async () => {
    const { fs, events } = recordingFs();
    await writeAccepted(LAYOUT, fs, {
      document: { openapi: '3.1.0', info: { title: 'v1', version: '1' }, paths: {} },
      sourceContentHash: hashContent('source-v1'),
      displaySource: 'https://api.example.com/openapi.json',
      title: 'v1',
      specVersion: '1',
      fetchedAt: 1,
      expected: 'unchecked',
    });
    expect(events).toContain('start object');
    assertObjectsDurableBeforeMeta(events);

    events.length = 0;
    const { candidateContentHash } = await writeCandidate(LAYOUT, fs, {
      document: { openapi: '3.1.0', info: { title: 'v2', version: '2' }, paths: { '/a': {} } },
      sourceContentHash: hashContent('source-v2'),
      title: 'v2',
      specVersion: '2',
      fetchedAt: 2,
      expected: 'unchecked',
    });
    expect(await fs.pathExists(objectPath(LAYOUT, candidateContentHash))).toBe(true);
    expect(events).toContain('start object');
    assertObjectsDurableBeforeMeta(events);

    events.length = 0;
    await promoteCandidate(LAYOUT, fs, 3, {});
    assertObjectsDurableBeforeMeta(events);
  });
});
