import type { RateLimiter } from './rate-limit.ts';
import type { Redactor } from '../redact.ts';
import { retryableErrorOutcome, textOutcome, wasSecretScanned } from './result.ts';
import type { DispatchResult, ToolCallOutcome } from './result.ts';
import { carryOutcomeTag, observeCalls } from './telemetry.ts';
import type { CallObserver, CallTelemetry } from './telemetry.ts';
import type { TraceContext } from './trace.ts';
import type { ServerSnapshot, SnapshotTool } from './types.ts';
import { runDiscoveryTool } from './discovery-route.ts';
import { executeWithEffect, withEffect } from './effect.ts';
import { validateAndExecute } from './validation.ts';
import { imageHasSecret, someDecodedForm, withheld } from './withheld.ts';

export type ToolExecutor = (
  tool: SnapshotTool,
  args: unknown,
  signal: AbortSignal,
  trace?: TraceContext,
  report?: (telemetry: CallTelemetry) => void,
  // The most bytes of a text result; DISPLAY_TEXT_MAX when not set
  textBytes?: number,
) => Promise<ToolCallOutcome>;

export type MetaExecutor = (
  snapshot: ServerSnapshot,
  signal: AbortSignal,
) => Promise<ToolCallOutcome>;

export type DispatcherDeps = {
  snapshot: ServerSnapshot;
  limiter: Pick<RateLimiter, 'consume' | 'retryAfterMs'>;
  now: () => number;
  executor: ToolExecutor;
  metaExecutor: MetaExecutor;
  // The dispatch-boundary redactor. Every outcome this dispatcher returns is
  // finalized through it as the LAST step before returning — the meta
  // executor and any future executor get the same defense, not just the
  // built-in upstream one.
  redactor: Redactor;
  // Receives one record per tools/call (opt-in logging and counters).
  onCall?: CallObserver;
  // The dispatcher itself, set by createDispatcher: execute_code sends each
  // nested call through it, observed like a call from the client
  dispatch?: (request: CallRequest) => Promise<DispatchResult>;
};

export type CallRequest = {
  name: string;
  arguments: unknown;
  signal: AbortSignal;
  // Validated W3C trace context from the request's `_meta` (server/trace.ts).
  trace?: TraceContext;
  // Set by observeCalls (server/telemetry.ts) when call logging is on.
  report?: (telemetry: CallTelemetry) => void;
  // A text result's size limit. An execute_code script's calls raise it: their
  // results never reach the model, and a cut JSON text cannot be parsed
  textBytes?: number;
};

// The dispatch-boundary finalizer, the LAST step before ANY outcome leaves
// createDispatcher.call: every content[].text block is redacted; a secret
// ANYWHERE in structuredContent (or meta) drops it for a generic isError —
// never a redacted-but-successful or partially-redacted envelope (redactJson
// is NOT used: rewriting structured data invites subtly-wrong
// reserialization). It runs for EVERY executor, so a bug in one executor's
// own redaction can never alone leak a secret past this boundary.
// The one exception: a structuredContent object the executor already
// tree-scanned with this SAME redactor (markSecretScanned) is not walked a
// second time — every other result still is.
// Fail-closed scan wrapper shared by both call sites in finalizeOutcome:
// scanForSecret can throw on a pathological input (redact.ts's contract);
// "found a secret" and "threw while scanning" are treated identically, as
// in response.ts's scanSafely. A synchronous try/catch on purpose: a
// throwing getter/Proxy on the scanned value must be caught right here.
const scanForSecretSafely = (redactor: Redactor, value: unknown): boolean => {
  try {
    return redactor.scanForSecret(value);
  } catch {
    return true;
  }
};

// Structured data is checked for the secret's decoded spellings as well
// (a JSON-escaped or entity-escaped echo in a string value), like the
// response mapper does. A text block is not: the mapper already decoded and
// scanned it whole, and decoding it again would double that cost.
const structuredHasSecret = (redactor: Redactor, value: unknown): boolean => {
  try {
    return (
      redactor.scanForSecret(value) ||
      someDecodedForm(value, (form) => redactor.scanForSecret(form))
    );
  } catch {
    return true;
  }
};

const scanAndRedact = (
  outcome: ToolCallOutcome,
  redactor: Redactor,
  readOnly: boolean,
): ToolCallOutcome => {
  if (
    (outcome.structuredContent !== undefined &&
      !wasSecretScanned(outcome.structuredContent, redactor) &&
      structuredHasSecret(redactor, outcome.structuredContent)) ||
    (outcome.meta !== undefined && structuredHasSecret(redactor, outcome.meta))
  ) {
    return withheld(outcome, readOnly);
  }
  // An image cannot be redacted without breaking it: one with a secret in
  // its bytes withholds the whole result, like a structured one
  if (
    outcome.content.some(
      (block) =>
        block.type === 'image' &&
        !wasSecretScanned(block, redactor) &&
        imageHasSecret(redactor, Buffer.from(block.data, 'base64')),
    )
  ) {
    return withheld(outcome, readOnly);
  }
  const redactedContent = outcome.content.map((block) =>
    block.type === 'text' ? { ...block, text: redactor.redactString(block.text) } : block,
  );
  // Rescan after redaction: redactString's single ordered replacement pass
  // can, in composition, still leave or synthesize a registered secret in
  // its own output (e.g. an earlier, longer needle's replacement text can go
  // unchecked against a shorter needle whose turn in the pass already came
  // and went). Rescan the
  // REDACTED text itself before returning it — a hit, or the scan itself
  // throwing, downgrades the whole outcome to the same generic boundary
  // error as the structuredContent branch above, rather than ever returning
  // text that still matches a registered secret.
  if (
    redactedContent.some(
      (block) => block.type === 'text' && scanForSecretSafely(redactor, block.text),
    )
  ) {
    return withheld(outcome, readOnly);
  }
  return carryOutcomeTag(outcome, {
    ...outcome,
    content: redactedContent,
  });
};

// The last step for every outcome: the internal effect note (issue #25) has
// served its purpose and does not leave the dispatcher
// `readOnly`: an execute_code result, which only read-only calls produced
const finalizeOutcome = (
  outcome: ToolCallOutcome,
  redactor: Redactor,
  readOnly = false,
): ToolCallOutcome => {
  const scanned = scanAndRedact(outcome, redactor, readOnly);
  const { effectNote: _note, ...finished } = scanned;
  return carryOutcomeTag(scanned, finished);
};

const routeExecutor = (
  deps: DispatcherDeps,
  tool: SnapshotTool,
  data: unknown,
  request: CallRequest,
): Promise<ToolCallOutcome> => {
  switch (tool.kind) {
    case 'meta': {
      return deps.metaExecutor(deps.snapshot, request.signal);
    }
    case 'discovery': {
      return runDiscoveryTool(deps, tool, data, request);
    }
    case 'upstream': {
      return executeWithEffect(tool, () =>
        deps.executor(tool, data, request.signal, request.trace, request.report, request.textBytes),
      );
    }
  }
};

const createUnobservedDispatcher = (
  deps: DispatcherDeps,
): { call: (request: CallRequest) => Promise<DispatchResult> } => ({
  call: async (request: CallRequest): Promise<DispatchResult> => {
    // Outer try/catch spanning the ENTIRE method body: the lookup/rate stage
    // just below (the `Object.hasOwn(deps.snapshot.toolsByName, ...)` lookup,
    // `deps.now()`, `deps.limiter.consume`) has no inner try/catch of its own, unlike the
    // parse and executor stages further down. Without this outer boundary, a
    // throw from a caller-injected `now()`/`consume()` dependency would
    // propagate raw out of `call()` — carrying whatever message that
    // dependency's own Error happened to have — straight to the protocol
    // layer and out to the client. This catch redacts any such throw to the
    // same generic, stable shape the inner stages already use; it never
    // interferes with a normal `return` from any branch below.
    try {
      const tool = Object.hasOwn(deps.snapshot.toolsByName, request.name)
        ? deps.snapshot.toolsByName[request.name]
        : undefined;
      if (tool === undefined) {
        return { kind: 'unknown-tool', name: request.name };
      }
      // Rate consume BEFORE validation: a known-but-invalid call still spends
      // budget; an unknown tool never does (handled above, before this
      // point).
      const nowMs = deps.now();
      if (!deps.limiter.consume(nowMs)) {
        // Actionable: the text says when, and `_meta` carries the exact wait
        // so a client can schedule the retry instead of guessing.
        const retryAfterMs = deps.limiter.retryAfterMs(nowMs);
        return {
          kind: 'outcome',
          outcome: finalizeOutcome(
            withEffect(
              retryableErrorOutcome('rate limit exceeded — too many tool calls', {
                error: 'rate_limited',
                retryAfterMs,
              }),
              'not_sent',
            ),
            deps.redactor,
          ),
        };
      }
      const outcome = await validateAndExecute(tool, request.arguments, (data) =>
        routeExecutor(deps, tool, data, request),
      );
      return {
        kind: 'outcome',
        outcome: finalizeOutcome(outcome, deps.redactor, tool.discovery === 'execute'),
      };
    } catch {
      // Redacts any throw from the lookup/rate stage above (deps.now/consume,
      // or even the `Object.hasOwn(deps.snapshot.toolsByName, ...)` lookup)
      // so no raw dependency-failure message can ever reach the client.
      return {
        kind: 'outcome',
        outcome: finalizeOutcome(textOutcome('tool call failed unexpectedly', true), deps.redactor),
      };
    }
  },
});

export const createDispatcher = (
  deps: DispatcherDeps,
): { call: (request: CallRequest) => Promise<DispatchResult> } => {
  // The dispatcher hands itself to execute_code, so a nested call is
  // observed and logged like any other
  const self = { call: (request: CallRequest): Promise<DispatchResult> => observed(request) };
  const unobserved = createUnobservedDispatcher({ ...deps, dispatch: self.call });
  const observed =
    deps.onCall === undefined
      ? unobserved.call
      : observeCalls(unobserved.call, deps.onCall, deps.now);
  return self;
};

export { createMetaExecutor } from './meta.ts';
