import { dirname, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HTTP_METHODS, parseFilterPattern, runSpecPipeline } from '../src/index.ts';
import type { SpecPipelineDeps } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

// Issue kaisers-io/openapi-mcp-archive#65: a lock held by another process
// (servers starting together, or a crashed writer) must not fail a run whose
// only write is bookkeeping on an entry it has already verified; writes that
// change what is accepted stay strict.
type SpecFetcher = SpecPipelineDeps['fetcher'];

const opts = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: '/nonexistent',
  allowPrivateNetwork: false,
  deny: [],
  ttlMs: 3_600_000,
  trustSpecUpdates: false,
  cacheRoot: '/cache',
  nowMs: 1000,
  allow: HTTP_METHODS.map((method) => parseFilterPattern(`route:${method.toUpperCase()} /**`)),
};

const remoteSpec = (title: string, extraPath?: string): string =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title, version: '1.0.0' },
    paths: {
      '/things': {
        get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
      },
      ...(extraPath === undefined
        ? {}
        : {
            [extraPath]: {
              get: { operationId: 'listExtra', responses: { '200': { description: 'ok' } } },
            },
          }),
    },
  });

type Reply = { status?: number; body?: string; etag?: string };

const fetcherOf = (replies: readonly Reply[]): SpecFetcher => {
  let index = 0;
  return (() => {
    const reply = replies[Math.min(index, replies.length - 1)]!;
    index += 1;
    return Promise.resolve(
      new Response(reply.status === 304 ? null : (reply.body ?? ''), {
        status: reply.status ?? 200,
        headers: reply.etag === undefined ? {} : { etag: reply.etag },
      }),
    );
  }) as unknown as SpecFetcher;
};

const deps = (cacheFs: MemoryCacheFs, fetcher: SpecFetcher): SpecPipelineDeps => ({
  readFileText: (path: string) => readFile(path, 'utf8'),
  fileSizeBytes: async (path: string) => {
    const stats = await stat(path);
    return stats.size;
  },
  fetcher,
  lookup: () => Promise.resolve(['93.184.216.34']),
  cacheFs,
});

const specUrl = 'https://api.example.com/openapi.json';
const later = opts.nowMs + opts.ttlMs + 1;

// Seeds an accepted entry, then plants a lock "held" by a crashed writer an
// hour ago, next to the intact entry
const seededAndLocked = async (
  fetcher: SpecFetcher,
): Promise<{ fs: MemoryCacheFs; lockPath: string; metaBefore: string }> => {
  const fs = memoryCacheFs();
  await runSpecPipeline(specUrl, opts, deps(fs, fetcher));
  const metaPath = [...fs.files.keys()].find((key) => key.endsWith(`${sep}meta.json`))!;
  const lockPath = metaPath.replace(/meta\.json$/u, '.lock');
  await fs.createExclusive(
    lockPath,
    JSON.stringify({ owner: 'crashed', acquiredAt: later - 3_600_000 }),
  );
  return { fs, lockPath, metaBefore: fs.files.get(metaPath)! };
};

describe('a held writer lock and a verified entry (kaisers-io/openapi-mcp-archive#65)', () => {
  it('a 304 serves the verified baseline with a warning naming cache unlock', async () => {
    const fetcher = fetcherOf([{ body: remoteSpec('Remote'), etag: '"v1"' }, { status: 304 }]);
    const { fs, lockPath, metaBefore } = await seededAndLocked(fetcher);
    const result = await runSpecPipeline(specUrl, { ...opts, nowMs: later }, deps(fs, fetcher));
    expect(result.cacheStatus).toBe('revalidated');
    expect(result.namedOperations.map((named) => named.toolName)).toStrictEqual(['listThings']);
    expect(result.warnings.join('\n')).toMatch(
      /cache metadata not updated, serving the verified baseline: .*held for 3600s.*cache unlock/u,
    );
    // Nothing was written, and the other process's lock is untouched
    expect([...fs.files.values()]).toContain(metaBefore);
    expect(JSON.parse(fs.files.get(lockPath)!)).toMatchObject({ owner: 'crashed' });
    // An aged lock will not clear by itself: surfaced for openapi_mcp_status
    expect(result.cacheLock).toBe('stale');
  });

  it('a lock a live writer took moments ago is reported as held, not stale', async () => {
    const fetcher = fetcherOf([{ body: remoteSpec('Remote'), etag: '"v1"' }, { status: 304 }]);
    const { fs, lockPath } = await seededAndLocked(fetcher);
    await fs.removeFile(lockPath);
    await fs.createExclusive(lockPath, JSON.stringify({ owner: 'busy', acquiredAt: later - 10 }));
    const result = await runSpecPipeline(specUrl, { ...opts, nowMs: later }, deps(fs, fetcher));
    expect(result.cacheLock).toBe('held');
  });

  it('reports no cacheLock when the revalidation was recorded', async () => {
    const fetcher = fetcherOf([{ body: remoteSpec('Remote'), etag: '"v1"' }, { status: 304 }]);
    const fs = memoryCacheFs();
    await runSpecPipeline(specUrl, opts, deps(fs, fetcher));
    const result = await runSpecPipeline(specUrl, { ...opts, nowMs: later }, deps(fs, fetcher));
    expect(result.cacheStatus).toBe('revalidated');
    expect(result).not.toHaveProperty('cacheLock');
  });

  it('an unchanged 200 does the same', async () => {
    const fetcher = fetcherOf([{ body: remoteSpec('Remote') }]);
    const { fs } = await seededAndLocked(fetcher);
    const result = await runSpecPipeline(specUrl, { ...opts, nowMs: later }, deps(fs, fetcher));
    expect(result.cacheStatus).toBe('revalidated');
    expect(result.warnings.join('\n')).toContain('cache metadata not updated');
    expect(result.cacheLock).toBe('stale');
  });

  it('a changed source (a candidate write) still fails closed with exit 5', async () => {
    const fetcher = fetcherOf([
      { body: remoteSpec('Remote') },
      { body: remoteSpec('Remote', '/extra') },
    ]);
    const { fs } = await seededAndLocked(fetcher);
    await expect(
      runSpecPipeline(specUrl, { ...opts, nowMs: later }, deps(fs, fetcher)),
    ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
  });

  it('a changed source under --trust-spec-updates still fails closed with exit 5', async () => {
    const fetcher = fetcherOf([
      { body: remoteSpec('Remote') },
      { body: remoteSpec('Remote', '/extra') },
    ]);
    const { fs } = await seededAndLocked(fetcher);
    await expect(
      runSpecPipeline(
        specUrl,
        { ...opts, nowMs: later, trustSpecUpdates: true },
        deps(fs, fetcher),
      ),
    ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
  });

  it('a strict write waits for a busy lock as long as --timeout allows', async () => {
    // A first use while another process spends ~5 s writing the same large
    // spec: the built-in ~2 s schedule would give up, --timeout 30s does not
    const run = async (timeoutMs: number): Promise<unknown> => {
      const fetcher = fetcherOf([{ body: remoteSpec('Remote') }]);
      const probe = memoryCacheFs();
      await runSpecPipeline(specUrl, opts, deps(probe, fetcher));
      const metaPath = [...probe.files.keys()].find((key) => key.endsWith(`${sep}meta.json`))!;
      const lockPath = metaPath.replace(/meta\.json$/u, '.lock');
      const fs = memoryCacheFs();
      let slept = 0;
      fs.runtime = {
        pid: 1,
        hostname: 'build-host',
        isProcessAlive: () => true,
        sleep: async (ms) => {
          slept += ms;
          if (slept >= 5000) {
            await fs.removeFile(lockPath);
          }
        },
      };
      await fs.mkdirSecure(dirname(lockPath));
      await fs.createExclusive(lockPath, JSON.stringify({ owner: 'busy', acquiredAt: 1000 }));
      return runSpecPipeline(specUrl, { ...opts, timeoutMs }, deps(fs, fetcher));
    };
    await expect(run(30_000)).resolves.toMatchObject({ cacheStatus: 'accepted-first' });
    await expect(run(1000)).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
  });

  it('a first use (no verified entry) still fails closed with exit 5', async () => {
    const fs = memoryCacheFs();
    // Lock planted before anything was ever accepted
    const fetcher = fetcherOf([{ body: remoteSpec('Remote') }]);
    const probe = memoryCacheFs();
    await runSpecPipeline(specUrl, opts, deps(probe, fetcher));
    const dir = [...probe.files.keys()].find((key) => key.endsWith(`${sep}meta.json`))!;
    await fs.mkdirSecure(dirname(dir));
    await fs.createExclusive(
      dir.replace(/meta\.json$/u, '.lock'),
      JSON.stringify({ owner: 'other', acquiredAt: 0 }),
    );
    await expect(runSpecPipeline(specUrl, opts, deps(fs, fetcher))).rejects.toMatchObject({
      code: 'conflict',
      exitCode: 5,
    });
  });
});
