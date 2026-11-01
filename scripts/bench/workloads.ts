// What the warm session runs: the plain tools/calls, and the discovery round
// trips an agent runs under --tool-mode discover (issue #22)

import type { DiscoveryStep, Fixture } from './fixtures.ts';
import type { SessionSample } from './session.ts';
import { percentile, summarize } from './stats.ts';
import type { Upstream } from './upstream.ts';

export const SEQUENTIAL_CALLS = 20;
// Equal to serve's concurrency cap (MAX_CONCURRENT_UPSTREAM_CALLS = 16), so the
// parallel batch measures concurrent throughput. With more calls than the cap,
// the excess is refused immediately and the wall time mostly measured those
// rejections, so a server that queued instead of refusing would have looked
// slower. parallelErrors still gates any refusal at this load. Keep in sync.
export const PARALLEL_CALLS = 16;

export type JsonRpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
};

type Request = (id: number, method: string, params: Record<string, unknown>) => Promise<string>;

export const isCallError = (line: string): boolean => {
  const parsed = JSON.parse(line) as JsonRpcResponse;
  return parsed.error !== undefined || parsed.result?.['isError'] === true;
};

export const resultBytes = (line: string): number =>
  Buffer.byteLength(JSON.stringify((JSON.parse(line) as JsonRpcResponse).result ?? {}));

export const textBytes = (line: string): number => {
  const content = ((JSON.parse(line) as JsonRpcResponse).result?.['content'] ?? []) as {
    type?: string;
    text?: string;
  }[];
  return content.reduce(
    (sum, part) => sum + (part.type === 'text' ? Buffer.byteLength(part.text ?? '') : 0),
    0,
  );
};

type DiscoveryMetrics = Pick<
  SessionSample,
  | 'discoverySearchMs'
  | 'discoveryDescribeMs'
  | 'discoveryCallMs'
  | 'discoveryWorkflowMs'
  | 'discoveryBytes'
>;

// Search, describe and call each step's operation, as an agent does under
// discover. Each step must succeed, and the search must return the name:
// a quick error must never look like a fast workflow.
export const runDiscovery = async (
  request: Request,
  steps: readonly DiscoveryStep[],
): Promise<DiscoveryMetrics> => {
  const timed: { search: number[]; describe: number[]; call: number[]; workflow: number[] } = {
    search: [],
    describe: [],
    call: [],
    workflow: [],
  };
  let bytes = 0;
  let id = 5000;
  const step = async (name: string, params: Record<string, unknown>): Promise<number> => {
    id += 1;
    const started = performance.now();
    const line = await request(id, 'tools/call', { name, arguments: params });
    const ms = performance.now() - started;
    if (isCallError(line)) {
      throw new Error(`${name} failed: ${line.slice(0, 300)}`);
    }
    bytes += resultBytes(line);
    const found = JSON.stringify(
      (JSON.parse(line) as JsonRpcResponse).result?.['structuredContent'] ?? {},
    );
    if (name === 'search_operations' && !found.includes(`"${String(params['query'])}"`)) {
      throw new Error(`search_operations did not return ${String(params['query'])}`);
    }
    return ms;
  };
  for (const { query, name, arguments: args } of steps) {
    const search = await step('search_operations', { query });
    const describe = await step('describe_operation', { name });
    const call = await step('call_operation', { name, arguments: args });
    timed.search.push(search);
    timed.describe.push(describe);
    timed.call.push(call);
    timed.workflow.push(search + describe + call);
  }
  return {
    discoverySearchMs: summarize(timed.search).median,
    discoveryDescribeMs: summarize(timed.describe).median,
    discoveryCallMs: summarize(timed.call).median,
    discoveryWorkflowMs: summarize(timed.workflow).median,
    discoveryBytes: bytes,
  };
};

type CallMetrics = Pick<
  SessionSample,
  | 'sequentialCallMs'
  | 'sequentialCallP95Ms'
  | 'parallelCallMs'
  | 'parallelErrors'
  | 'upstreamConnections'
  | 'callResultBytes'
  | 'callTextBytes'
>;

export const runCalls = async (
  request: Request,
  fixture: Fixture,
  upstream: Upstream,
): Promise<CallMetrics> => {
  const { call } = fixture;
  if (call === undefined) {
    return {};
  }
  upstream.setResponse(
    typeof call.response === 'function' ? (call.response as () => unknown)() : call.response,
    fixture.slowBody,
  );
  const params = { name: call.tool, arguments: call.args };
  const connectionsBefore = upstream.connections();
  const sequential: number[] = [];
  let first: string | undefined;
  for (let index = 0; index < SEQUENTIAL_CALLS; index += 1) {
    const started = performance.now();
    const line = await request(100 + index, 'tools/call', params);
    sequential.push(performance.now() - started);
    if (isCallError(line)) {
      // A failing sequential call means the fixture is broken, not slow
      throw new Error(`tools/call ${call.tool} failed: ${line.slice(0, 300)}`);
    }
    first ??= line;
  }
  const parallelStarted = performance.now();
  const lines = await Promise.all(
    Array.from({ length: PARALLEL_CALLS }, (_unused, index) =>
      request(1000 + index, 'tools/call', params),
    ),
  );
  return {
    sequentialCallMs: summarize(sequential).median,
    sequentialCallP95Ms: percentile(sequential, 95),
    ...(first === undefined
      ? {}
      : { callResultBytes: resultBytes(first), callTextBytes: textBytes(first) }),
    parallelCallMs: performance.now() - parallelStarted,
    // Calls the server refused under load (its concurrency cap) are counted,
    // not thrown: they are a measured property of the server
    parallelErrors: lines.filter((line) => isCallError(line)).length,
    upstreamConnections: upstream.connections() - connectionsBefore,
  };
};
