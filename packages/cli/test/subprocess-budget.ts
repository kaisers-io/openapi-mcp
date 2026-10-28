// Time budget for the suites that spawn real `openapi-mcp` processes, sized
// from per-test durations measured on CI (issue
// kaisers-io/openapi-mcp-archive#96) rather than guessed:
//
// - In normal runs the slowest subprocess test (the five-process refresh
//   storm in cache-concurrency.test.ts) took up to 4.4 s on ubuntu-latest and
//   3.0 s on macos-latest, against vitest's 5 s default. Most of that was CPU
//   contention with the unit suites, which vitest.e2e.config.ts now removes by
//   running these files after them.
// - The failures were not slow tests but stalls: on macos-latest every child
//   process in flight made no progress for about 15 s at once, while the
//   vitest workers' own timers kept firing. Nothing in the suite can prevent
//   such a stall; the budget can only outlast it.
//
// SUBPROCESS_WAIT_MS bounds a single readiness wait inside a test (a port
// coming up, a line arriving on a pipe). It is above the worst observed stall,
// so a stall alone never trips it, and below SUBPROCESS_TEST_TIMEOUT_MS, so a
// test that hangs in one wait fails on that wait's own, more specific message.
// A test that chains waits gets no such guarantee: in serve-http.test.ts's
// port retry, a candidate that neither binds nor exits uses the full 20 s, the
// respawn on the next port cannot finish in the 10 s left, and the test ends
// on vitest's generic timeout instead. It still fails, just less specifically.
export const SUBPROCESS_WAIT_MS = 20_000;
export const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

// The files whose tests spawn the CLI. Both cli vitest configs read this list,
// so each file is in exactly one of the two projects. A new test file that
// imports node:child_process must be added here or to
// LIGHT_SUBPROCESS_FILES below; subprocess-budget.test.ts fails otherwise.
export const SUBPROCESS_E2E_FILES = [
  'test/bin.test.ts',
  'test/bin-compile-cache.test.ts',
  'test/call-process.test.ts',
  'test/cache-concurrency.test.ts',
  'test/check-process.test.ts',
  'test/coverage-subprocess.test.ts',
  'test/docs-overlays.test.ts',
  'test/serve.test.ts',
  'test/serve-filter-matrix.test.ts',
  'test/serve-head-without-get.test.ts',
  'test/serve-multi-api.test.ts',
  'test/serve-http.test.ts',
  'test/serve-http-oauth.test.ts',
  'test/serve-image.test.ts',
  'test/serve-oauth.test.ts',
  'test/serve-openapi-3.2.test.ts',
  'test/serve-route-authorization.test.ts',
  'test/serve-tool-mode.test.ts',
  'test/serve-upload.test.ts',
  'test/serve-write-effect.test.ts',
];

// The filters against real, large specs: its own project and CI job
// (vitest.real-specs.config.ts), never part of `pnpm test`
export const REAL_SPEC_FILE = 'test/filters-real-specs.test.ts';

// Test files that start a child process but stay in the unit project, each
// with the reason it fits the 5 s default. Paths are relative to the
// repository root, so files of any package can be listed.
export const LIGHT_SUBPROCESS_FILES: Readonly<Record<string, string>> = {
  'packages/cli/test/context.test.ts':
    'one spawnSync of `node -e` that loads context.ts only (umask probe), plus `icacls` on Windows (ACL check), not the CLI',
  'packages/core/test/images-store.test.ts':
    '`icacls` on Windows only (ACL check of the image folder), not the CLI',
  'packages/core/test/http-token-docs.test.ts':
    'runs the documented token generators (`openssl rand`, `node -p`), not the CLI',
};
