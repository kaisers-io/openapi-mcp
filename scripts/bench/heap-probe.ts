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
