import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { LARGE_FIXTURES } from './large-fixtures.ts';
import { createIntervalProbe, PROBE_FLAGS } from './memory.ts';
import { percentile } from './stats.ts';
import { startUpstream } from './upstream.ts';
import { runDiscovery } from './workloads.ts';

// Issue #22: the parts of the new workloads that can be checked without a
// build: percentiles, the large bodies, the slow upstream, the measured
// interval and the discovery round trip

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const samples = Array.from({ length: 20 }, (_unused, index) => index + 1);
    expect(percentile(samples, 95)).toBe(19);
    expect(percentile(samples, 50)).toBe(10);
    expect(percentile([7], 99)).toBe(7);
    expect(() => percentile([], 50)).toThrow('empty');
  });
});

describe('large bodies', () => {
  const body = (name: string): string => {
    const fixture = LARGE_FIXTURES.find((candidate) => candidate.name === name);
    const response = fixture?.call?.response as () => unknown;
    return JSON.stringify(response());
  };

  it.each([
    ['large-120kb', 120 * 1024],
    ['large-136kb', 136 * 1024],
    ['large-1mb', 1024 * 1024],
    ['large-1mb-escaped', 1024 * 1024],
    ['large-1mb-unicode', 1024 * 1024],
  ])('%s reaches its size, by less than one row more, every time', (name, bytes) => {
    const text = body(name);
    const size = Buffer.byteLength(text);
    expect(size).toBeGreaterThanOrEqual(bytes);
    expect(size).toBeLessThan(bytes + 2048);
    expect(body(name)).toBe(text);
  });

  it('straddles the 128 KiB size where the preview stops serializing everything', () => {
    expect(Buffer.byteLength(body('large-120kb'))).toBeLessThan(128 * 1024);
    expect(Buffer.byteLength(body('large-136kb'))).toBeGreaterThan(128 * 1024);
  });
});

describe('slow upstream', () => {
  it('sends the whole body in chunks, apart in time', async () => {
    const upstream = await startUpstream();
    try {
      const value = { text: 'x'.repeat(10_000) };
      upstream.setResponse(value, { chunks: 4, delayMs: 30 });
      const started = performance.now();
      const response = await fetch(upstream.url);
      const reader = response.body!.getReader();
      let chunks = 0;
      let text = '';
      const decoder = new TextDecoder();
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks += 1;
        text += decoder.decode(read.value, { stream: true });
      }
      expect(JSON.parse(text)).toStrictEqual(value);
      expect(chunks).toBeGreaterThanOrEqual(4);
      expect(performance.now() - started).toBeGreaterThan(80);
    } finally {
      await upstream.close();
    }
  });
});

describe('measured interval', () => {
  it('reports the event-loop delay and memory of the interval, and lets the process exit', async () => {
    // Blocks its event loop for 80 ms and holds 20 MB of Buffers when asked
    // over stdin, then exits when stdin closes, like `serve`
    const script = `
      process.stdin.on('data', () => {
        globalThis.kept = Buffer.alloc(20 * 1024 * 1024, 1);
        const until = Date.now() + 80;
        while (Date.now() < until) {}
        process.stderr.write('done\\n');
      });
      process.stdin.on('end', () => {});
    `;
    const child = spawn(process.execPath, [...PROBE_FLAGS, '-e', script], {
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    });
    const probe = createIntervalProbe(child);
    const done = Promise.withResolvers<void>();
    child.stderr?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('done')) {
        done.resolve();
      }
    });
    await probe.start();
    child.stdin?.write('go\n');
    await done.promise;
    const report = await probe.stop();
    expect(report.eventLoopDelayMaxMs).toBeGreaterThan(60);
    expect(report.externalMaxMB).toBeGreaterThan(19);
    child.stdin?.end();
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
  });
});

describe('discovery round trip', () => {
  const answer = (id: number, result: Record<string, unknown>): string =>
    JSON.stringify({ jsonrpc: '2.0', id, result });
  const step = { query: 'getItem7', name: 'getItem7', arguments: { id: '1' } };

  it('times each step and counts the bytes of every result', async () => {
    const results: Record<string, Record<string, unknown>> = {
      search_operations: {
        content: [{ type: 'text', text: '{"operations":[{"name":"getItem7"}]}' }],
        structuredContent: { operations: [{ name: 'getItem7' }] },
      },
      describe_operation: { content: [{ type: 'text', text: '{}' }] },
      call_operation: { content: [{ type: 'text', text: '{"id":"1"}' }] },
    };
    const seen: string[] = [];
    const metrics = await runDiscovery(
      (id, _method, params) => {
        const name = String(params['name']);
        seen.push(name);
        return Promise.resolve(answer(id, results[name] ?? {}));
      },
      [step, step],
    );
    expect(seen).toStrictEqual([
      'search_operations',
      'describe_operation',
      'call_operation',
      'search_operations',
      'describe_operation',
      'call_operation',
    ]);
    const perRound = Object.values(results).reduce(
      (sum, result) => sum + Buffer.byteLength(JSON.stringify(result)),
      0,
    );
    expect(metrics.discoveryBytes).toBe(2 * perRound);
    expect(metrics.discoveryWorkflowMs).toBeGreaterThanOrEqual(0);
  });

  it('fails when the search does not return the operation, or a step fails', async () => {
    await expect(
      runDiscovery(
        // The name only in the text, not among the operations found
        (id) =>
          Promise.resolve(
            answer(id, {
              content: [{ type: 'text', text: 'getItem7' }],
              structuredContent: { operations: [] },
            }),
          ),
        [step],
      ),
    ).rejects.toThrow('search_operations did not return getItem7');
    await expect(
      runDiscovery(
        (id, _method, params) =>
          Promise.resolve(
            answer(
              id,
              params['name'] === 'search_operations'
                ? { structuredContent: { operations: [{ name: 'getItem7' }] } }
                : { isError: true, content: [] },
            ),
          ),
        [step],
      ),
    ).rejects.toThrow('describe_operation failed');
  });
});
