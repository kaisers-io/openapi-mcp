#!/usr/bin/env node
// Zero-dependency stub: guard the Node floor before any import, then load dist or source.
//
// Syntax budget: this file must still PARSE on Node versions far below the floor, or the user
// gets a SyntaxError instead of the hint below. Hence no top-level await (a SyntaxError before
// Node 14.8) and no `?.`/`??` (Node 14): the hint prints on every Node that can load an `.mjs`
// at all (12.17+, where ES modules were unflagged). Imports happen only after the guard.

// Platform first: no Node upgrade fixes it. The cache's trust model rests on POSIX semantics
// that Windows does not provide (0700/0600 modes are not enforced there, and rename() over a
// file another process holds open fails instead of replacing it), so an unsupported platform
// stops here, before any of that code loads. Other POSIX systems (FreeBSD, OpenBSD, illumos,
// AIX, Android) likely provide those semantics but are refused because nothing tests them.
// PLATFORMS must equal `os` in package.json, which makes npm refuse the install there too;
// test/bin.test.ts holds the two together.
const PLATFORMS = ['darwin', 'linux'];
if (!PLATFORMS.includes(process.platform)) {
  console.error(
    `openapi-mcp supports macOS and Linux only (found ${process.platform}). ` +
      (process.platform === 'win32'
        ? 'On Windows, run it inside WSL.'
        : 'Other platforms are untested and therefore refused.'),
  );
  process.exit(1);
}

// REQUIRED must equal `engines.node` in every package.json — test/bin.test.ts enforces that
// by spawning this stub as the last minor below the floor and as the floor itself.
const REQUIRED = [24, 11];
const found = process.versions.node.split('.').map(Number);
if (found[0] < REQUIRED[0] || (found[0] === REQUIRED[0] && found[1] < REQUIRED[1])) {
  console.error(
    `openapi-mcp requires Node >=${REQUIRED.join('.')} (found v${process.versions.node}). ` +
      'Install a supported Node version (e.g. "nvm install 24") and re-run.',
  );
  process.exit(1);
}

// Returns the module to load, or undefined when the install is incomplete. Order matters:
// dist/ (the only code the published tarball ships) first, then the dev fallback to the
// TypeScript source, which Node 24 runs directly via type stripping. `src/` is never published
// (package.json `files` is bin + dist), and Node refuses to strip types under node_modules, so
// the source is a candidate only when it exists, i.e. in a repo checkout without a build — an
// installed copy that lost dist/ must not chase a file that was never shipped. An explicit
// source override (e.g. an OPENAPI_MCP_ENTRY=src switch) would slot in ahead of dist here.
const resolveEntry = (existsSync) => {
  const dist = new URL('../dist/openapi-mcp.mjs', import.meta.url);
  if (existsSync(dist)) {
    return dist.href;
  }
  const src = new URL('../src/index.ts', import.meta.url);
  return existsSync(src) ? src.href : undefined;
};

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
const enableUserCompileCache = async () => {
  if (process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return;
  }
  try {
    const { enableCompileCache } = await import('node:module');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { chmodSync, lstatSync, mkdirSync } = await import('node:fs');
    const home = homedir();
    if (home === '' || enableCompileCache === undefined) {
      return;
    }
    let dir = home;
    for (const segment of ['.kaisers-io', 'openapi-mcp', 'compile-cache']) {
      dir = join(dir, segment);
      let created = true;
      try {
        mkdirSync(dir);
      } catch (error) {
        if (!error || error.code !== 'EEXIST') {
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
  } catch {
    // No home directory, an unusable path or no compile cache support: start without it
  }
};

const main = async () => {
  // Before the entry is imported, so the bundle itself is loaded through the cache
  await enableUserCompileCache();
  const { existsSync } = await import('node:fs');
  const entry = resolveEntry(existsSync);
  if (entry === undefined) {
    // One line: MCP hosts often surface only the first line of a server's stderr.
    console.error(
      'openapi-mcp: installation is incomplete (dist/openapi-mcp.mjs is missing). ' +
        'Reinstall with "npm i -g @kaisers-io/openapi-mcp".',
    );
    return 1;
  }
  // Dynamic import makes `import.meta.main` false in the target module (it is only true for
  // the file Node was invoked on directly), so the entry's self-execution guard never fires
  // here — invoke the CLI explicitly instead of relying on it.
  const { realContext, run } = await import(entry);
  return run(realContext(), process.argv);
};

// A promise chain, not top-level await (see the syntax budget above). A rejection is left
// unhandled on purpose: Node then prints it and exits 1, as top-level await would.
void main().then((code) => {
  process.exitCode = code;
});
