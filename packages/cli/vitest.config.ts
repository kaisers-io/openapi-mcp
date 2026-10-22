import { configDefaults, defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.ts';
import { SUBPROCESS_E2E_FILES } from './test/subprocess-budget.ts';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    name: '@kaisers-io/openapi-mcp',
    // The suites that spawn the CLI run in their own project, after this one
    // (vitest.e2e.config.ts)
    exclude: [...configDefaults.exclude, ...SUBPROCESS_E2E_FILES],
  },
});
