import { chmod } from 'node:fs/promises';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'openapi-mcp': 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  minify: true,
  dts: false,
  // The dist/ folder is now several content-hashed chunks (the dynamic imports of the
  // serve action and the fetch path, issue #91): clean it on every build so a
  // chunk left over from an earlier build can never be published
  clean: true,
  outDir: 'dist',
  // Inline every dependency: the published tarball is bin + dist only
  deps: { alwaysBundle: [/.*/u] },
  outExtensions: () => ({ js: '.mjs' }),
  outputOptions: { banner: '#!/usr/bin/env node' },
  onSuccess: async () => {
    await chmod('dist/openapi-mcp.mjs', 0o755);
  },
});
