// Time budget for the suites that spawn real `openapi-mcp` processes, sized
// from per-test durations measured on CI (issue #96) rather than guessed:
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
// real hang still fails on the wait's own, more specific message first.
export const SUBPROCESS_WAIT_MS = 20_000;
export const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

// The files whose tests spawn the CLI. Both cli vitest configs read this list,
// so each file is in exactly one of the two projects.
export const SUBPROCESS_E2E_FILES = [
  'test/cache-concurrency.test.ts',
  'test/serve.test.ts',
  'test/serve-http.test.ts',
];
