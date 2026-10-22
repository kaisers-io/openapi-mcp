// One measured CLI process: either a `serve` session driven over stdio
// (JSON-RPC, one message per line) or a plain command such as `--version`.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Fixture } from './fixtures.ts';
import { summarize } from './stats.ts';
import type { Upstream } from './upstream.ts';

export const SEQUENTIAL_CALLS = 20;
// Equal to serve's concurrency cap (MAX_CONCURRENT_UPSTREAM_CALLS = 16), so the
// parallel batch measures concurrent throughput. With more calls than the cap,
// the excess is refused immediately and the wall time mostly measured those
// rejections, so a server that queued instead of refusing would have looked
// slower. parallelErrors still gates any refusal at this load. Keep in sync.
export const PARALLEL_CALLS = 16;
const SESSION_TIMEOUT_MS = 120_000;
// The 2025 handshake: every released version answers it, so the harness can
// measure an older base build the same way
const PROTOCOL_VERSION = '2025-11-25';

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
};

type RpcChild = {
  request: (id: number, method: string, params: Record<string, unknown>) => Promise<string>;
  notify: (method: string) => void;
  pid: number;
  close: () => Promise<void>;
};

const childEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
});

const spawnRpc = (cli: string, args: readonly string[], home: string): RpcChild => {
  const child = spawn(process.execPath, [cli, ...args], {
    env: childEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, PromiseWithResolvers<string>>();
  let buffer = '';
  let stderr = '';
  // A hung server must not hang the benchmark: kill it, which rejects every
  // pending request through the exit handler below
  const timer = setTimeout(() => {
    stderr += `timed out after ${String(SESSION_TIMEOUT_MS)} ms\n`;
    child.kill('SIGKILL');
  }, SESSION_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
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
    stderr += chunk.toString('utf8');
  });
  const exited = once(child, 'exit');
  child.once('exit', () => {
    clearTimeout(timer);
    const lastLine = stderr.trim().split('\n').at(-1) ?? '';
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`the server exited before answering: ${lastLine}`));
    }
    pending.clear();
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
    pid: child.pid ?? -1,
    close: async () => {
      // Closing stdin ends the stdio session, and the server exits on its own
      child.stdin.end();
      await exited;
    },
  };
};

const VM_HWM_RE = /^VmHWM:\s+(?<kb>\d+) kB$/mu;

// Peak RSS of a live process. /proc is Linux-only; elsewhere the metric is
// simply absent from the report rather than estimated.
const peakRssMB = async (pid: number): Promise<number | undefined> => {
  let status: string;
  try {
    status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
  } catch {
    return undefined;
  }
  const kb = VM_HWM_RE.exec(status)?.groups?.['kb'];
  return kb === undefined ? undefined : Number(kb) / 1024;
};

export type SessionSample = {
  startupMs: number;
  toolsListMs: number;
  toolsListBytes: number;
  toolCount: number;
  rssMB?: number;
  sequentialCallMs?: number;
  parallelCallMs?: number;
  parallelErrors?: number;
  upstreamConnections?: number;
};

const isCallError = (line: string): boolean => {
  const parsed = JSON.parse(line) as JsonRpcResponse;
  return parsed.error !== undefined || parsed.result?.['isError'] === true;
};

type CallMetrics = Pick<
  SessionSample,
  'sequentialCallMs' | 'parallelCallMs' | 'parallelErrors' | 'upstreamConnections'
>;

const runCalls = async (
  rpc: RpcChild,
  fixture: Fixture,
  upstream: Upstream,
): Promise<CallMetrics> => {
  const { call } = fixture;
  if (call === undefined) {
    return {};
  }
  upstream.setResponse(call.response);
  const params = { name: call.tool, arguments: call.args };
  const connectionsBefore = upstream.connections();
  const sequential: number[] = [];
  for (let index = 0; index < SEQUENTIAL_CALLS; index += 1) {
    const started = performance.now();
    const line = await rpc.request(100 + index, 'tools/call', params);
    sequential.push(performance.now() - started);
    if (isCallError(line)) {
      // A failing sequential call means the fixture is broken, not slow
      throw new Error(`tools/call ${call.tool} failed: ${line.slice(0, 300)}`);
    }
  }
  const parallelStarted = performance.now();
  const lines = await Promise.all(
    Array.from({ length: PARALLEL_CALLS }, (_unused, index) =>
      rpc.request(1000 + index, 'tools/call', params),
    ),
  );
  return {
    sequentialCallMs: summarize(sequential).median,
    parallelCallMs: performance.now() - parallelStarted,
    // Calls the server refused under load (its concurrency cap) are counted,
    // not thrown: they are a measured property of the server
    parallelErrors: lines.filter((line) => isCallError(line)).length,
    upstreamConnections: upstream.connections() - connectionsBefore,
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
  const calls = input.withCalls ? await runCalls(rpc, input.fixture, input.upstream) : {};
  const rssMB = await peakRssMB(rpc.pid);
  return {
    startupMs,
    toolsListMs,
    toolsListBytes: Buffer.byteLength(listLine),
    toolCount: tools.length,
    ...(rssMB === undefined ? {} : { rssMB }),
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
