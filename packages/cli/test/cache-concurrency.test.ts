import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CACHE_META_SCHEMA_VERSION, EXIT } from '@kaisers-io/openapi-mcp-core';
import { realContext } from '../src/context.ts';
import { run } from '../src/main.ts';
import { CLI_ENTRY } from './cli-subprocess.ts';

const specOf = (version: string, extra: boolean): string =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Remote', version },
    paths: {
      '/things': {
        get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
      },
      ...(extra
        ? {
            '/extra': {
              get: { operationId: 'listExtra', responses: { '200': { description: 'ok' } } },
            },
          }
        : {}),
    },
  });

type Fixture = {
  home: string;
  root: string;
  url: string;
  server: Server;
  body: { text: string };
};

let fixture: Fixture;

describe('cross-process cache races and the authenticated bypass (real filesystem, real processes)', () => {
  beforeAll(async () => {
    const home = await mkdtemp(join(tmpdir(), 'openapi-mcp-cache-'));
    const body = { text: specOf('1.0.0', false) };
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body.text);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    fixture = {
      home,
      root: join(home, '.kaisers-io', 'openapi-mcp', 'cache'),
      url: `http://127.0.0.1:${String(port)}/openapi.json`,
      server,
      body,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      fixture.server.close(() => {
        resolve();
      });
    });
    await rm(fixture.home, { recursive: true, force: true });
  });

  const runProcess = (args: readonly string[]): Promise<{ code: number; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
        env: {
          ...process.env,
          HOME: fixture.home,
          USERPROFILE: fixture.home,
          SPEC_TOKEN_ONE: 'Bearer tenant-one',
          SPEC_TOKEN_TWO: 'Bearer tenant-two',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.stdout.resume();
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stderr });
      });
    });

  const namespaceDir = async (): Promise<string> => {
    const names = await readdir(fixture.root);
    return join(fixture.root, names[0]!);
  };

  const readMeta = async (): Promise<Record<string, unknown>> => {
    const metaPath = join(await namespaceDir(), 'meta.json');
    return JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
  };

  describe('cross-process cache races', () => {
    it('seeds an accepted baseline through the real filesystem', async () => {
      const seeded = await runProcess([
        'tools',
        '--spec',
        fixture.url,
        '--cache-key',
        'race',
        '--allow-private-network',
      ]);
      expect(seeded.code).toBe(EXIT.OK);
      expect(await readMeta()).toMatchObject({ specVersion: '1.0.0' });
    });

    it('lets every concurrent start on an unchanged, revalidating spec succeed (#65)', async () => {
      // MCP hosts start several servers at once. Past the TTL each of these
      // revalidates an unchanged spec; only one can record that under the
      // writer lock, and the others must still serve the verified baseline
      // (exit 0, at most a warning) rather than exit 5.
      await new Promise((resolve) => {
        setTimeout(resolve, 1100);
      });
      const args = [
        'tools',
        '--spec',
        fixture.url,
        '--cache-key',
        'race',
        '--allow-private-network',
        '--ttl',
        '1s',
      ];
      const results = await Promise.all(Array.from({ length: 6 }, () => runProcess(args)));
      for (const result of results) {
        expect(result.code).toBe(EXIT.OK);
        expect(result.stderr).not.toContain('ENOENT');
      }
      const names = await readdir(await namespaceDir());
      expect(names).not.toContain('.lock');
    }, 30_000);

    it('serves a verified entry past a lock left by a crashed writer (#65)', async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1100);
      });
      const lockPath = join(await namespaceDir(), '.lock');
      await writeFile(
        lockPath,
        JSON.stringify({ owner: 'crashed', acquiredAt: Date.now() - 3_600_000 }),
      );
      try {
        const result = await runProcess([
          'tools',
          '--spec',
          fixture.url,
          '--cache-key',
          'race',
          '--allow-private-network',
          '--ttl',
          '1s',
        ]);
        expect(result.code).toBe(EXIT.OK);
        expect(result.stderr).toContain('cache metadata not updated');
        expect(result.stderr).toContain('cache unlock');
      } finally {
        await rm(lockPath, { force: true });
      }
    }, 30_000);

    it('keeps meta.json consistent under a concurrent refresh storm', async () => {
      fixture.body.text = specOf('2.0.0', true);
      const args = [
        'cache',
        'refresh',
        '--spec',
        fixture.url,
        '--cache-key',
        'race',
        '--allow-private-network',
      ];
      const results = await Promise.all([
        runProcess(args),
        runProcess(args),
        runProcess(args),
        runProcess(args),
        runProcess(args),
      ]);
      // Every process either succeeds or reports a real conflict; none crashes
      for (const result of results) {
        expect([EXIT.OK, EXIT.CONFLICT]).toContain(result.code);
        expect(result.stderr).not.toContain('ENOENT');
      }
      // Meta.json is the sole commit point: it parses and describes real bytes
      const meta = await readMeta();
      expect(meta['schemaVersion']).toBe(CACHE_META_SCHEMA_VERSION);
      expect(meta['acceptedContentHash']).toMatch(/^[0-9a-f]{64}$/u);
      const dir = await namespaceDir();
      const names = await readdir(dir);
      // No half-written temp files and no orphaned lock survive the storm
      expect(names.filter((name) => name.includes('.tmp'))).toEqual([]);
      expect(names).not.toContain('.lock');
      // Strict writers now wait for each other for up to --timeout instead of
      // ~2 s, so the five refreshes may run one after another
    }, 30_000);

    it('never lets a reader observe a mismatched generation during promotion', async () => {
      const readerArgs = [
        'tools',
        '--spec',
        fixture.url,
        '--cache-key',
        'race',
        '--allow-private-network',
      ];
      const promoteArgs = ['cache', 'promote', '--spec', fixture.url, '--cache-key', 'race'];
      const [promoted, ...readers] = await Promise.all([
        runProcess(promoteArgs),
        runProcess(readerArgs),
        runProcess(readerArgs),
        runProcess(readerArgs),
      ]);
      expect([EXIT.OK, EXIT.CONFLICT]).toContain(promoted.code);
      for (const reader of readers) {
        // A torn read would surface as a corrupt-entry validation error: the
        // hash in meta.json would not match the persisted bytes
        expect(reader.code).toBe(EXIT.OK);
        expect(reader.stderr).not.toContain('cache clear');
      }
    });

    it('serialises clear against a concurrent read without corrupting either', async () => {
      const [cleared, read] = await Promise.all([
        runProcess(['cache', 'clear', '--spec', fixture.url, '--cache-key', 'race']),
        runProcess([
          'tools',
          '--spec',
          fixture.url,
          '--cache-key',
          'race',
          '--allow-private-network',
        ]),
      ]);
      expect([EXIT.OK, EXIT.NOT_FOUND]).toContain(cleared.code);
      // Asserting exit 0 alone would be WRONG here, and would make this test
      // flake against a correct implementation. Readers are lock-free, so
      // this reader may legitimately observe the cleared entry as a miss,
      // fetch a replacement, and reach writeAccepted while clear still holds
      // the namespace lock — and a held namespace lock always surfaces as a
      // conflictError (exit 5), with no automatic takeover. That outcome is
      // correct behaviour, not corruption: the operator asked for a clear,
      // and the reader declined to write underneath it.
      //
      // What the test must actually pin is that no interleaving produces a
      // CORRUPT entry, so the admissible set is exactly {ok, conflict} and the
      // assertions below exclude the two outcomes that would signal real damage:
      // a validation exit 3 (which is what a corrupt baseline reports) and
      // any diagnostic naming the internals.
      expect([EXIT.OK, EXIT.CONFLICT]).toContain(read.code);
      expect(read.code).not.toBe(EXIT.VALIDATION);
      expect(read.stderr).not.toContain('cache clear');
      expect(read.stderr).not.toMatch(/corrupt/iu);
    });

    it('leaves the cache root untouched for an authenticated bypass', async () => {
      await rm(fixture.root, { recursive: true, force: true });
      const first = await runProcess([
        'tools',
        '--spec',
        fixture.url,
        '--spec-header-env',
        'Authorization=SPEC_TOKEN_ONE',
        '--trust-spec-updates',
        '--allow-private-network',
      ]);
      const second = await runProcess([
        'tools',
        '--spec',
        fixture.url,
        '--spec-header-env',
        'Authorization=SPEC_TOKEN_TWO',
        '--trust-spec-updates',
        '--allow-private-network',
      ]);
      expect(first.code).toBe(EXIT.OK);
      expect(second.code).toBe(EXIT.OK);
      // Two credentials, one URL, no shared namespace — because no file exists
      await expect(readdir(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('in-process real-filesystem sanity', () => {
    it('drives the same cache root through realContext without a subprocess', async () => {
      const ctx = { ...realContext(), homeDir: () => fixture.home };
      const code = await run(ctx, ['node', 'openapi-mcp', 'cache', 'list']);
      expect(code).toBe(EXIT.OK);
    });
  });
});
