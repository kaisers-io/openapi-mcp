import { describe, expect, it } from 'vitest';
import type { Fixture } from './fixtures.ts';
import { createLineReader } from './session.ts';
import type { Upstream } from './upstream.ts';
import { resultBytes, runCalls, textBytes } from './workloads.ts';

// How the harness reads the server's answers and times its calls

describe('stdout lines', () => {
  it('keeps a character whose bytes two chunks split', () => {
    const lines: string[] = [];
    const read = createLineReader((line) => {
      lines.push(line);
    });
    const bytes = Buffer.from('{"text":"𝄞"}\n');
    // The 4-byte character starts at offset 9
    read(bytes.subarray(0, 11));
    read(bytes.subarray(11));
    expect(lines).toStrictEqual(['{"text":"𝄞"}']);
  });
});

describe('call timings', () => {
  it('stops the parallel clock before it counts the bytes of a result', async () => {
    // Answered at once, with a result that takes long to parse and serialize
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'x'.repeat(8192) }],
        structuredContent: { rows: Array.from({ length: 200_000 }, (_unused, id) => ({ id })) },
      },
    });
    const upstream = { setResponse: () => {}, connections: () => 0 } as unknown as Upstream;
    const fixture = { call: { tool: 'getItem', args: {}, response: {} } } as unknown as Fixture;
    const metrics = await runCalls(() => Promise.resolve(line), fixture, upstream);
    const started = performance.now();
    resultBytes(line);
    textBytes(line);
    const bytesMs = performance.now() - started;
    expect(metrics.callResultBytes).toBeGreaterThan(1_000_000);
    expect(metrics.parallelCallMs).toBeLessThan(bytesMs / 2);
  });
});
