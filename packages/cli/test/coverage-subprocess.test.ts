import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// End-to-end regression test for the custom coverage provider (issue #86
// review): a nested vitest run in which one typed function runs both in the
// vitest worker and in a spawned Node child. Its function must be ONE entry
// with the summed count; before the fix the two conversions' entries were
// kept side by side and inflated the function percentage.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const config = fileURLToPath(
  new URL('fixtures/coverage-merge/vitest.fixture.config.ts', import.meta.url),
);

type FileCoverage = {
  path: string;
  fnMap: Record<string, { loc: { start: { line: number } } }>;
  f: Record<string, number>;
  s: Record<string, number>;
};

describe('custom coverage provider — worker + child coverage of one file', () => {
  const out = mkdtempSync(join(tmpdir(), 'openapi-mcp-coverage-'));

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('counts each function once, with worker and child hits added', () => {
    // A clean env: the outer run's own child-coverage variables must not leak in
    const env: NodeJS.ProcessEnv = { ...process.env, COVERAGE_OUT: out };
    delete env['NODE_V8_COVERAGE'];
    delete env['OPENAPI_MCP_CHILD_COVERAGE_DIR'];
    const run = spawnSync(
      process.execPath,
      [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config],
      { cwd: repoRoot, env, encoding: 'utf8' },
    );
    // The whole output on failure, so a broken nested run explains itself
    expect({ status: run.status, output: run.stderr + run.stdout }).toMatchObject({ status: 0 });
    const report = JSON.parse(readFileSync(join(out, 'coverage-final.json'), 'utf8')) as Record<
      string,
      FileCoverage
    >;
    const typed = Object.values(report).find((file) => file.path.endsWith('typed.ts'));
    expect(typed).toBeDefined();
    const byLine = new Map<number, number[]>();
    for (const [id, fn] of Object.entries(typed!.fnMap)) {
      byLine.set(fn.loc.start.line, [...(byLine.get(fn.loc.start.line) ?? []), typed!.f[id]!]);
    }
    // Typed.ts has exactly four functions: sum (both), double (worker),
    // shout (child), negate (never)
    expect(Object.keys(typed!.fnMap)).toHaveLength(4);
    expect(byLine).toEqual(
      new Map([
        [7, [2]],
        [10, [1]],
        [13, [1]],
        [16, [0]],
      ]),
    );
  });
});
