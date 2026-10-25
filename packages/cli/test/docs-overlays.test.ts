import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_TEST_TIMEOUT_MS, SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #26: docs/overlays.md shows how to correct a spec with an OpenAPI
// Overlay applied by an external tool (vacuum). The corrected specs it
// produces are committed next to the inputs. vacuum is not a dependency, so
// this suite does not run it; it checks what openapi-mcp does with its output:
// only the intended nodes change, the inventory stays the same, and the
// correction fixes the call it is meant to fix without loosening any input.

const OVERLAYS_DIR = fileURLToPath(new URL('../../../docs/overlays/', import.meta.url));
const GUIDE = fileURLToPath(new URL('../../../docs/overlays.md', import.meta.url));
const VACUUM = '@quobix/vacuum@0.35.1';

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(join(OVERLAYS_DIR, name), 'utf8')) as unknown;

const escapePointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

// JSON Pointers of every node that differs between the two documents
const changedPointers = (before: unknown, after: unknown, at = ''): string[] => {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) =>
      key in before && key in after
        ? changedPointers(before[key], after[key], `${at}/${escapePointer(key)}`)
        : [`${at}/${escapePointer(key)}`],
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [at];
};

const RECIPES = [
  {
    input: 'shop-3.1.json',
    overlay: 'describe-get-order.overlay.yaml',
    output: 'shop-3.1.described.json',
    changed: ['/paths/~1orders~1{id}/get/description'],
    fixesNullNote: false,
  },
  {
    input: 'shop-3.1.json',
    overlay: 'nullable-order-note-3.1.overlay.yaml',
    output: 'shop-3.1.nullable-note.json',
    changed: ['/components/schemas/Order/properties/note/type'],
    fixesNullNote: true,
  },
  {
    input: 'shop-3.0.json',
    overlay: 'nullable-order-note-3.0.overlay.yaml',
    output: 'shop-3.0.nullable-note.json',
    changed: ['/components/schemas/Order/properties/note/nullable'],
    fixesNullNote: true,
  },
] as const;

describe('docs/overlays.md (issue #26)', () => {
  const guide = readFileSync(GUIDE, 'utf8');

  it('shows every overlay file verbatim and runs vacuum only at the pinned version', () => {
    for (const { overlay } of RECIPES) {
      const text = readFileSync(join(OVERLAYS_DIR, overlay), 'utf8');
      expect(text.startsWith('overlay: 1.2.0\n')).toBe(true);
      expect(guide).toContain(`\`\`\`yaml\n${text}\`\`\``);
    }
    expect(guide.match(/npx \S+/gu)?.every((call) => call === `npx ${VACUUM}`)).toBe(true);
  });

  it('documents exactly the committed example files, and every command names existing ones', () => {
    const files = readdirSync(OVERLAYS_DIR).toSorted();
    const named = new Set(
      RECIPES.flatMap((recipe) => [recipe.input, recipe.overlay, recipe.output]),
    );
    expect(files).toEqual([...named].toSorted());
    const commands = [
      ...guide.matchAll(/^\s*(?:npx|diff|openapi-mcp|HOME="\$REVIEW_HOME" openapi-mcp) .+$/gmu),
    ].map((m) => m[0]);
    const mentioned = commands.flatMap(
      (command) => command.match(/[\w.-]+\.(?:json|yaml)/gu) ?? [],
    );
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(files).toContain(name);
    }
    for (const recipe of RECIPES) {
      expect(guide).toContain(
        `npx ${VACUUM} apply-overlay --fail-on-warnings --no-style ${recipe.input} ${recipe.overlay} ${recipe.output}`,
      );
    }
  });

  it.each(RECIPES)('$overlay changes only $changed', ({ input, output, changed }) => {
    expect(changedPointers(readJson(input), readJson(output))).toEqual(changed);
  });
});

// The real CLI, as a user would run it on the committed files.
describe('openapi-mcp on the corrected specs (issue #26)', () => {
  let home: string;
  let upstream: Server;
  let baseUrl: string;
  const posts: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp-overlays-'));
    upstream = createServer((req, res) => {
      if (req.method !== 'GET') {
        posts.push(req.url ?? '');
      }
      res.writeHead(req.method === 'GET' ? 200 : 201, { 'content-type': 'application/json' });
      // The API returns null when the customer left no note
      res.end(JSON.stringify({ id: 'o1', note: null }));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
    });
    rmSync(home, { recursive: true, force: true });
  });

  const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, USERPROFILE: home });

  // `openapi-mcp --json tools` with the default cache policy, its cache under `cacheHome`
  const tools = (spec: string, cacheHome: string): Record<string, unknown> => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, '--json', 'tools', '--spec', spec, '--allow', 'path:/**'],
      {
        cwd: OVERLAYS_DIR,
        env: { ...process.env, HOME: cacheHome, USERPROFILE: cacheHome },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    return (JSON.parse(result.stdout) as { data: Record<string, unknown> }).data;
  };

  // Step 3 of the guide: each file reviewed with a throwaway cache
  const reviewed = (spec: string): unknown => {
    const reviewHome = mkdtempSync(join(tmpdir(), 'openapi-mcp-overlays-review-'));
    try {
      const { source: _source, contentHash: _hash, ...rest } = tools(spec, reviewHome);
      return rest;
    } finally {
      rmSync(reviewHome, { recursive: true, force: true });
    }
  };

  it.each(RECIPES)('$output exposes the same inventory as $input', ({ input, output }) => {
    expect(reviewed(output)).toEqual(reviewed(input));
  });

  // "Serving the corrected spec": a regenerated file at an accepted path stays
  // a candidate, so only a throwaway cache shows the new version.
  it('keeps listing the accepted version of a regenerated file until it is promoted', () => {
    const work = mkdtempSync(join(tmpdir(), 'openapi-mcp-overlays-regen-'));
    try {
      const corrected = join(work, 'corrected.json');
      writeFileSync(corrected, readFileSync(join(OVERLAYS_DIR, 'shop-3.1.json')));
      const first = tools(corrected, home);
      expect(first['cacheStatus']).toBe('accepted-first');
      writeFileSync(corrected, readFileSync(join(OVERLAYS_DIR, 'shop-3.1.nullable-note.json')));
      const again = tools(corrected, home);
      expect(again['cacheStatus']).toBe('candidate');
      expect(again['contentHash']).toBe(first['contentHash']);
      expect(again['candidateContentHash']).toEqual(expect.any(String));
      const reviewHome = join(work, 'review-home');
      const fresh = tools(corrected, reviewHome);
      expect(fresh['cacheStatus']).toBe('accepted-first');
      expect(fresh['contentHash']).not.toBe(first['contentHash']);
      expect(fresh['contentHash']).toBe(
        tools(join(OVERLAYS_DIR, 'shop-3.1.nullable-note.json'), reviewHome)['contentHash'],
      );
      expect(again['candidateContentHash']).not.toBe(fresh['contentHash']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  // Calls getOrder, whose response carries `note: null`, and createOrder with
  // `note: null`, which the request schema must still refuse.
  const callBoth = async (spec: string) => {
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'serve',
        '--trust-spec-updates',
        '--spec',
        spec,
        '--allow',
        'path:/**',
        '--base-url',
        baseUrl,
      ],
      { cwd: OVERLAYS_DIR, env: env() },
    );
    const responses = new Map<number, { result?: Record<string, unknown> }>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((entry) => entry !== '')) {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
      }
    });
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } })}\n`,
      );
      const started = Date.now();
      while (!responses.has(id) && Date.now() - started < SUBPROCESS_WAIT_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      return responses.get(id)?.result ?? {};
    };
    try {
      return {
        getOrder: await call(1, 'getOrder', { id: 'o1' }),
        createOrder: await call(2, 'createOrder', { note: null }),
      };
    } finally {
      await stopChild(child);
    }
  };

  it.each(RECIPES)(
    '$output: a null note in the response is accepted only after the correction',
    async ({ input, output, fixesNullNote }) => {
      const before = await callBoth(input);
      expect(before.getOrder['isError']).toBe(true);
      const after = await callBoth(output);
      expect(after.getOrder['isError']).toBe(!fixesNullNote);
      if (fixesNullNote) {
        expect(after.getOrder['structuredContent']).toEqual({
          status: 200,
          contentType: 'application/json',
          data: { id: 'o1', note: null },
        });
      }
      // The request schema is unchanged: null is still refused as input
      expect(before.createOrder['isError']).toBe(true);
      expect(after.createOrder['isError']).toBe(true);
      expect(posts).toEqual([]);
    },
    SUBPROCESS_TEST_TIMEOUT_MS * 2,
  );
});
