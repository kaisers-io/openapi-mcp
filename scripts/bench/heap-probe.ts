// Preloaded into every measured `serve` process (`--expose-gc --import`, see
// session.ts). It belongs to the harness, not to the build under test, so a
// base build that predates it is measured the same way.
//
// On SIGUSR2 it runs a full garbage collection and writes the memory still in
// use to stderr: what the server keeps alive once start-up is over. Peak RSS
// cannot gate that reliably. It depends on when V8 grows the young generation
// and when it collects old space, so it alternated between modes ~70 MB apart
// for the SAME build and failed docs-only pull requests. The heap left after
// a full collection does not depend on that timing.
//
// A signal listener does not keep the event loop alive, so the server still
// exits on its own when stdin closes.

import { LIVE_HEAP_MARKER } from './heap-marker.ts';
import type { IntervalReport, ProbeRequest } from './heap-marker.ts';

const collect = (globalThis as { gc?: () => void }).gc;

process.on('SIGUSR2', () => {
  // Twice: the first pass can leave objects that only became unreachable
  // through finalization in that pass
  collect?.();
  collect?.();
  const { heapUsed, external } = process.memoryUsage();
  // `external` covers Buffers and ArrayBuffers held outside the JS heap
  process.stderr.write(`\n${LIVE_HEAP_MARKER} ${String(heapUsed + external)}\n`);
});

// What the server does during a measured interval (issue #22), over the IPC
// channel the harness opens: on `start` it begins a timer that ticks every
// few milliseconds, on `stop` it answers with the maxima. A tick that comes
// late measures how long the event loop was blocked, and each tick samples
// memory. Each message is answered, so the harness knows the interval began
// before it sends the first call. The channel and the timer are unref'd, so
// neither keeps the server alive.
const TICK_MS = 5;
let ticker: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let delays: number[] = [];
let peak = { external: 0, arrayBuffers: 0, rss: 0 };

// One tick: how much later than due it ran, and the memory now
const tick = (): void => {
  const now = performance.now();
  delays.push(Math.max(0, now - lastTick - TICK_MS));
  lastTick = now;
  const { external, arrayBuffers, rss } = process.memoryUsage();
  peak = {
    external: Math.max(peak.external, external),
    arrayBuffers: Math.max(peak.arrayBuffers, arrayBuffers),
    rss: Math.max(peak.rss, rss),
  };
};

const MB = 1024 * 1024;

// The harness may be gone by the time an answer is ready: a failed send is
// dropped instead of becoming an uncaught error in the server
const answer = (message: unknown): void => {
  if (process.connected) {
    process.send?.(message, undefined, undefined, () => {});
  }
};

process.on('message', (message: ProbeRequest) => {
  if (message === 'start') {
    clearInterval(ticker);
    peak = { external: 0, arrayBuffers: 0, rss: 0 };
    delays = [];
    lastTick = performance.now();
    ticker = setInterval(tick, TICK_MS);
    ticker.unref();
    answer('started');
    return;
  }
  // The last tick also covers a task that blocked the loop until now
  tick();
  clearInterval(ticker);
  const sorted = delays.toSorted((left, right) => left - right);
  const report: IntervalReport = {
    eventLoopDelayMaxMs: sorted.at(-1) ?? 0,
    eventLoopDelayP99Ms: sorted[Math.max(0, Math.ceil(0.99 * sorted.length) - 1)] ?? 0,
    externalMaxMB: peak.external / MB,
    arrayBuffersMaxMB: peak.arrayBuffers / MB,
    rssMaxMB: peak.rss / MB,
  };
  answer(report);
});
process.channel?.unref();
