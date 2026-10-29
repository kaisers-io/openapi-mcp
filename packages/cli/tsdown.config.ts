import { chmod } from 'node:fs/promises';
import { defineConfig } from 'tsdown';

export default defineConfig({
  // The worker of execute_code (issue #60) is its own entry: a Worker loads it by
  // file name, next to the chunk that starts it (core/src/server/code/run.ts)
  entry: {
    'openapi-mcp': 'src/index.ts',
    'execute-worker': '../core/src/server/code/worker.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  minify: true,
  dts: false,
  // The dist/ folder is now several content-hashed chunks (the dynamic imports of the
  // serve action and the fetch path, issue kaisers-io/openapi-mcp-archive#91):
  // clean it on every build so a chunk left over from an earlier build can
  // never be published
  clean: true,
  outDir: 'dist',
  // Inline every dependency: the published tarball is bin + dist only
  deps: { alwaysBundle: [/.*/u] },
  outExtensions: () => ({ js: '.mjs' }),
  // ASCII-only output: V8 stores a module source with any non-ASCII
  // character at two bytes per character, about 2 MB more for this bundle
  outputOptions: { banner: '#!/usr/bin/env node', charset: 'ascii' },
  onSuccess: async () => {
    await chmod('dist/openapi-mcp.mjs', 0o755);
  },
});
