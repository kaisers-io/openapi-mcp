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
// V8 compile cache (issue #76): later starts reuse the compiled bundle instead of compiling
// its source again. In a directory of this user's own (next to the spec cache), not the shared
// OS temp default another local account could pre-create. NODE_DISABLE_COMPILE_CACHE=1 turns
// it off; any failure only means no cache.
//
// Node would create the directory recursively under the process umask (0755 by default), which
// would leave the app root world-listable before the spec cache ever creates it 0700. So every
// missing component is created here first and chmod'ed 0700 right away, the same walk as the
// CLI's mkdirSecure: ancestors that already exist are not ours and are left alone, and a
// symlink planted at a component means no cache rather than following it.
try {
  if (process.env.NODE_DISABLE_COMPILE_CACHE === undefined) {
    const { enableCompileCache } = await import('node:module');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { chmodSync, lstatSync, mkdirSync } = await import('node:fs');
    const home = homedir();
    if (home !== '' && enableCompileCache !== undefined) {
      let dir = home;
      for (const segment of ['.kaisers-io', 'openapi-mcp', 'compile-cache']) {
        dir = join(dir, segment);
        let created = true;
        try {
          mkdirSync(dir);
        } catch (error) {
          if (error?.code !== 'EEXIST') {
            throw error;
          }
          created = false;
        }
        if (!lstatSync(dir).isDirectory()) {
          throw new Error('not a directory');
        }
        // The cache directory itself is always ours: repair it if an earlier build made it 0755
        if (created || segment === 'compile-cache') {
          chmodSync(dir, 0o700);
        }
      }
      enableCompileCache(dir);
    }
  }
} catch {
  // No home directory, an unusable path or no compile cache support: start without it
}
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
