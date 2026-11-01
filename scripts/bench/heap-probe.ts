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

import { monitorEventLoopDelay } from 'node:perf_hooks';
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
// channel the harness opens: on `start` it resets an event-loop delay
// histogram and samples memory every few milliseconds, on `stop` it answers
// with the maxima. Each message is answered, so the harness knows the
// interval began before it sends the first call. The channel is unref'd, so
// it does not keep the server alive either.
const SAMPLE_MS = 5;
const RESOLUTION_MS = 10;
const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
let sampler: ReturnType<typeof setInterval> | undefined;
let peak = { external: 0, arrayBuffers: 0, rss: 0 };

const sample = (): void => {
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
    peak = { external: 0, arrayBuffers: 0, rss: 0 };
    sample();
    delay.reset();
    delay.enable();
    sampler = setInterval(sample, SAMPLE_MS);
    sampler.unref();
    // The histogram records from its second tick on: let it tick, then
    // clear what the wait recorded and answer
    setTimeout(() => {
      delay.reset();
      answer('started');
    }, 3 * RESOLUTION_MS);
    return;
  }
  clearInterval(sampler);
  sample();
  delay.disable();
  const report: IntervalReport = {
    eventLoopDelayMaxMs: delay.max / 1e6,
    eventLoopDelayP99Ms: delay.percentile(99) / 1e6,
    externalMaxMB: peak.external / MB,
    arrayBuffersMaxMB: peak.arrayBuffers / MB,
    rssMaxMB: peak.rss / MB,
  };
  answer(report);
});
process.channel?.unref();
