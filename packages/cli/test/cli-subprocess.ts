import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// What the subprocess suites spawn: the CLI's TypeScript source, run by Node's
// type stripping (src/index.ts runs the CLI when it is the main module). Not
// bin/openapi-mcp.mjs: the stub prefers dist/ whenever a build exists, and the
// suites would then test a possibly stale bundle instead of the sources under
// review, and report no coverage for them (issue
// kaisers-io/openapi-mcp-archive#86). The stub and the packed bundle are
// exercised by scripts/smoke-cli.sh, which runs the globally installed tarball
// in CI.
export const CLI_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

// The specs and other inputs the subprocess suites start the CLI with.
export const FIXTURES_DIR = fileURLToPath(new URL('fixtures/', import.meta.url));

// Above serve's own forced-shutdown bound (SHUTDOWN_FORCE_MS, 5 s), so a child
// that shuts down as designed always gets to finish.
const STOP_GRACE_MS = 10_000;

// Stops a CLI child the way a user or host would: SIGTERM first, so it runs
// its graceful shutdown and exits normally. A normal exit is also what makes
// Node write the child's NODE_V8_COVERAGE file; a SIGKILLed child writes
// nothing. SIGKILL remains the fallback for a child that does not exit, and the
// promise settles only once the process is gone, so callers can safely remove
// the child's temp HOME afterwards.
export const stopChild = async (proc: ChildProcess): Promise<void> => {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  const exited = once(proc, 'exit');
  proc.kill('SIGTERM');
  const fallback = setTimeout(() => {
    proc.kill('SIGKILL');
  }, STOP_GRACE_MS);
  await exited;
  clearTimeout(fallback);
};
