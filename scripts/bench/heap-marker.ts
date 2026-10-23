// Shared by heap-probe.ts (which writes it) and session.ts (which reads it).
// A module of its own, so importing the marker never installs the probe's
// signal handler in the harness process.
export const LIVE_HEAP_MARKER = 'openapi-mcp-bench-live-heap';
