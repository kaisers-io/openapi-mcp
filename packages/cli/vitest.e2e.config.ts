import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.ts';
import { SUBPROCESS_E2E_FILES, SUBPROCESS_TEST_TIMEOUT_MS } from './test/subprocess-budget.ts';

// The suites that spawn real `openapi-mcp` processes (issue
// kaisers-io/openapi-mcp-archive#96). Every child pays Node startup plus a
// type-stripped load of the CLI sources, and the concurrency tests start
// several at once, so these files are CPU-bound in a way the unit suites are
// not. groupOrder 1 starts them only after every groupOrder-0 project (all unit
// tests) has finished, so their children no longer compete with the unit
// workers and the coverage instrumentation for the runner's cores. The budget
// itself is explained in subprocess-budget.ts.
export default defineConfig({
  test: {
    ...sharedTestConfig,
    name: '@kaisers-io/openapi-mcp e2e',
    include: SUBPROCESS_E2E_FILES,
    // Routes the spawned CLI's V8 coverage into the report (issue
    // kaisers-io/openapi-mcp-archive#86)
    setupFiles: ['./test/child-coverage.setup.ts'],
    sequence: { groupOrder: 1 },
    testTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
    hookTimeout: SUBPROCESS_TEST_TIMEOUT_MS,
  },
});
