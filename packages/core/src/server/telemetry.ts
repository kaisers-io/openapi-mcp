import type { Redactor } from '../redact.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { CallRequest } from './dispatch.ts';
import type { DispatchResult, ToolCallOutcome } from './result.ts';

// Opt-in per-call observability: one record per tools/call (dispatcher),
// carrying WHAT happened and how long it took — never arguments, header
// values, URLs with query strings, or bodies. The executor contributes the
// upstream facts it alone knows through a `report` callback; everything else
// is classified from the final outcome.

export type CallOutcomeKind =
  | 'ok'
  | 'http_error'
  | 'response_error'
  // The upstream answered, but the result carried a registered secret and
  // was withheld, by the executor or at the dispatch boundary (the client
  // got an error).
  | 'secret_withheld'
  | 'validation_error'
  // Refused by local policy before any request was sent (cleartext
  // credential gate, outbound size budget) — configuration, not arguments.
  | 'refused'
  // The upstream OAuth2 access token (--upstream-oauth-*) could not be
  // obtained; no API request was sent.
  | 'token_error'
  | 'rate_limited'
  | 'overloaded'
  | 'egress_denied'
  | 'timeout'
  | 'cancelled'
  | 'network_error'
  | 'internal_error';

// What the executor reports about one upstream call.
export type CallTelemetry = {
  outcome: CallOutcomeKind;
  // The operation that ran when it differs from the called tool
  // (call_operation in discover mode); the record's `tool` then names it.
  tool?: string;
  method?: string;
  // The operation's path TEMPLATE (`/pet/{petId}`), never the filled URL.
  pathTemplate?: string;
  status?: number;
  responseBytes?: number;
  queuedMs?: number;
  // From the first request to the final outcome: with --retries this
  // includes every attempt AND the backoff / Retry-After waits between them
  // (see `attempts`), so it measures the call as the client experienced it,
  // not the API's own latency.
  upstreamMs?: number;
  // Upstream API requests sent for this call: 1 + retries, plus the
  // requests of a 401 token replay (--upstream-oauth-*), if one was made.
  attempts?: number;
};

export type CallRecord = CallTelemetry & {
  tool: string;
  latencyMs: number;
};

export type CallObserver = (record: CallRecord) => void;

// Outcomes the dispatcher produces itself (argument validation, a result
// withheld at the boundary) are tagged by object identity where they are
// built, instead of being recognised from their wording. A WeakMap holds no
// reference and adds nothing a client can see.
const outcomeTags = new WeakMap<ToolCallOutcome, CallOutcomeKind>();

export const tagOutcome = (outcome: ToolCallOutcome, kind: CallOutcomeKind): ToolCallOutcome => {
  outcomeTags.set(outcome, kind);
  return outcome;
};

// For a step that rebuilds an outcome (the boundary finalizer): the new
// object keeps the original's tag.
export const carryOutcomeTag = (from: ToolCallOutcome, to: ToolCallOutcome): ToolCallOutcome => {
  const kind = outcomeTags.get(from);
  return kind === undefined ? to : tagOutcome(to, kind);
};

// Outcomes the executor never saw (rate limit, argument validation).
const classifyLocal = (outcome: ToolCallOutcome): CallOutcomeKind => {
  if (!outcome.isError) {
    return 'ok';
  }
  if (outcome.meta?.['openapi-mcp/error'] === 'rate_limited') {
    return 'rate_limited';
  }
  return outcomeTags.get(outcome) ?? 'internal_error';
};

// The executor's report describes the upstream call; the dispatcher can
// still turn a success into an error afterwards (a secret withheld at the
// boundary). The record must say what the CLIENT got, never "ok" for an
// error.
const finalTelemetry = (
  reported: CallTelemetry | undefined,
  outcome: ToolCallOutcome,
): CallTelemetry => {
  if (reported === undefined) {
    return { outcome: classifyLocal(outcome) };
  }
  const tag = outcomeTags.get(outcome);
  if (tag !== undefined) {
    return { ...reported, outcome: tag };
  }
  return outcome.isError && reported.outcome === 'ok'
    ? { ...reported, outcome: 'response_error' }
    : reported;
};

// Wraps a dispatcher's `call`: times it, collects the executor's report,
// and hands one record to `observe`. Unknown tool names are protocol
// errors, not tool calls, and are not recorded. An observer that throws is
// ignored — observability must never change a call's result.
export const observeCalls =
  (
    call: (request: CallRequest) => Promise<DispatchResult>,
    observe: CallObserver,
    now: () => number,
  ): ((request: CallRequest) => Promise<DispatchResult>) =>
  async (request) => {
    const started = now();
    let reported: CallTelemetry | undefined;
    const result = await call({
      ...request,
      report: (telemetry) => {
        reported = telemetry;
      },
    });
    if (result.kind === 'outcome') {
      try {
        observe({
          ...finalTelemetry(reported, result.outcome),
          tool: reported?.tool ?? request.name,
          latencyMs: Math.max(0, now() - started),
        });
      } catch {
        // Never let a logging failure reach the caller.
      }
    }
    return result;
  };

// One JSON line (for stderr) per call. Every string field is sanitized and
// redacted; numbers and the closed `outcome` vocabulary pass as-is.
export const formatCallLog = (record: CallRecord, redactor: Redactor, ts: Date): string => {
  const text = (value: string): string => redactor.redactString(sanitizeSpecText(value, 256));
  return JSON.stringify({
    ts: ts.toISOString(),
    event: 'tool_call',
    tool: text(record.tool),
    ...(record.method === undefined ? {} : { method: text(record.method) }),
    ...(record.pathTemplate === undefined ? {} : { pathTemplate: text(record.pathTemplate) }),
    ...(record.status === undefined ? {} : { status: record.status }),
    outcome: record.outcome,
    latencyMs: record.latencyMs,
    ...(record.responseBytes === undefined ? {} : { responseBytes: record.responseBytes }),
    ...(record.queuedMs === undefined ? {} : { queuedMs: record.queuedMs }),
    ...(record.upstreamMs === undefined ? {} : { upstreamMs: record.upstreamMs }),
    ...(record.attempts === undefined ? {} : { attempts: record.attempts }),
  });
};

export type CallSummary = {
  total: number;
  byOutcome: Record<string, number>;
  // Over the most recent `window` calls that reached the upstream.
  upstreamLatencyMs: { samples: number; p50?: number; p95?: number };
};

export type CallStats = {
  record: CallObserver;
  summary: () => CallSummary;
};

const percentile = (sorted: readonly number[], fraction: number): number | undefined =>
  sorted.length === 0
    ? undefined
    : sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];

// Process-local counters (reset on restart) with a bounded rolling window
// of upstream latencies, so memory stays constant under any call volume.
export const createCallStats = (window = 512): CallStats => {
  let total = 0;
  const byOutcome: Record<string, number> = {};
  const latencies: number[] = [];
  return {
    record: (record) => {
      total += 1;
      byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
      if (record.upstreamMs !== undefined) {
        latencies.push(record.upstreamMs);
        if (latencies.length > window) {
          latencies.shift();
        }
      }
    },
    summary: () => {
      const sorted = latencies.toSorted((first, second) => first - second);
      const p50 = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      return {
        total,
        byOutcome: { ...byOutcome },
        upstreamLatencyMs: {
          samples: sorted.length,
          ...(p50 === undefined ? {} : { p50 }),
          ...(p95 === undefined ? {} : { p95 }),
        },
      };
    },
  };
};
