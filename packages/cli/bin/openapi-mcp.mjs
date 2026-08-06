#!/usr/bin/env node
// Zero-dependency stub: guard the Node floor before any import, then load dist or source.
const REQUIRED = [24, 0];
const found = process.versions.node.split('.').map(Number);
if (found[0] < REQUIRED[0] || (found[0] === REQUIRED[0] && found[1] < REQUIRED[1])) {
  console.error(
    `openapi-mcp requires Node >=${REQUIRED.join('.')} (found v${process.versions.node}). ` +
      'Install a supported Node version (e.g. "nvm install 24") and re-run.',
  );
  process.exit(1);
}
const { existsSync } = await import('node:fs');
const dist = new URL('../dist/openapi-mcp.mjs', import.meta.url);
// Dynamic import makes `import.meta.main` false in the target module (it is only true for
// the file Node was invoked on directly), so the entry's self-execution guard never fires
// here — invoke the CLI explicitly instead of relying on it.
const entry = existsSync(dist)
  ? dist.href
  : // Dev fallback: Node 24 runs TypeScript directly via type stripping
    new URL('../src/index.ts', import.meta.url).href;
const { realContext, run } = await import(entry);
process.exitCode = await run(realContext(), process.argv);
