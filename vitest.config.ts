import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scripts/bench holds the benchmark harness; its pure gate logic is unit-tested
    projects: [
      'packages/*/vitest.config.ts',
      'packages/cli/vitest.e2e.config.ts',
      'scripts/bench/vitest.config.ts',
      'scripts/versions/vitest.config.ts',
    ],
    coverage: {
      provider: 'custom',
      customProviderModule: './vitest.coverage.ts',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      // The worker of execute_code runs only inside a worker thread, which the v8
      // provider does not measure; test/code-run.test.ts drives it through
      // every path, and the packed-CLI smoke test runs it on each platform
      exclude: ['packages/cli/src/index.ts', 'packages/core/src/server/code/worker.ts'],
      thresholds: {
        // Aggregate over all included files
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
        // Floor for EVERY file (issue kaisers-io/openapi-mcp-archive#86): the
        // aggregate alone let serve.ts sit at 72% lines unnoticed. Set just
        // below the lowest file, so any file that drops further fails CI.
        // Re-measured on main: lowest are toolgen/build.ts 91.2% statements,
        // server/discovery-route.ts and server/meta.ts 80% branches, cli
        // context.ts 86.2% functions (platform-dependent paths, so that floor
        // keeps its margin), spec/parse.ts 90.9% lines. Raise as files gain
        // tests; never lower to make a change pass.
        perFile: { statements: 90, branches: 78, functions: 84, lines: 90 },
        // Stricter floors where a gap is most costly. The cache is the
        // integrity boundary; the commands are what users run, and they
        // are only covered since subprocess coverage counts
        // (vitest.coverage.ts).
        'packages/core/src/cache/**': { perFile: { lines: 93, branches: 88 } },
        'packages/cli/src/commands/**': { perFile: { lines: 90, branches: 85, functions: 85 } },
      },
    },
  },
});
