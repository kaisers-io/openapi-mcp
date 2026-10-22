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

// Single source of truth for the floor is `engines.node`; every other place that states it is
// held to it here, so raising the floor in one file without the others fails the suite.
const enginesFloor = (path: string): string => {
  const pkg = JSON.parse(repoFile(path)) as { engines: { node: string } };
  return pkg.engines.node;
};

describe('Node floor: engines, docs, CI and the bin stub agree', SPAWN_BUDGET, () => {
  const floor = enginesFloor('package.json');
  const match = /^>=(?<major>\d+)\.(?<minor>\d+)$/u.exec(floor);
  const major = Number(match?.groups?.['major']);
  const minor = Number(match?.groups?.['minor']);

  it('states the same `>=MAJOR.MINOR` floor in every package.json', () => {
    expect(match).not.toBeNull();
    expect(enginesFloor('packages/cli/package.json')).toBe(floor);
    expect(enginesFloor('packages/core/package.json')).toBe(floor);
  });

  it('documents the floor in both READMEs and tests it in the CI matrix', () => {
    expect(repoFile('README.md')).toContain(`Requirements: Node.js \`${floor}\``);
    expect(repoFile('packages/cli/README.md')).toContain(`Requirements: Node.js \`${floor}\``);
    expect(repoFile('.github/workflows/ci.yml')).toContain(`'${String(major)}.${String(minor)}.0'`);
  });

  it('rejects the last minor below the floor with a one-line hint and exit 1', () => {
    // A `.0` floor (e.g. >=26.0) has no lower minor in its major; the newest release
    // below it is then the previous major's, approximated by an x.99 minor.
    const below =
      minor === 0 ? `${String(major - 1)}.99.0` : `${String(major)}.${String(minor - 1)}.0`;
    const result = runStub(bin, asNode(below), ['--version']);
    expect(result.status).toBe(1);
    // Nothing on stdout: the CLI (which would print the version) was never loaded.
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toStrictEqual([
      `openapi-mcp requires Node ${floor} (found v${below}). ` +
        'Install a supported Node version (e.g. "nvm install 24") and re-run.',
    ]);
  });

  it('rejects an older major too', () => {
    const result = runStub(bin, asNode(`${String(major - 2)}.99.0`), ['--version']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`requires Node ${floor}`);
  });

  it('accepts exactly the floor and runs the CLI', () => {
    const result = runStub(bin, asNode(`${String(major)}.${String(minor)}.0`), ['--version']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
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
