import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scripts/bench holds the benchmark harness; its pure gate logic is unit-tested
    projects: ['packages/*', 'scripts/bench'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/cli/src/index.ts'],
      thresholds: { branches: 90, functions: 95, lines: 95, statements: 95 },
    },
  },
});
