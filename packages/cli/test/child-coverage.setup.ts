// Setup file of the subprocess E2E project (vitest.e2e.config.ts). During a
// coverage run, the root coverage provider (vitest.coverage.ts) names a
// directory for child-process coverage; pointing NODE_V8_COVERAGE at it here
// makes every CLI process this worker spawns from now on write its V8
// coverage there on exit. The worker's own coverage is unaffected: Node reads
// NODE_V8_COVERAGE only at process start, and the worker is already running.
// Without --coverage the variable is absent and nothing changes.
const childCoverageDir = process.env['OPENAPI_MCP_CHILD_COVERAGE_DIR'];
if (childCoverageDir !== undefined && childCoverageDir !== '') {
  process.env['NODE_V8_COVERAGE'] = childCoverageDir;
}
