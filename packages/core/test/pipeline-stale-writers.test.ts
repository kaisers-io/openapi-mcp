import { basename, dirname, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HTTP_METHODS,
  clearNamespace,
  parseFilterPattern,
  promoteCandidate,
  runSpecPipeline,
  touchRevalidated,
  cacheLayout,
} from '../src/index.ts';
import type { CacheLayout, CacheMeta, SpecPipelineDeps, SpecPipelineResult } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';
import type { MemoryCacheFs } from './helpers/cache-fs.ts';

// Issue kaisers-io/openapi-mcp-archive#34: a writer must not commit a decision
// made against a revision that is no longer current. Every interleaving below
// is forced with explicit barriers: a run is parked INSIDE its fetch (after it
// has read the cache, before it commits), the competing operation runs to
// completion, and only then is the parked fetch released. No timing sleeps are
// involved.
//
// A run whose commit meets a changed revision re-reads the entry ONCE and
// re-makes its decision against what is current, with the bytes it already
// fetched (no refetch); only a second conflict exits 5. So most interleavings
// below end the way running the command again would, never with a decision
// committed against a revision the run did not see.
type SpecFetcher = SpecPipelineDeps['fetcher'];

const spec = (title: string, extraPath?: string): string =>
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

const A = spec('A');
const B = spec('B', '/b');
const C = spec('C', '/c');
const D = spec('D', '/d');
const E = spec('E', '/e');

type Reply = { status?: 304; body?: string; etag?: string };

const reply = (r: Reply): Response =>
  new Response(r.status === 304 ? null : (r.body ?? ''), {
    status: r.status ?? 200,
    headers: r.etag === undefined ? {} : { etag: r.etag },
  });

// Always answers `r` at once
const answering = (r: Reply): SpecFetcher =>
  (() => Promise.resolve(reply(r))) as unknown as SpecFetcher;

// Answers `r`, but only once release() is called; `entered` resolves when the
// run has reached its fetch (i.e. has already read the cache entry)
const parked = (
  r: Reply,
): { fetcher: SpecFetcher; entered: Promise<void>; release: () => void } => {
  let markEntered: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = (async () => {
    markEntered();
    await gate;
    return reply(r);
  }) as unknown as SpecFetcher;
  return { fetcher, entered, release };
};

const URL_SOURCE = 'https://api.example.com/openapi.json';

const opts = {
  specHeaders: [],
  timeoutMs: 30_000,
  cwd: '/nonexistent',
  allowPrivateNetwork: false,
  deny: [],
  ttlMs: 1000,
  trustSpecUpdates: false,
  cacheRoot: '/cache',
  nowMs: 10_000,
  allow: HTTP_METHODS.map((method) => parseFilterPattern(`${method.toUpperCase()} /**`)),
};

const deps = (cacheFs: MemoryCacheFs, fetcher: SpecFetcher): SpecPipelineDeps => ({
  readFileText: () => Promise.reject(new Error('no files')),
  fileSizeBytes: () => Promise.reject(new Error('no files')),
  fetcher,
  lookup: () => Promise.resolve(['93.184.216.34']),
  cacheFs,
});

// Each run happens "later" than the previous one and past the TTL
const time = { now: 10_000 };
const run = (
  fs: MemoryCacheFs,
  fetcher: SpecFetcher,
  over: Partial<typeof opts> = {},
): Promise<SpecPipelineResult> => {
  time.now += 5000;
  return runSpecPipeline(URL_SOURCE, { ...opts, nowMs: time.now, ...over }, deps(fs, fetcher));
};

const layoutOf = (fs: MemoryCacheFs): CacheLayout => {
  const metaPath = [...fs.files.keys()].find((key) => key.endsWith(`${sep}meta.json`))!;
  return cacheLayout('/cache', basename(dirname(metaPath)));
};
const metaOf = (fs: MemoryCacheFs): CacheMeta | undefined => {
  const entry = [...fs.files.entries()].find(([key]) => key.endsWith(`${sep}meta.json`));
  return entry === undefined ? undefined : (JSON.parse(entry[1]) as CacheMeta);
};

// Accepted C via the regular route: a candidate, then an explicit promote
const promoteTo = async (fs: MemoryCacheFs, body: string): Promise<void> => {
  const staged = await run(fs, answering({ body, etag: '"promoted"' }));
  expect(staged.cacheStatus).toBe('candidate');
  time.now += 1;
  await promoteCandidate(layoutOf(fs), fs, time.now, {});
};

describe('stale writers cannot overwrite an accepted revision (kaisers-io/openapi-mcp-archive#34)', () => {
  it('interleaving 1: two first-use loads — the second, different spec does not become accepted', async () => {
    const fs = memoryCacheFs();
    const second = parked({ body: B });
    const pending = run(fs, second.fetcher);
    await second.entered; // B saw an empty namespace
    const first = await run(fs, answering({ body: A }));
    expect(first.cacheStatus).toBe('accepted-first');
    second.release();
    // Re-decided against accepted A: B is a change, so it waits as a candidate
    const late = await pending;
    expect(late.cacheStatus).toBe('candidate');
    expect(late.spec.title).toBe('A');
    expect(metaOf(fs)?.title).toBe('A');
    expect(metaOf(fs)?.candidate?.title).toBe('B');
  });

  it('two first-use loads of the SAME spec both succeed (no needless conflict)', async () => {
    const fs = memoryCacheFs();
    const second = parked({ body: A });
    const pending = run(fs, second.fetcher);
    await second.entered;
    await run(fs, answering({ body: A }));
    second.release();
    const late = await pending;
    expect(late.cacheStatus).toBe('accepted-first');
    expect(metaOf(fs)?.title).toBe('A');
  });

  it('interleaving 2: a refresh paused across stage+promote does not move the baseline back', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B, etag: '"b"' }));
    // The refresh sees accepted B and parks, about to learn B is unchanged
    const refresh = parked({ body: B, etag: '"b2"' });
    const pending = run(fs, refresh.fetcher);
    await refresh.entered;
    await promoteTo(fs, C);
    const promoted = metaOf(fs)!;
    expect(promoted.title).toBe('C');
    refresh.release();
    const result = await pending;
    // The stale refresh records nothing: accepted C keeps its own metadata,
    // validators included, and the run says why
    expect(metaOf(fs)).toStrictEqual(promoted);
    expect(result.warnings.join('\n')).toContain(
      'another openapi-mcp process changed it while this run was refreshing it',
    );
  });

  it('a stale 304 does not stamp its validators onto a newer accepted revision', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B, etag: '"b"' }));
    const refresh = parked({ status: 304, etag: '"b"' });
    const pending = run(fs, refresh.fetcher);
    await refresh.entered;
    await promoteTo(fs, C);
    const promoted = metaOf(fs)!;
    refresh.release();
    const result = await pending;
    expect(result.cacheStatus).toBe('revalidated');
    expect(metaOf(fs)).toStrictEqual(promoted);
    expect(result.warnings.join('\n')).toContain(
      'another openapi-mcp process changed it while this run was refreshing it',
    );
  });

  it('a stale run that would clear a candidate (source reverted) cannot replace a promoted C', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B }));
    await run(fs, answering({ body: D })); // Candidate D waits beside accepted B
    const refresh = parked({ body: B }); // Source reverts to B
    const pending = run(fs, refresh.fetcher);
    await refresh.entered;
    await promoteTo(fs, C); // Replaces candidate D with C, then promotes C
    refresh.release();
    // Re-decided against accepted C: B is now a change, gated as a candidate
    await expect(pending).resolves.toMatchObject({ cacheStatus: 'candidate' });
    expect(metaOf(fs)?.title).toBe('C');
    expect(metaOf(fs)?.candidate?.title).toBe('B');
  });

  it('a stale run cannot record a new candidate against a baseline that was replaced', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B }));
    const refresh = parked({ body: D }); // Changed: would become a candidate beside B
    const pending = run(fs, refresh.fetcher);
    await refresh.entered;
    await promoteTo(fs, C);
    refresh.release();
    // The candidate is diffed against C, the baseline actually current now
    await expect(pending).resolves.toMatchObject({ cacheStatus: 'candidate' });
    expect(metaOf(fs)?.title).toBe('C');
    expect(metaOf(fs)?.candidate?.title).toBe('D');
  });

  it('a second conflict on the retry exits 5 and commits nothing', async () => {
    const plain = memoryCacheFs();
    await run(plain, answering({ body: B }));
    // Before each of the parked run's lock attempts, another process promotes
    // a new revision, so both its first commit and its retry are stale
    const competitors = [C, E];
    const fs: MemoryCacheFs = {
      ...plain,
      createExclusive: async (path, data) => {
        const next = armed ? competitors.shift() : undefined;
        if (next !== undefined) {
          await promoteTo(plain, next);
        }
        return plain.createExclusive(path, data);
      },
    };
    let armed = false;
    const refresh = parked({ body: D });
    const pending = run(fs, refresh.fetcher);
    await refresh.entered;
    armed = true;
    refresh.release();
    await expect(pending).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
    expect(competitors).toStrictEqual([]);
    expect(metaOf(plain)?.title).toBe('E');
    expect(metaOf(plain)?.candidate).toBeUndefined();
  });

  it('two runs that record the SAME candidate both succeed', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B }));
    const second = parked({ body: D });
    const pending = run(fs, second.fetcher);
    await second.entered;
    const first = await run(fs, answering({ body: D }));
    expect(first.cacheStatus).toBe('candidate');
    second.release();
    const late = await pending;
    expect(late.cacheStatus).toBe('candidate');
    expect(late.candidateContentHash).toBe(first.candidateContentHash);
  });

  it('a --trust-spec-updates refresh paused across a promotion re-decides against it', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B }));
    const refresh = parked({ body: D });
    const pending = run(fs, refresh.fetcher, { trustSpecUpdates: true });
    await refresh.entered;
    await promoteTo(fs, C);
    refresh.release();
    // Accept-over-B was stale; accept-over-C is what running it again does
    // under --trust-spec-updates, and it is decided against C, not B
    await expect(pending).resolves.toMatchObject({ cacheStatus: 'accepted-update' });
    expect(metaOf(fs)?.title).toBe('D');
  });

  it('clear/recreate: a refresh paused across clear + a new first use does not overwrite it', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B }));
    const refresh = parked({ body: D });
    const pending = run(fs, refresh.fetcher, { trustSpecUpdates: true });
    await refresh.entered;
    time.now += 1;
    await clearNamespace(layoutOf(fs), fs, time.now);
    await run(fs, answering({ body: A }));
    refresh.release();
    // Re-decided against the recreated entry A (trusting updates): D over A
    await expect(pending).resolves.toMatchObject({ cacheStatus: 'accepted-update' });
    expect(metaOf(fs)?.title).toBe('D');
  });

  it('clear alone: a paused refresh does not resurrect the entry the operator cleared', async () => {
    // It is re-decided as a first use of what it fetched (what running it
    // again does), never as an update of the cleared B
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B }));
    const layout = layoutOf(fs);
    const refresh = parked({ body: D });
    const pending = run(fs, refresh.fetcher, { trustSpecUpdates: true });
    await refresh.entered;
    time.now += 1;
    await clearNamespace(layout, fs, time.now);
    refresh.release();
    await expect(pending).resolves.toMatchObject({ cacheStatus: 'accepted-first' });
    expect(metaOf(fs)?.title).toBe('D');
  });

  it('with nothing concurrent, refresh, candidate and promote behave exactly as before', async () => {
    const fs = memoryCacheFs();
    const first = await run(fs, answering({ body: B }));
    expect(first.spec.title).toBe('B');
    const again = await run(fs, answering({ body: B }));
    expect(again.cacheStatus).toBe('revalidated');
    const changed = await run(fs, answering({ body: D }));
    expect(changed.cacheStatus).toBe('candidate');
    await promoteCandidate(layoutOf(fs), fs, (time.now += 1), {});
    expect(metaOf(fs)?.title).toBe('D');
  });

  it('a revalidation older than the recorded one keeps the newer record (no rewind)', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B, etag: '"b"' }));
    const seen = metaOf(fs)!;
    const newer = seen.fetchedAt + 100;
    await touchRevalidated(
      layoutOf(fs),
      fs,
      newer,
      { etag: '"newer"' },
      { expected: { meta: seen } },
    );
    const recorded = metaOf(fs)!;
    expect(recorded.etag).toBe('"newer"');
    // A run that started earlier than that revalidation reports success but
    // does not overwrite it
    expect(
      await touchRevalidated(
        layoutOf(fs),
        fs,
        newer - 50,
        { etag: '"older"' },
        { expected: { meta: seen } },
      ),
    ).toStrictEqual({ recorded: true });
    expect(metaOf(fs)).toStrictEqual(recorded);
  });

  it('a strict (non-best-effort) touch against a replaced revision is a conflict', async () => {
    const fs = memoryCacheFs();
    await run(fs, answering({ body: B }));
    const seen = metaOf(fs)!;
    await promoteTo(fs, C);
    await expect(
      touchRevalidated(layoutOf(fs), fs, (time.now += 1), {}, { expected: { meta: seen } }),
    ).rejects.toMatchObject({ code: 'conflict', exitCode: 5 });
  });
});
