import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fixture } from './fixtures.ts';
import { createLineReader } from './session.ts';
import type { Upstream } from './upstream.ts';
import { runCalls } from './workloads.ts';

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the parallel clock before it counts the bytes of a result', async () => {
    // A clock that only moves while JSON is parsed: the parallel calls
    // answer at once and parse nothing, the byte metrics parse the result
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const parse = JSON.parse.bind(JSON);
    vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      now += 1000;
      return parse(text) as unknown;
    });
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
    const upstream = { setResponse: () => {}, connections: () => 0 } as unknown as Upstream;
    const fixture = { call: { tool: 'getItem', args: {}, response: {} } } as unknown as Fixture;
    const metrics = await runCalls(() => Promise.resolve(line), fixture, upstream);
    expect(metrics.callTextBytes).toBe(2);
    expect(metrics.parallelCallMs).toBe(0);
  });
});
