// The queue and OAuth scenarios of the warm session (issue #22). Each one
// times a burst and checks, on every sample, that the server did what it
// must: a burst that went wrong fails the sample rather than reading as fast.
// The exact contracts are tested in packages/cli/test/serve-queue.test.ts
// and serve-oauth.test.ts; these measure how long the work takes.

import { setTimeout as sleep } from 'node:timers/promises';
import type { ToolCall } from './fixtures.ts';
import type { SessionSample } from './session.ts';
import type { Upstream } from './upstream.ts';
import { isCallError } from './workloads.ts';

type Request = (id: number, method: string, params: Record<string, unknown>) => Promise<string>;

// --max-concurrency 16 by default, and 4 x 16 calls wait in the queue
export const QUEUE_CAPACITY = 80;
const IN_FLIGHT = 16;
const WAIT_MS = 30_000;

const waitUntil = async (predicate: () => boolean, what: string): Promise<void> => {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > WAIT_MS) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(5);
  }
};

const burst = (request: Request, call: ToolCall, first: number, count: number) =>
  Array.from({ length: count }, (_unused, index) =>
    request(first + index, 'tools/call', { name: call.tool, arguments: call.args }),
  );

// The queue filled to the last place: the upstream holds the calls in
// flight, one call past the capacity is refused while it holds, then the
// release drains every queued call. Sent last, the extra call is read after
// the others are queued, as the server reads stdin in order.
export const runQueueBurst = async (
  request: Request,
  upstream: Upstream,
  call: ToolCall,
): Promise<Pick<SessionSample, 'queueDrainMs'>> => {
  upstream.setResponse(call.response);
  upstream.hold();
  try {
    const answers = burst(request, call, 20_000, QUEUE_CAPACITY);
    const overflow = await request(29_999, 'tools/call', { name: call.tool, arguments: call.args });
    if (!isCallError(overflow) || !overflow.includes('overloaded')) {
      throw new Error(`the call past the queue was not refused: ${overflow.slice(0, 300)}`);
    }
    await waitUntil(() => upstream.waiting() === IN_FLIGHT, `${String(IN_FLIGHT)} calls in flight`);
    const released = performance.now();
    upstream.release();
    const lines = await Promise.all(answers);
    const drainMs = performance.now() - released;
    const failed = lines.filter((line) => isCallError(line));
    if (failed.length > 0) {
      throw new Error(
        `${String(failed.length)} queued calls failed: ${failed[0]?.slice(0, 300) ?? ''}`,
      );
    }
    return { queueDrainMs: drainMs };
  } finally {
    upstream.release();
  }
};

const allSucceed = async (answers: readonly Promise<string>[], what: string): Promise<void> => {
  const lines = await Promise.all(answers);
  const failed = lines.filter((line) => isCallError(line));
  if (failed.length > 0) {
    throw new Error(
      `${what}: ${String(failed.length)} calls failed: ${failed[0]?.slice(0, 300) ?? ''}`,
    );
  }
};

// The OAuth2 token lifecycle: 16 calls of a fresh process wait for one token
// that comes late, then 16 calls meet a revoked token, which costs one new
// token and one replay each. Both must take exactly one token request.
export const runOAuthBursts = async (
  request: Request,
  upstream: Upstream,
  call: ToolCall,
): Promise<Pick<SessionSample, 'oauthColdBurstMs' | 'oauthRefreshBurstMs'>> => {
  upstream.setResponse(call.response);
  upstream.oauth.requireTokens(true);
  upstream.oauth.setTokenDelay(200);
  try {
    const before = upstream.oauth.tokenRequests();
    const coldStarted = performance.now();
    await allSucceed(burst(request, call, 30_000, IN_FLIGHT), 'with a late token');
    const coldMs = performance.now() - coldStarted;
    upstream.oauth.setTokenDelay(0);
    upstream.oauth.revokeAll();
    const refreshStarted = performance.now();
    await allSucceed(burst(request, call, 31_000, IN_FLIGHT), 'with a revoked token');
    const refreshMs = performance.now() - refreshStarted;
    const tokens = upstream.oauth.tokenRequests() - before;
    if (tokens !== 2) {
      throw new Error(`expected one token request per burst, got ${String(tokens)} for two`);
    }
    return { oauthColdBurstMs: coldMs, oauthRefreshBurstMs: refreshMs };
  } finally {
    upstream.oauth.requireTokens(false);
    upstream.oauth.setTokenDelay(0);
  }
};
