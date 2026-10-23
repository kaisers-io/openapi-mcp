import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The bin stub is the first code a user's Node runs, so it is exercised as a real child
// process: its contract (version guard, entry selection, failure wording) is only observable
// from outside. Unit-testing it in-process would require exporting from an executable script.
const bin = fileURLToPath(new URL('../bin/openapi-mcp.mjs', import.meta.url));
const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

type Run = { status: number | null; stdout: string; stderr: string };

// Every case below spawns a Node child (and "accepts exactly the floor" loads the whole CLI),
// which takes far longer under CPU contention than vitest's 5 s default allows for. The test
// budget therefore matches the child's own 30 s timeout, so a slow child fails on its own
// result rather than on a test timeout that hides it (issue #96).
const SPAWN_BUDGET = { timeout: 30_000 } as const;

const runStub = (stub: string, nodeArgs: readonly string[], args: readonly string[]): Run => {
  const result = spawnSync(process.execPath, [...nodeArgs, stub, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// Simulates an older runtime without installing one: a `--import` preload runs before the
// stub's module body and replaces `process.versions` (an own, configurable, non-writable
// property, so `defineProperty` — not assignment — is required) with a copy reporting `node`.
// Only the stub's version arithmetic sees the fake; the real Node still runs everything.
const asNode = (node: string): string[] => [
  '--import',
  `data:text/javascript,Object.defineProperty(process,'versions',{value:{...process.versions,node:${JSON.stringify(node)}}})`,
];

// Single source of truth for the supported range is `engines.node`; every other place that
// states it is held to it here, so changing it in one file without the others fails the suite.
const enginesFloor = (path: string): string => {
  const pkg = JSON.parse(repoFile(path)) as { engines: { node: string } };
  return pkg.engines.node;
};

// `engines.node` is one `^MAJOR.MINOR.0` per closed release line, then one open `>=MAJOR.MINOR.0`
// (e.g. `^22.19.0 || >=24.11.0`). Parsed into [major, minor] floors, oldest first.
const parseRange = (range: string): [number, number][] | undefined => {
  const parts = range.split(' || ');
  const lines = parts.map((part, index) => {
    const pattern =
      index === parts.length - 1
        ? /^>=(?<major>\d+)\.(?<minor>\d+)\.0$/u
        : /^\^(?<major>\d+)\.(?<minor>\d+)\.0$/u;
    const groups = pattern.exec(part)?.groups;
    return groups === undefined
      ? undefined
      : ([Number(groups['major']), Number(groups['minor'])] as [number, number]);
  });
  return lines.every((line) => line !== undefined) ? lines : undefined;
};

describe('Node floor: engines, docs, CI and the bin stub agree', SPAWN_BUDGET, () => {
  const floor = enginesFloor('package.json');
  const lines = parseRange(floor) ?? [];
  const version = ([major, minor]: readonly [number, number]): string =>
    `${String(major)}.${String(minor)}.0`;
  // Just below each line's floor (a `.0` floor has no lower minor in its major), and every
  // major between two lines (such as 23.x).
  const rejected = lines.flatMap(([major, minor], index): string[] => {
    const below = minor === 0 ? [] : [version([major, minor - 1])];
    const nextMajor = lines[index + 1]?.[0] ?? major + 1;
    const between = Array.from({ length: nextMajor - major - 1 }, (_, offset) =>
      version([major + 1 + offset, 99]),
    );
    return [...below, ...between];
  });
  const hint = (found: string): string =>
    `openapi-mcp requires Node ${floor} (found v${found}). ` +
    'Install a supported Node version (e.g. "nvm install 24") and re-run.';

  it('states the same `^MAJOR.MINOR.0 || ... || >=MAJOR.MINOR.0` range in every package.json', () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(enginesFloor('packages/cli/package.json')).toBe(floor);
    expect(enginesFloor('packages/core/package.json')).toBe(floor);
  });

  it('documents the range in both READMEs and tests every line floor in the CI matrix', () => {
    expect(repoFile('README.md')).toContain(`Requirements: Node.js \`${floor}\``);
    expect(repoFile('packages/cli/README.md')).toContain(`Requirements: Node.js \`${floor}\``);
    // No other place may state the old floor (e.g. a Development section)
    for (const file of ['README.md', 'packages/cli/README.md', 'docs/configuration.md']) {
      expect(repoFile(file)).not.toMatch(/Node(?:\.js)? `>=24\.11`/u);
    }
    for (const line of lines) {
      expect(repoFile('.github/workflows/ci.yml')).toContain(`'${version(line)}'`);
    }
  });

  it('rejects the release below each line floor and a major between lines', () => {
    // The supported range today is ^22.19.0 || >=24.11.0, so this covers 22.18, 23.x and 24.10.
    expect(rejected.length).toBeGreaterThan(0);
    for (const below of rejected) {
      const result = runStub(bin, asNode(below), ['--version']);
      expect(result.status).toBe(1);
      // Nothing on stdout: the CLI (which would print the version) was never loaded.
      expect(result.stdout).toBe('');
      expect(result.stderr.trim().split('\n')).toStrictEqual([hint(below)]);
    }
  });

  it('rejects a major older than the oldest line too', () => {
    const below = version([(lines[0]?.[0] ?? 0) - 2, 99]);
    const result = runStub(bin, asNode(below), ['--version']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`requires Node ${floor}`);
  });

  it('accepts exactly each line floor, and a later major, and runs the CLI', () => {
    const newest = lines.at(-1) ?? [0, 0];
    for (const accepted of [...lines.map((line) => version(line)), version([newest[0] + 2, 0])]) {
      const result = runStub(bin, asNode(accepted), ['--version']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
    }
  });
});

// Temp package directory of the current entry-selection case, removed after each case.
let pkgDir: string | undefined;

describe('bin stub entry selection', SPAWN_BUDGET, () => {
  // An isolated copy of the package layout: only what each case places there exists, so the
  // result does not depend on whether this checkout has been built.
  const makePackage = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-mcp-bin-'));
    pkgDir = dir;
    mkdirSync(join(dir, 'bin'));
    copyFileSync(bin, join(dir, 'bin', 'openapi-mcp.mjs'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return join(dir, 'bin', 'openapi-mcp.mjs');
  };

  // A stand-in entry module with the real one's export shape (`realContext`, `run`).
  const fakeEntry = (label: string): string =>
    `export const realContext = () => ({});\n` +
    `export const run = async () => { console.log(${JSON.stringify(label)}); return 7; };\n`;

  afterEach(() => {
    if (pkgDir !== undefined) {
      rmSync(pkgDir, { recursive: true, force: true });
      pkgDir = undefined;
    }
  });

  it('fails with one actionable line, not a stack trace, when dist/ is missing in an install', () => {
    const result = runStub(makePackage({}), [], ['--help']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toStrictEqual([
      'openapi-mcp: installation is incomplete (dist/openapi-mcp.mjs is missing). ' +
        'Reinstall with "npm i -g @kaisers-io/openapi-mcp".',
    ]);
  });

  it('loads dist/ when present, even next to src/, and propagates its exit code', () => {
    const stub = makePackage({
      'dist/openapi-mcp.mjs': fakeEntry('from dist'),
      'src/index.ts': fakeEntry('from src'),
    });
    const result = runStub(stub, [], []);
    expect(result.stdout.trim()).toBe('from dist');
    expect(result.status).toBe(7);
  });

  it('falls back to src/index.ts in a checkout without a build', () => {
    const result = runStub(makePackage({ 'src/index.ts': fakeEntry('from src') }), [], []);
    expect(result.stdout.trim()).toBe('from src');
    expect(result.status).toBe(7);
  });
});

// Simulates another operating system the same way asNode simulates a runtime: `process.platform`
// is an own, configurable property, replaced by a `--import` preload before the stub runs.
const asPlatform = (platform: string): string[] => [
  '--import',
  `data:text/javascript,Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}})`,
];

const declaredOs = (): string[] => {
  const pkg = JSON.parse(repoFile('packages/cli/package.json')) as { os?: string[] };
  return pkg.os ?? [];
};

describe(
  'platform: package.json, docs and the bin stub agree on macOS, Linux and Windows',
  SPAWN_BUDGET,
  () => {
    // A built-looking package, so a case that gets past the guard visibly loads the entry.
    const makeBuilt = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'openapi-mcp-platform-'));
      pkgDir = dir;
      mkdirSync(join(dir, 'bin'));
      mkdirSync(join(dir, 'dist'));
      copyFileSync(bin, join(dir, 'bin', 'openapi-mcp.mjs'));
      writeFileSync(
        join(dir, 'dist', 'openapi-mcp.mjs'),
        'export const realContext = () => ({});\n' +
          'export const run = async () => { console.log("loaded"); return 0; };\n',
      );
      return join(dir, 'bin', 'openapi-mcp.mjs');
    };

    afterEach(() => {
      if (pkgDir !== undefined) {
        rmSync(pkgDir, { recursive: true, force: true });
        pkgDir = undefined;
      }
    });

    it('declares exactly darwin, linux and win32 in the published package.json, so npm refuses other platforms', () => {
      expect(declaredOs()).toStrictEqual(['darwin', 'linux', 'win32']);
    });

    it('documents native Windows support, no WSL-only wording, and calls other platforms untested in both READMEs', () => {
      for (const readme of ['README.md', 'packages/cli/README.md']) {
        expect(repoFile(readme)).toContain('macOS, Linux or Windows');
        expect(repoFile(readme)).not.toContain('run it inside [WSL]');
        expect(repoFile(readme)).toContain('refused because they are untested');
      }
    });

    it.each(['darwin', 'linux', 'win32'])('runs the CLI on %s', (platform) => {
      const result = runStub(makeBuilt(), asPlatform(platform), []);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toBe('loaded');
      expect(result.status).toBe(0);
    });

    it.each(['freebsd', 'android', 'aix'])(
      'refuses %s with one line and exit 1, before loading the CLI',
      (platform) => {
        const result = runStub(makeBuilt(), asPlatform(platform), ['--version']);
        expect(result.status).toBe(1);
        // Nothing on stdout: the entry, which would print "loaded", was never imported.
        expect(result.stdout).toBe('');
        expect(result.stderr.trim().split('\n')).toStrictEqual([
          `openapi-mcp supports macOS, Linux and Windows only (found ${platform}). ` +
            'Other platforms are untested and therefore refused.',
        ]);
      },
    );
  },
);
