import { randomUUID } from 'node:crypto';
import type { HopHeaders, HopRefusal } from '../../http/pinned-dispatcher.ts';
import { DISPLAY_TEXT_MAX, sanitizeSpecText } from '../../spec/sanitize.ts';
import { withEffect } from '../effect.ts';
import { textOutcome } from '../result.ts';
import type { ToolCallOutcome } from '../result.ts';
import type { CallTelemetry } from '../telemetry.ts';
import type { TraceContext } from '../trace.ts';
import type { RuntimeTool } from '../types.ts';
import type { ExecutorConfig } from './executor.ts';
import { hopAuthorizer } from './hop-authorizer.ts';
import { buildRequest } from './request.ts';
import type { BuiltRequest } from './request.ts';
import { MAX_RETRIES } from './retry.ts';
import { routeKey } from './route-table.ts';
import { resolveUploads } from './uploads.ts';
import type { Uploads } from './uploads.ts';
import { assembleHeaders, cleartextBlocked, joinFinalUrl, withinBasePath } from './wire.ts';

// Everything an upstream call does before it sends (issue #78): the base URL,
// the cleartext gate, uploads, the request itself, the reserved-header and
// base-URL guards, and the header sets. The executor sends what this returns;
// `call --dry-run` describes it instead. A refusal sends nothing.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// A single, stable, redacted prefix for every failure this module produces —
// never the underlying detail, which could carry a hostname, header name, or
// library-internal message never meant for a tool-call response.
export const isError = (message: string): ToolCallOutcome =>
  textOutcome(`tool execution failed: ${message}`, true);

// A refusal before anything was sent (issue #25)
export const unsent = (message: string): ToolCallOutcome =>
  withEffect(isError(message), 'not_sent');

const refuse = (message: string): { refused: ToolCallOutcome } => ({ refused: unsent(message) });

export type PreparedCall = {
  method: string;
  base: URL;
  // The arguments with every named upload replaced by its bytes
  data: Record<string, unknown>;
  built: BuiltRequest;
  finalUrl: URL;
  authorizeHop: ((url: URL, method: string, hop: number) => HopRefusal | undefined) | undefined;
  retries: number;
  idempotencyKeyField: boolean;
  generatedKey: string | undefined;
  // The header sets of one send with the given bearer token, before the
  // final budget check
  assemble: (bearer?: string) => HopHeaders;
};

// The base URL and the cleartext gate, before an upload is read
export const checkBase = (
  config: ExecutorConfig,
  generated: RuntimeTool,
  report: (telemetry: CallTelemetry) => void,
): { base: URL } | { refused: ToolCallOutcome } => {
  // Imperative on purpose (security-module rule: no control-flow
  // restructuring / helper extraction across a guard boundary here):
  // `new URL` can throw synchronously on a malformed string, and the catch
  // branch below returns early — extracting this into a helper that returns
  // a tagged result would move the try/catch across this function's own
  // early-return boundary for no provable benefit.
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    // Defensive: baseUrl is resolved and validated before this point.
    report({ outcome: 'internal_error' });
    return refuse('the configured base URL is invalid');
  }
  if (cleartextBlocked(config, base)) {
    // Operator policy, not a bad argument: counted as `refused`.
    report({
      outcome: 'refused',
      method: generated.operation.method.toUpperCase(),
      pathTemplate: generated.operation.path,
    });
    return refuse(
      'refusing to send a secret header in cleartext over a non-loopback http:// origin (pass --allow-insecure-http to override)',
    );
  }
  return { base };
};

// The arguments with every named upload replaced by its bytes. A named
// upload is read before anything is sent; a refusal sends nothing. The
// executor calls this only with --uploads, so a call without one takes no
// extra turn of the event loop.
export const readCallUploads = async (
  uploads: Uploads,
  generated: RuntimeTool,
  args: unknown,
  report: (telemetry: CallTelemetry) => void,
): Promise<{ data: Record<string, unknown> } | { refused: ToolCallOutcome }> => {
  const uploaded = await resolveUploads(callArguments(args), generated.mapper, uploads);
  if ('error' in uploaded) {
    report({ outcome: 'validation_error' });
    return refuse(sanitizeSpecText(uploaded.error, DISPLAY_TEXT_MAX));
  }
  return { data: uploaded.ok };
};

export const callArguments = (args: unknown): Record<string, unknown> =>
  isRecord(args) ? args : {};

// The request itself and every guard on it, from the uploaded arguments
export const prepareCall = (
  config: ExecutorConfig,
  generated: RuntimeTool,
  base: URL,
  data: Record<string, unknown>,
  trace?: TraceContext,
): { prepared: PreparedCall } | { refused: ToolCallOutcome } => {
  const method = generated.operation.method.toUpperCase();
  const result = buildRequest(
    generated.mapper,
    method,
    generated.operation.path,
    data,
    config.outboundBudgets,
  );
  if ('error' in result) {
    // `buildRequest`'s `{error}` strings embed spec-derived text verbatim
    // (e.g. `mapping.wireName`, a hostile spec's own param name) — see
    // request.ts's own comment on wireName being untrusted text. The
    // dispatcher's finalizeOutcome redacts SECRETS but never strips
    // control/bidi characters, so a spec field named with e.g. an RLO
    // (U+202E) would otherwise echo raw in this outcome's text. This is the
    // single choke point where every buildRequest error becomes a tool
    // outcome, so sanitizeSpecText here (the untrusted-text rule) covers
    // every wireName-bearing message from this module in one place.
    return refuse(sanitizeSpecText(result.error, DISPLAY_TEXT_MAX));
  }
  const built = result.ok;
  // DEFENSIVE reserved-name check, mandatory rather than merely defensive in
  // effect: toolgen/layout.ts already drops any reserved header name from a
  // tool's input schema at build time, so this is unreachable through the
  // real pipeline — but it is re-checked here fail-closed rather than ever
  // trusting that upstream guard silently. HTTP header names are
  // case-insensitive, so the comparison lowercases the built name itself:
  // today this is correct even without the `.toLowerCase()` because
  // buildRequest already lowercases built header keys and resolveApiConfig
  // already lowercases reservedHeaderNames — but this is the mandatory
  // auth-collision gate and must not depend on those unstated upstream
  // invariants for a security guard.
  for (const name of Object.keys(built.headers)) {
    if (config.reservedHeaderNames.has(name.toLowerCase())) {
      return refuse('a tool argument collided with a reserved header name');
    }
  }
  const finalUrl = joinFinalUrl(base, built.pathname, built.query);
  if (finalUrl === undefined) {
    return refuse('the final request URL could not be constructed');
  }
  if (finalUrl.origin !== base.origin || !withinBasePath(finalUrl.pathname, base.pathname)) {
    return refuse('the final request URL escaped the configured base URL');
  }
  const authorizeHop =
    config.routes === undefined
      ? undefined
      : hopAuthorizer(
          config.routes,
          base,
          routeKey(method, generated.operation.path),
          config.allowOffsiteRedirects === true,
        );
  const { accept } = generated;
  const retries = Math.min(config.retries ?? 0, MAX_RETRIES);
  const idempotencyKeyField = Object.values(generated.mapper.fields).some(
    (mapping) =>
      mapping.destination === 'header' && mapping.wireName.toLowerCase() === 'idempotency-key',
  );
  const keyed = retries > 0 && idempotencyKeyField && (method === 'POST' || method === 'PATCH');
  // ONE key per tool call, identical on every attempt (a 401 token replay
  // included) — the caller's own value when it passed one, else this fresh
  // UUID — so the upstream can deduplicate a retried write.
  const generatedKey = keyed ? randomUUID() : undefined;
  const assemble = (bearer?: string): HopHeaders => {
    const headers = assembleHeaders(config, accept, built.contentType, built.headers, bearer);
    if (config.propagateTraceContext === true && trace !== undefined) {
      // Same-origin set only: a trace id is client correlation data, and a
      // redirect to a foreign origin must not receive it. `traceparent` and
      // `tracestate` are reserved tool-header names, so only an operator's
      // own --header could already hold them — and that one wins.
      for (const [name, value] of Object.entries(trace)) {
        headers.sameOriginHeaders[name] ??= value;
      }
    }
    if (generatedKey !== undefined) {
      headers.sameOriginHeaders['idempotency-key'] ??= generatedKey;
    }
    return headers;
  };
  return {
    prepared: {
      method,
      base,
      data,
      built,
      finalUrl,
      authorizeHop,
      retries,
      idempotencyKeyField,
      generatedKey,
      assemble,
    },
  };
};
