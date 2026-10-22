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
  | 'validation_error'
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
  method?: string;
  // The operation's path TEMPLATE (`/pet/{petId}`), never the filled URL.
  pathTemplate?: string;
  status?: number;
  responseBytes?: number;
  queuedMs?: number;
  upstreamMs?: number;
};

export type CallRecord = CallTelemetry & {
  tool: string;
  latencyMs: number;
};

export type CallObserver = (record: CallRecord) => void;

const VALIDATION_PREFIX = 'invalid tool arguments';

// Outcomes the executor never saw (rate limit, argument validation) are
// recognised from the dispatcher's own fixed outcomes.
const classifyLocal = (outcome: ToolCallOutcome): CallOutcomeKind => {
  if (!outcome.isError) {
    return 'ok';
  }
  if (outcome.meta?.['openapi-mcp/error'] === 'rate_limited') {
    return 'rate_limited';
  }
  return outcome.content[0]?.text.startsWith(VALIDATION_PREFIX) === true
    ? 'validation_error'
    : 'internal_error';
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
          ...(reported ?? { outcome: classifyLocal(result.outcome) }),
          tool: request.name,
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
