import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Inner config of coverage-subprocess.test.ts: the repository's custom
// coverage provider, restricted to typed.ts, JSON report into COVERAGE_OUT
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['typed.fixture-test.ts'],
    setupFiles: [fileURLToPath(new URL('../../child-coverage.setup.ts', import.meta.url))],
    coverage: {
      enabled: true,
      provider: 'custom',
      customProviderModule: fileURLToPath(
        new URL('../../../../../vitest.coverage.ts', import.meta.url),
      ),
      include: ['typed.ts'],
      reporter: ['json'],
      reportsDirectory: process.env['COVERAGE_OUT'] ?? 'coverage',
    },
  },
});
