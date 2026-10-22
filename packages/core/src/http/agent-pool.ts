import { Agent, Pool } from 'undici';
import { pinnedLookup } from './pinned-dispatcher.ts';
import type { PinnedPolicy } from './pinned-dispatcher.ts';

// A bounded pool of long-lived pinned undici Agents, so consecutive tool
// calls to the same upstream reuse TCP/TLS connections instead of paying a
// fresh handshake per call (an Agent built and closed per hop never reuses
// anything).
//
// The SSRF guarantees do not depend on a per-call Agent: undici calls
// `connect.lookup` for EVERY new socket, so every newly opened connection
// still resolves through pinnedLookup and has every DNS answer validated by
// classifyAddress before it exists. What pooling changes is only that an
// already-validated, already-open socket is reused — standard HTTP client
// behaviour — and that reuse is bounded below by an idle timeout and an
// agent TTL, so a pooled socket cannot outlive a DNS change indefinitely.
//
// Pool identity is (origin, trusted, allowPrivateNetwork): an Agent is
// never shared across policy contexts, so hop 0 to the trusted base origin
// (trusted: true) and any redirect hop (always trusted: false) can never
// land on the same Agent — even when the redirect points back to the base
// origin.

export type PinnedAgentPoolOptions = {
  // The narrow resolver from PinnedDeps. A long-lived Agent must not
  // capture one call's AbortSignal (it would abort lookups for every later
  // call and keep the first call's signal reachable), so each lookup gets
  // its own `timeoutSignal(lookupTimeoutMs)` instead; per-call cancellation
  // is the `signal` pinnedRequest passes to fetch.
  resolve: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  timeoutSignal: (ms: number) => AbortSignal;
  lookupTimeoutMs: number;
  // Per-Agent connection cap (per origin, since every Agent serves one
  // origin). Matches the executor's global concurrency cap.
  connections: number;
  // Idle keep-alive for a pooled socket. Also caps server Keep-Alive hints
  // (keepAliveMaxTimeout), so an upstream cannot stretch it.
  keepAliveTimeoutMs?: number;
  // An Agent older than this is retired on the next acquire (gracefully
  // closed: in-flight requests finish, idle sockets go), so even a busy
  // socket is re-established — and its DNS re-validated — at least this
  // often.
  ttlMs?: number;
  // Cap on distinct pooled Agents; the least-recently-used one is retired
  // when a new key would exceed it.
  maxAgents?: number;
  // Injectable clock for the TTL (tests).
  now?: () => number;
};

export type PinnedAgentPool = {
  acquire: (origin: string, policy: PinnedPolicy) => Agent;
  // Number of live (non-retired) pooled Agents.
  size: () => number;
  // Shutdown: destroys every pooled and retiring Agent (aborting anything
  // still in flight — at shutdown no client is left to read a result), so
  // no socket keeps the process alive. acquire after close throws.
  close: () => Promise<void>;
};

export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 30_000;
export const DEFAULT_AGENT_TTL_MS = 5 * 60_000;
export const DEFAULT_MAX_AGENTS = 32;

// `origins` are the per-origin undici Pools the Agent built (via its
// `factory`), kept so shutdown can destroy them directly: undici's
// Agent.close() forgets its per-origin Pools immediately, so a later
// Agent.destroy() on a retired, still-draining Agent no longer reaches them.
type Entry = { agent: Agent; origins: Set<Pool>; createdAt: number };

const poolKey = (origin: string, policy: PinnedPolicy): string =>
  `${origin} trusted=${String(policy.trusted)} private=${String(policy.allowPrivateNetwork)}`;

export const createPinnedAgentPool = (options: PinnedAgentPoolOptions): PinnedAgentPool => {
  const keepAliveTimeout = options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_AGENT_TTL_MS;
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
  const now = options.now ?? Date.now;
  // Map iteration order is insertion order; re-inserting on every acquire
  // keeps the least-recently-used entry first.
  const entries = new Map<string, Entry>();
  // Retired Agents still draining their in-flight requests (graceful
  // close()); tracked so shutdown can destroy them too instead of leaving a
  // socket open past close().
  const retiring = new Set<Entry>();
  let closed = false;

  const drain = async (entry: Entry): Promise<void> => {
    try {
      await entry.agent.close();
    } catch {
      // A close() rejection (e.g. already destroyed by shutdown) leaves
      // nothing further to release.
    } finally {
      retiring.delete(entry);
    }
  };

  // Detached on purpose: retire() runs synchronously inside acquire(), which
  // must hand back an Agent without awaiting the old one's in-flight
  // requests.
  const retire = (key: string, entry: Entry): void => {
    entries.delete(key);
    retiring.add(entry);
    void drain(entry);
  };

  const acquire = (origin: string, policy: PinnedPolicy): Agent => {
    if (closed) {
      throw new Error('the upstream connection pool is closed');
    }
    const at = now();
    for (const [key, entry] of entries) {
      if (at - entry.createdAt >= ttlMs) {
        retire(key, entry);
      }
    }
    const key = poolKey(origin, policy);
    const existing = entries.get(key);
    if (existing !== undefined) {
      entries.delete(key);
      entries.set(key, existing);
      return existing.agent;
    }
    while (entries.size >= maxAgents) {
      const [oldestKey, oldest] = entries.entries().next().value as [string, Entry];
      retire(oldestKey, oldest);
    }
    const origins = new Set<Pool>();
    const agent = new Agent({
      // One origin per Agent by construction (the pool key includes it);
      // a second origin would mean a mis-keyed caller, so undici refuses it
      // rather than silently mixing origins on one policy's Agent.
      maxOrigins: 1,
      factory: (factoryOrigin, factoryOptions) => {
        const dispatcher = new Pool(factoryOrigin, factoryOptions);
        origins.add(dispatcher);
        return dispatcher;
      },
      connections: options.connections,
      keepAliveTimeout,
      keepAliveMaxTimeout: keepAliveTimeout,
      connect: {
        lookup: pinnedLookup(policy, (hostname) =>
          options.resolve(hostname, options.timeoutSignal(options.lookupTimeoutMs)),
        ),
      },
    });
    entries.set(key, { agent, origins, createdAt: at });
    return agent;
  };

  const close = async (): Promise<void> => {
    closed = true;
    const dispatchers: (Agent | Pool)[] = [];
    for (const entry of [...entries.values(), ...retiring]) {
      dispatchers.push(entry.agent, ...entry.origins);
    }
    entries.clear();
    retiring.clear();
    await Promise.all(
      dispatchers.map(async (dispatcher) => {
        await dispatcher.destroy().catch(() => {});
      }),
    );
  };

  return { acquire, size: () => entries.size, close };
};
