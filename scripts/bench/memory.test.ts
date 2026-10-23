import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createLiveHeapReader, PROBE_FLAGS } from './memory.ts';

// A plain Node process with the harness's probe preloaded, holding `retainMB`
// of live objects and some garbage, until stdin closes (like `serve`)
const probed = (retainMB: number) => {
  const script = `
    globalThis.kept = Array.from({ length: ${String(retainMB)} }, () => Buffer.alloc(1024 * 1024, 1));
    for (let i = 0; i < 200; i += 1) { Array.from({ length: 10000 }, (_, j) => ({ j })); }
    process.stderr.write('ready\\n');
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  `;
  const child = spawn(process.execPath, [...PROBE_FLAGS, '-e', script], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const reader = createLiveHeapReader(child);
  // Asked only once the probe is installed, as `serve` is after tools/list
  const ready = Promise.withResolvers<void>();
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (text.includes('ready')) {
      ready.resolve();
    }
    reader.observe(text);
  });
  return {
    reader,
    ready: ready.promise,
    close: async () => {
      child.stdin.end();
      await once(child, 'exit');
    },
  };
};

describe.skipIf(process.platform === 'win32')('live heap probe', () => {
  it('reports what a process keeps alive, not the garbage it made on the way', async () => {
    const small = probed(0);
    const large = probed(40);
    try {
      await Promise.all([small.ready, large.ready]);
      const smallMB = await small.reader.read();
      const largeMB = await large.reader.read();
      expect(smallMB).toBeDefined();
      // The 40 MB held in Buffers is counted (they live outside the JS heap)
      expect(largeMB! - smallMB!).toBeGreaterThan(39);
      expect(largeMB! - smallMB!).toBeLessThan(45);
      // Asking again gives the same answer: nothing in it depends on GC timing
      const again = await large.reader.read();
      expect(Math.abs(again! - largeMB!)).toBeLessThan(1);
    } finally {
      await Promise.all([small.close(), large.close()]);
    }
  });
});
