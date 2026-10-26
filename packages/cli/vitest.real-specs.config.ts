import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.ts';
import { REAL_SPEC_FILE } from './test/subprocess-budget.ts';

// --allow and --deny against real, large public specs (test/filters-real-specs.test.ts).
// Not part of `pnpm test`: the specs are downloaded (pinned by commit and sha256) and the
// suite takes minutes. CI runs it in its own job on Linux, macOS and Windows.
export default defineConfig({
  test: {
    ...sharedTestConfig,
    name: '@kaisers-io/openapi-mcp real specs',
    // `pnpm test:real-specs` starts vitest at the repository root
    root: import.meta.dirname,
    include: [REAL_SPEC_FILE],
    testTimeout: 600_000,
    hookTimeout: 300_000,
  },
});
