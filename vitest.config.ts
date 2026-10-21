import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'packages/cli/vitest.e2e.config.ts'],
    coverage: {
      provider: 'custom',
      customProviderModule: './vitest.coverage.ts',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/cli/src/index.ts'],
      thresholds: {
        // Aggregate over all included files
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
        // Floor for EVERY file (issue #86): the aggregate alone let serve.ts
        // sit at 72% lines unnoticed. Set just below the lowest file at the
        // time (toolgen/build.ts: 58% branches, 85% functions; cli
        // context.ts: 89% lines), so any file that drops further fails CI.
        // Raise as files gain tests; never lower to make a change pass.
        perFile: { statements: 90, branches: 55, functions: 84, lines: 88 },
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
