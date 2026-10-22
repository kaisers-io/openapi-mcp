#!/usr/bin/env node
// Zero-dependency stub: guard the Node floor before any import, then load dist or source.
//
// Syntax budget: this file must still PARSE on Node versions far below the floor, or the user
// gets a SyntaxError instead of the hint below. Hence no top-level await (a SyntaxError before
// Node 14.8) and no `?.`/`??` (Node 14): the hint prints on every Node that can load an `.mjs`
// at all (12.17+, where ES modules were unflagged). Imports happen only after the guard.
//
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

const main = async () => {
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
