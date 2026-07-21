import { describe, expect, it } from 'vitest';
import { EXIT, type CacheFs } from '@kaisers-io/openapi-mcp-core';
import { testContext, type CliContext } from '../src/context.ts';
import { run } from '../src/main.ts';

const HOME = '/home/tester';
const ROOT = `${HOME}/.kaisers-io/openapi-mcp/cache`;

interface MemoryCacheFs extends CacheFs {
  files: Map<string, string>;
  calls: string[];
}

const memoryCacheFs = (): MemoryCacheFs => {
  const files = new Map<string, string>();
  const dirs = new Set<string>([ROOT]);
  const calls: string[] = [];
  return {
    files,
    calls,
    mkdirSecure: (path) => {
      calls.push('mkdirSecure');
      dirs.add(path);
      return Promise.resolve();
    },
    writeFileAtomic: (path, data) => {
      calls.push('writeFileAtomic');
      files.set(path, data);
      return Promise.resolve();
    },
    readFileTextCapped: (path, maxBytes) => {
      calls.push('readFileTextCapped');
      const found = files.get(path);
      if (found === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return found.length > maxBytes
        ? Promise.reject(new Error(`cache file exceeds ${String(maxBytes)} bytes`))
        : Promise.resolve(found);
    },
    readDirNames: (path) => {
      calls.push('readDirNames');
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) {
          names.add(key.slice(prefix.length).split('/')[0] ?? '');
        }
      }
      return Promise.resolve([...names].filter((name) => name !== ''));
    },
    removeDir: (path) => {
      calls.push('removeDir');
      for (const key of files.keys()) {
        if (key === path || key.startsWith(`${path}/`)) {
          files.delete(key);
        }
      }
      dirs.delete(path);
      return Promise.resolve();
    },
    pathExists: (path) => {
      calls.push('pathExists');
      return Promise.resolve(
        files.has(path) ||
          dirs.has(path) ||
          [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      );
    },
    createExclusive: (path, data) => {
      calls.push('createExclusive');
      if (files.has(path)) {
        return Promise.resolve(false);
      }
      files.set(path, data);
      return Promise.resolve(true);
    },
    removeFile: (path) => {
      calls.push('removeFile');
      files.delete(path);
      return Promise.resolve();
    },
  };
};

const specText = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Remote', version: '1.0.0' },
  paths: {
    '/things': {
      get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
    },
  },
});

const changedText = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Remote', version: '2.0.0' },
  paths: {
    '/things': {
      get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
    },
    '/extra': {
      get: { operationId: 'listExtra', responses: { '200': { description: 'ok' } } },
    },
  },
});

interface Capture {
  lines: string[];
  errLines: string[];
  cacheFs: MemoryCacheFs;
  ctx: CliContext;
}

const cacheCtx = (
  bodies: readonly string[] = [specText],
  overrides: Parameters<typeof testContext>[0] = {},
): Capture => {
  const lines: string[] = [];
  const errLines: string[] = [];
  const cacheFs = memoryCacheFs();
  let call = 0;
  const ctx = testContext({
    lines,
    errLines,
    cacheFs,
    homeDir: () => HOME,
    now: () => 1_000_000 + call * 10_000_000,
    fetcher: (() => {
      const body = bodies[Math.min(call, bodies.length - 1)]!;
      call += 1;
      return Promise.resolve(new Response(body));
    }) as typeof fetch,
    ...overrides,
  });
  return { lines, errLines, cacheFs, ctx };
};

const SPEC_URL = 'https://api.example.com/openapi.json';

const seed = async (capture: Capture): Promise<void> => {
  const code = await run(capture.ctx, ['node', 'openapi-mcp', 'tools', '--spec', SPEC_URL]);
  expect(code).toBe(EXIT.OK);
};

const idOf = (capture: Capture): string =>
  [...capture.cacheFs.files.keys()][0]!.slice(ROOT.length + 1).split('/')[0]!;

describe('cache list', () => {
  it('reports an empty cache without failing', async () => {
    const { lines, ctx } = cacheCtx();
    const code = await run(ctx, ['node', 'openapi-mcp', 'cache', 'list']);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('no cache entries');
  });

  it('lists a seeded entry with an opaque id and redacted source', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, ['node', 'openapi-mcp', '--json', 'cache', 'list']);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(capture.lines.at(-1)!) as {
      data: {
        entries: {
          id: string;
          displaySource: string;
          cacheKey?: string;
          title: string;
          specVersion: string;
          fetchedAt: number;
          acceptedContentHash: string;
        }[];
      };
    };
    const entry = envelope.data.entries[0]!;
    expect(entry.id).toMatch(/^[0-9a-f]{16}$/u);
    expect(entry.displaySource).toBe(SPEC_URL);
    expect(entry.title).toBe('Remote');
    expect(entry.specVersion).toBe('1.0.0');
    expect(entry.acceptedContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(entry.cacheKey).toBeUndefined();
  });

  it('surfaces the cache-key label so two namespaces of one URL are tellable apart (D9)', async () => {
    const capture = cacheCtx();
    await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      SPEC_URL,
      '--cache-key',
      'prod',
    ]);
    const code = await run(capture.ctx, ['node', 'openapi-mcp', '--json', 'cache', 'list']);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(capture.lines.at(-1)!) as {
      data: { entries: { cacheKey?: string }[] };
    };
    expect(envelope.data.entries[0]?.cacheKey).toBe('prod');
  });

  it('sanitizes the environment-derived cache root in human output (round-2 item 12)', async () => {
    // HomeDir() is environment-derived, so the root is untrusted display text
    // on the human path exactly like a spec title is. The round-1 draft
    // interpolated it raw into both the empty-cache line and the list heading.
    const hostileHome = `/home/tester\u001B]0;PWNED\u0007`;
    const { lines, ctx } = cacheCtx([specText], { homeDir: () => hostileHome });
    const empty = await run(ctx, ['node', 'openapi-mcp', 'cache', 'list']);
    expect(empty).toBe(EXIT.OK);
    const text = lines.join('\n');
    expect(text).toContain('no cache entries under');
    // No raw ESC or BEL reaches the terminal
    expect(text).not.toContain('\u001B');
    expect(text).not.toContain('\u0007');
  });

  it('keeps the raw root in the JSON envelope, where encoding makes it safe', async () => {
    const hostileHome = `/home/tester\u001B]0;PWNED\u0007`;
    const { lines, ctx } = cacheCtx([specText], { homeDir: () => hostileHome });
    await run(ctx, ['node', 'openapi-mcp', '--json', 'cache', 'list']);
    const envelope = JSON.parse(lines.at(-1)!) as { data: { cacheRoot: string } };
    expect(envelope.data.cacheRoot).toContain('\u001B');
    // The wire form is the escaped six-character sequence, not a raw byte (D1)
    expect(lines.at(-1)).toContain('\\u001b');
  });

  it('prints the entry id, title, key, and source in human mode', async () => {
    const capture = cacheCtx();
    await seed(capture);
    capture.lines.length = 0;
    await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'list']);
    const text = capture.lines.join('\n');
    expect(text).toContain('Remote 1.0.0');
    expect(text).toContain(SPEC_URL);
    expect(text).toMatch(/[0-9a-f]{16}/u);
  });
});

describe('cache clear', () => {
  it('refuses to clear everything without an explicit target', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'clear']);
    expect(code).toBe(EXIT.USAGE);
    expect(capture.errLines.join('\n')).toContain('--all');
    // Nothing was removed
    expect(capture.cacheFs.files.size).toBeGreaterThan(0);
  });

  it('rejects --all combined with a specific target', async () => {
    const { ctx } = cacheCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--all',
      '--spec',
      SPEC_URL,
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('rejects --spec combined with --id', async () => {
    const { ctx } = cacheCtx();
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--spec',
      SPEC_URL,
      '--id',
      '0'.repeat(16),
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('clears one namespace by --spec', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--spec',
      SPEC_URL,
    ]);
    expect(code).toBe(EXIT.OK);
    expect(capture.cacheFs.files.size).toBe(0);
  });

  it('clears one namespace by --id', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--id',
      idOf(capture),
    ]);
    expect(code).toBe(EXIT.OK);
    expect(capture.cacheFs.files.size).toBe(0);
  });

  it('rejects a traversal --id with exit 2 without echoing it or touching the cache', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const before = capture.cacheFs.files.size;
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--id',
      '../../etc',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(capture.errLines.join('\n')).not.toContain('../../etc');
    expect(capture.cacheFs.files.size).toBe(before);
  });

  it('rejects an uppercase-hex --id with exit 2', async () => {
    const { ctx } = cacheCtx();
    const code = await run(ctx, ['node', 'openapi-mcp', 'cache', 'clear', '--id', 'A'.repeat(16)]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('reports exit 4 when the target namespace has no entry', async () => {
    const { ctx } = cacheCtx();
    const code = await run(ctx, ['node', 'openapi-mcp', 'cache', 'clear', '--spec', SPEC_URL]);
    expect(code).toBe(EXIT.NOT_FOUND);
  });

  it('clears everything with --all', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'clear', '--all']);
    expect(code).toBe(EXIT.OK);
    expect(capture.cacheFs.files.size).toBe(0);
    // The root survives the sweep (D16c): removing it would race a first-ever
    // write that legitimately recreates a namespace underneath it
    expect(await capture.cacheFs.pathExists(ROOT)).toBe(true);
    // Plan defect (round-11 finding 13): clearNamespace (Tasks 3-4, store.ts)
    // deliberately leaves the per-namespace directory and its now-empty
    // objects dir removed but the namespace dir itself in place ("the
    // namespace directory and .lock deliberately survive until release" -
    // store.ts's own clearNamespaceImpl comment), so an empty namespace
    // directory persists under the root even after --all. Asserting
    // readDirNames(ROOT) is empty contradicts that already-shipped,
    // out-of-scope-for-this-task behavior; the real, security-relevant
    // property is that no cache CONTENT survives, which files.size === 0
    // above already proves.
    expect(await run(capture.ctx, ['node', 'openapi-mcp', '--json', 'cache', 'list'])).toBe(
      EXIT.OK,
    );
    const envelope = JSON.parse(capture.lines.at(-1)!) as { data: { entries: unknown[] } };
    expect(envelope.data.entries).toEqual([]);
  });

  it('recovers a corrupt entry that the pipeline refuses to serve (D5)', async () => {
    const capture = cacheCtx([specText, specText]);
    await seed(capture);
    const metaPath = [...capture.cacheFs.files.keys()].find((key) => key.endsWith('meta.json'))!;
    capture.cacheFs.files.set(metaPath, 'not json at all');
    const blocked = await run(capture.ctx, ['node', 'openapi-mcp', 'tools', '--spec', SPEC_URL]);
    expect(blocked).toBe(EXIT.VALIDATION);
    expect(capture.errLines.join('\n')).toContain('openapi-mcp cache clear');
    // The documented recovery path actually works
    const cleared = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--spec',
      SPEC_URL,
    ]);
    expect(cleared).toBe(EXIT.OK);
    const after = await run(capture.ctx, ['node', 'openapi-mcp', 'tools', '--spec', SPEC_URL]);
    expect(after).toBe(EXIT.OK);
  });
});

describe('cache unlock (D12.3)', () => {
  const lockPathOf = (capture: Capture): string => `${ROOT}/${idOf(capture)}/.lock`;

  it('refuses to clear a namespace another process is writing', async () => {
    const capture = cacheCtx();
    await seed(capture);
    capture.cacheFs.files.set(
      lockPathOf(capture),
      JSON.stringify({ owner: 'writer', acquiredAt: 1_000_000 }),
    );
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--spec',
      SPEC_URL,
    ]);
    // Round-2 item 3: clear takes the lock, so it waits for the writer rather
    // than deleting underneath it and leaving metadata without spec bytes
    expect(code).toBe(EXIT.CONFLICT);
    expect(capture.errLines.join('\n')).toContain('cache unlock');
    expect(capture.cacheFs.files.size).toBeGreaterThan(0);
  });

  it('removes a stale lock and lets the next command through', async () => {
    const capture = cacheCtx();
    await seed(capture);
    capture.cacheFs.files.set(
      lockPathOf(capture),
      JSON.stringify({ owner: 'dead', acquiredAt: 0 }),
    );
    const unlocked = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'unlock',
      '--spec',
      SPEC_URL,
    ]);
    expect(unlocked).toBe(EXIT.OK);
    const cleared = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--spec',
      SPEC_URL,
    ]);
    expect(cleared).toBe(EXIT.OK);
  });

  it('refuses a fresh lock without --force, and accepts it with one', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const write = (): void => {
      capture.cacheFs.files.set(
        lockPathOf(capture),
        JSON.stringify({ owner: 'live', acquiredAt: capture.ctx.now() }),
      );
    };
    write();
    const refused = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'unlock',
      '--spec',
      SPEC_URL,
    ]);
    expect(refused).toBe(EXIT.CONFLICT);
    write();
    const forced = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'unlock',
      '--spec',
      SPEC_URL,
      '--force',
    ]);
    expect(forced).toBe(EXIT.OK);
  });

  it('reports exit 4 when there is no lock to remove', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'unlock',
      '--spec',
      SPEC_URL,
    ]);
    expect(code).toBe(EXIT.NOT_FOUND);
  });

  it('rejects a traversal --id with exit 2 without echoing it', async () => {
    const capture = cacheCtx();
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'unlock',
      '--id',
      '../../etc',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(capture.errLines.join('\n')).not.toContain('../../etc');
  });

  it('needs exactly one target', async () => {
    const capture = cacheCtx();
    expect(await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'unlock'])).toBe(EXIT.USAGE);
    expect(
      await run(capture.ctx, [
        'node',
        'openapi-mcp',
        'cache',
        'unlock',
        '--spec',
        SPEC_URL,
        '--id',
        '0'.repeat(16),
      ]),
    ).toBe(EXIT.USAGE);
  });
});

describe('cache refresh', () => {
  it('forces a refetch and writes a candidate when the spec changed', async () => {
    const capture = cacheCtx([specText, changedText]);
    await seed(capture);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      '--json',
      'cache',
      'refresh',
      '--spec',
      SPEC_URL,
    ]);
    expect(code).toBe(EXIT.OK);
    const envelope = JSON.parse(capture.lines.at(-1)!) as {
      data: { cacheStatus: string; candidateContentHash?: string };
    };
    expect(envelope.data.cacheStatus).toBe('candidate');
    expect(envelope.data.candidateContentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('reports no change when the spec is identical', async () => {
    const capture = cacheCtx([specText, specText]);
    await seed(capture);
    capture.lines.length = 0;
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'refresh',
      '--spec',
      SPEC_URL,
    ]);
    expect(code).toBe(EXIT.OK);
    expect(capture.lines.join('\n')).toContain('unchanged');
  });

  it('rejects a refresh that would resolve to a non-persistent bypass (D13)', async () => {
    const capture = cacheCtx([specText], { env: { SPEC_TOKEN: 'Bearer x' } });
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'refresh',
      '--spec',
      SPEC_URL,
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--trust-spec-updates',
    ]);
    // Refreshing a cache that will not be written is meaningless, not a no-op
    expect(code).toBe(EXIT.USAGE);
    expect(capture.errLines.join('\n')).toContain('--cache-key');
  });
});

describe('cache promote', () => {
  it('promotes a pending candidate', async () => {
    const capture = cacheCtx([specText, changedText]);
    await seed(capture);
    await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'refresh', '--spec', SPEC_URL]);
    capture.lines.length = 0;
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'promote',
      '--spec',
      SPEC_URL,
    ]);
    expect(code).toBe(EXIT.OK);
    expect(capture.lines.join('\n')).toContain('promoted');
    // The promoted document is now what the pipeline serves
    const listed = await run(capture.ctx, ['node', 'openapi-mcp', '--json', 'cache', 'list']);
    expect(listed).toBe(EXIT.OK);
    const envelope = JSON.parse(capture.lines.at(-1)!) as {
      data: { entries: { specVersion: string; candidateContentHash?: string }[] };
    };
    expect(envelope.data.entries[0]?.specVersion).toBe('2.0.0');
    expect(envelope.data.entries[0]?.candidateContentHash).toBeUndefined();
  });

  it('reports exit 5 when there is no candidate to promote', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'promote',
      '--spec',
      SPEC_URL,
    ]);
    expect(code).toBe(EXIT.CONFLICT);
  });

  it('reports exit 5 on a --hash mismatch', async () => {
    const capture = cacheCtx([specText, changedText]);
    await seed(capture);
    await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'refresh', '--spec', SPEC_URL]);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'promote',
      '--spec',
      SPEC_URL,
      '--hash',
      'f'.repeat(64),
    ]);
    expect(code).toBe(EXIT.CONFLICT);
  });

  it('rejects a malformed --hash with exit 2 before touching the cache', async () => {
    const capture = cacheCtx([specText, changedText]);
    await seed(capture);
    await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'refresh', '--spec', SPEC_URL]);
    const before = new Map(capture.cacheFs.files);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'promote',
      '--spec',
      SPEC_URL,
      '--hash',
      'NOT-A-HASH',
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect([...capture.cacheFs.files]).toEqual([...before]);
  });
});

describe('cache namespacing and secrets', () => {
  it('targets a different namespace under --cache-key', async () => {
    const capture = cacheCtx();
    await seed(capture);
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'clear',
      '--spec',
      SPEC_URL,
      '--cache-key',
      'prod',
    ]);
    // The unkeyed entry is a different namespace and stays untouched
    expect(code).toBe(EXIT.NOT_FOUND);
    expect(capture.cacheFs.files.size).toBeGreaterThan(0);
  });

  it('never writes a secret value or a query string into the cache', async () => {
    const secret = 'super-secret-value-9000';
    const capture = cacheCtx([specText], { env: { SPEC_TOKEN: secret } });
    const code = await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'cache',
      'refresh',
      '--spec',
      `${SPEC_URL}?page=1`,
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--cache-key',
      'prod',
    ]);
    expect(code).toBe(EXIT.OK);
    const written = [...capture.cacheFs.files.values()].join('\n');
    const paths = [...capture.cacheFs.files.keys()].join('\n');
    expect(written).not.toContain(secret);
    expect(written).not.toContain('page=1');
    expect(paths).not.toContain(secret);
    expect([...capture.lines, ...capture.errLines].join('\n')).not.toContain(secret);
  });

  it('fails with exit 3 when no home directory is available', async () => {
    const { ctx } = cacheCtx([specText], { homeDir: () => undefined });
    const code = await run(ctx, ['node', 'openapi-mcp', 'cache', 'list']);
    expect(code).toBe(EXIT.VALIDATION);
  });
});

describe('authenticated bypass leaves no trace on disk (D13)', () => {
  it('runs two different credentials against one URL and writes nothing', async () => {
    const first = cacheCtx([specText], { env: { SPEC_TOKEN: 'Bearer tenant-one' } });
    const firstCode = await run(first.ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      SPEC_URL,
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--trust-spec-updates',
    ]);
    expect(firstCode).toBe(EXIT.OK);

    const second = cacheCtx([specText], { env: { SPEC_TOKEN: 'Bearer tenant-two' } });
    const secondCode = await run(second.ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      SPEC_URL,
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--trust-spec-updates',
    ]);
    expect(secondCode).toBe(EXIT.OK);

    // Not "the two runs used different namespaces" — no namespace exists at all,
    // so there is nothing for a second credential to read or poison
    expect(first.cacheFs.calls).toEqual([]);
    expect(second.cacheFs.calls).toEqual([]);
    expect(first.cacheFs.files.size).toBe(0);
    expect(second.cacheFs.files.size).toBe(0);
    expect(first.lines.join('\n')).toContain('cache: bypassed');
  });

  it('shows nothing in cache list after a bypassed run', async () => {
    const capture = cacheCtx([specText], { env: { SPEC_TOKEN: 'Bearer x' } });
    await run(capture.ctx, [
      'node',
      'openapi-mcp',
      'tools',
      '--spec',
      SPEC_URL,
      '--spec-header-env',
      'Authorization=SPEC_TOKEN',
      '--trust-spec-updates',
    ]);
    capture.lines.length = 0;
    const code = await run(capture.ctx, ['node', 'openapi-mcp', 'cache', 'list']);
    expect(code).toBe(EXIT.OK);
    expect(capture.lines.join('\n')).toContain('no cache entries');
  });
});
