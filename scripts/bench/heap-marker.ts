// Shared by heap-probe.ts (which writes it) and memory.ts (which reads it).
// A module of its own, so importing the marker never installs the probe's
// handlers in the harness process.
export const LIVE_HEAP_MARKER = 'openapi-mcp-bench-live-heap';

// The IPC messages of a measured interval (heap-probe.ts, memory.ts)
export type ProbeRequest = 'start' | 'stop';

// While the interval ran: how late the probe's timer ticked (the longest and
// the 99th percentile), and the largest memory it sampled. `arrayBuffers` is
// part of `external`. Sampled every few milliseconds, so a shorter memory
// peak can be missed: lower bounds, not exact peaks.
export type IntervalReport = {
  eventLoopDelayMaxMs: number;
  eventLoopDelayP99Ms: number;
  externalMaxMB: number;
  arrayBuffersMaxMB: number;
  rssMaxMB: number;
};
