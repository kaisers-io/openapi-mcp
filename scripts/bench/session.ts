// One measured CLI process: either a `serve` session driven over stdio
// (JSON-RPC, one message per line) or a plain command such as `--version`.

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Fixture } from './fixtures.ts';
import { createIntervalProbe, createLiveHeapReader, peakRssMB, PROBE_FLAGS } from './memory.ts';
import type { IntervalProbe } from './memory.ts';
import { runCalls, runDiscovery } from './workloads.ts';
import type { JsonRpcResponse } from './workloads.ts';
import type { Upstream } from './upstream.ts';

export { PARALLEL_CALLS, SEQUENTIAL_CALLS } from './workloads.ts';
const SESSION_TIMEOUT_MS = 120_000;
// The 2025 handshake: every released version answers it, so the harness can
// measure an older base build the same way
const PROTOCOL_VERSION = '2025-11-25';

type RpcChild = {
  request: (id: number, method: string, params: Record<string, unknown>) => Promise<string>;
  notify: (method: string) => void;
  // Heap in use after a full GC, in MB (heap-probe.ts); undefined where
  // POSIX signals are unavailable
  liveHeapMB: () => Promise<number | undefined>;
  interval: IntervalProbe;
  pid: number;
  close: () => Promise<void>;
};

const childEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
});

const spawnRpc = (cli: string, args: readonly string[], home: string): RpcChild => {
  // The fourth descriptor is the IPC channel of the interval probe
  const child = spawn(process.execPath, [...PROBE_FLAGS, cli, ...args], {
    env: childEnv(home),
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  const pending = new Map<number, PromiseWithResolvers<string>>();
  // A multi-byte character can be split between two chunks
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  const liveHeap = createLiveHeapReader(child);
  // A hung server must not hang the benchmark: kill it, which rejects every
  // pending request through the exit handler below
  const timer = setTimeout(() => {
    stderr += `timed out after ${String(SESSION_TIMEOUT_MS)} ms\n`;
    child.kill('SIGKILL');
  }, SESSION_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter((candidate) => candidate !== '')) {
      let id: number | undefined;
      try {
        ({ id } = JSON.parse(line) as JsonRpcResponse);
      } catch {
        // Stdout carries JSON-RPC only: a stray line (a log in some build) fails
        // this session as a finding instead of crashing the harness
        stderr += `non-JSON line on stdout: ${line.slice(0, 200)}\n`;
        child.kill('SIGKILL');
        return;
      }
      if (id !== undefined) {
        pending.get(id)?.resolve(line);
        pending.delete(id);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    liveHeap.observe(text);
  });
  const exited = once(child, 'exit');
  child.once('exit', () => {
    clearTimeout(timer);
    const lastLine = stderr.trim().split('\n').at(-1) ?? '';
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`the server exited before answering: ${lastLine}`));
    }
    pending.clear();
    liveHeap.fail(new Error(`the server exited before reporting its heap: ${lastLine}`));
  });
  return {
    request: (id, method, params) => {
      const waiter = Promise.withResolvers<string>();
      pending.set(id, waiter);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return waiter.promise;
    },
    notify: (method) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    liveHeapMB: liveHeap.read,
    interval: createIntervalProbe(child),
    pid: child.pid ?? -1,
    close: async () => {
      // Closing stdin ends the stdio session, and the server exits on its own
      child.stdin.end();
      await exited;
    },
  };
};

export type SessionSample = {
  startupMs: number;
  toolsListMs: number;
  toolsListBytes: number;
  toolCount: number;
  rssMB?: number;
  liveHeapMB?: number;
  sequentialCallMs?: number;
  sequentialCallP95Ms?: number;
  parallelCallMs?: number;
  parallelErrors?: number;
  upstreamConnections?: number;
  // The JSON of one call's `result` (no JSON-RPC id), and its text content
  callResultBytes?: number;
  callTextBytes?: number;
  // Medians over the discovery steps of this session, and their bytes
  discoverySearchMs?: number;
  discoveryDescribeMs?: number;
  discoveryCallMs?: number;
  discoveryWorkflowMs?: number;
  discoveryBytes?: number;
  // While the calls ran (heap-probe.ts): lower bounds, sampled
  eventLoopDelayMaxMs?: number;
  eventLoopDelayP99Ms?: number;
  callExternalMaxMB?: number;
};

// The discovery steps, then the calls, inside one measured interval
const runWarmWork = async (
  rpc: RpcChild,
  fixture: Fixture,
  upstream: Upstream,
): Promise<Partial<SessionSample>> => {
  if (fixture.call === undefined && fixture.discovery === undefined) {
    return {};
  }
  await rpc.interval.start();
  if (fixture.discovery !== undefined) {
    upstream.setResponse(fixture.call?.response ?? {});
  }
  const discovery =
    fixture.discovery === undefined ? {} : await runDiscovery(rpc.request, fixture.discovery);
  const calls = await runCalls(rpc.request, fixture, upstream);
  const interval = await rpc.interval.stop();
  return {
    ...discovery,
    ...calls,
    eventLoopDelayMaxMs: interval.eventLoopDelayMaxMs,
    eventLoopDelayP99Ms: interval.eventLoopDelayP99Ms,
    callExternalMaxMB: interval.externalMaxMB,
  };
};

export type SessionInput = {
  cli: string;
  specPath: string;
  fixture: Fixture;
  home: string;
  upstream: Upstream;
  withCalls: boolean;
};

const measureSession = async (
  rpc: RpcChild,
  input: SessionInput,
  started: number,
): Promise<SessionSample> => {
  await rpc.request(1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'openapi-mcp-bench', version: '1' },
  });
  const startupMs = performance.now() - started;
  rpc.notify('notifications/initialized');
  const listStarted = performance.now();
  const listLine = await rpc.request(2, 'tools/list', {});
  const toolsListMs = performance.now() - listStarted;
  const list = JSON.parse(listLine) as JsonRpcResponse;
  if (list.error !== undefined) {
    throw new Error(`tools/list failed: ${list.error.message}`);
  }
  const tools = (list.result?.['tools'] ?? []) as unknown[];
  const calls = input.withCalls ? await runWarmWork(rpc, input.fixture, input.upstream) : {};
  // Peak RSS first: it is the process's high-water mark, which the forced
  // collection below cannot lower but would otherwise come after
  const rssMB = await peakRssMB(rpc.pid);
  const liveHeapMB = await rpc.liveHeapMB();
  return {
    startupMs,
    toolsListMs,
    toolsListBytes: Buffer.byteLength(listLine),
    toolCount: tools.length,
    ...(rssMB === undefined ? {} : { rssMB }),
    ...(liveHeapMB === undefined ? {} : { liveHeapMB }),
    ...calls,
  };
};

// Startup is measured from spawn to the `initialize` response: the request is
// written immediately and sits in the pipe until the server reads stdin, which
// it only does once the spec is processed and the tools are built
export const runSession = async (input: SessionInput): Promise<SessionSample> => {
  const started = performance.now();
  const rpc = spawnRpc(
    input.cli,
    [
      'serve',
      '--spec',
      input.specPath,
      '--base-url',
      input.upstream.url,
      '--trust-spec-updates',
      ...input.fixture.filterArgs,
      ...(input.fixture.serveArgs ?? []),
    ],
    input.home,
  );
  try {
    return await measureSession(rpc, input, started);
  } finally {
    await rpc.close();
  }
};

export const runCommand = async (
  cli: string,
  args: readonly string[],
  home: string,
): Promise<{ ms: number; stdout: string; code: number | null }> => {
  const started = performance.now();
  const child = spawn(process.execPath, [cli, ...args], {
    env: childEnv(home),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return { ms: performance.now() - started, stdout, code };
};
