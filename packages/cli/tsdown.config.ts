import { chmod } from 'node:fs/promises';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'openapi-mcp': 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  minify: true,
  dts: false,
  clean: false,
  outDir: 'dist',
  // Inline every dependency: the published tarball is bin + dist only
  deps: { alwaysBundle: [/.*/u] },
  outExtensions: () => ({ js: '.mjs' }),
  outputOptions: { banner: '#!/usr/bin/env node' },
  onSuccess: async () => {
    await chmod('dist/openapi-mcp.mjs', 0o755);
  },
});
