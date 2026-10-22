import type { RateLimiter } from './rate-limit.ts';
import type { Redactor } from '../redact.ts';
import { describeOperation, lookupOperation, unknownOperationOutcome } from './discovery.ts';
import type { CallInput } from './discovery-schemas.ts';
import {
  retryableErrorOutcome,
  structuredOutcome,
  textOutcome,
  wasSecretScanned,
} from './result.ts';
import { searchOperations } from './search-index.ts';
import type { DispatchResult, ToolCallOutcome } from './result.ts';
import type { TraceContext } from './trace.ts';
import type { ServerSnapshot, SnapshotTool } from './types.ts';
import { validateAndExecute } from './validation.ts';

export type ToolExecutor = (
  tool: SnapshotTool,
  args: unknown,
  signal: AbortSignal,
  trace?: TraceContext,
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
};

export type CallRequest = {
  name: string;
  arguments: unknown;
  signal: AbortSignal;
  // Validated W3C trace context from the request's `_meta` (server/trace.ts).
  trace?: TraceContext;
};

// A single, generic, stable message — never the structured content itself —
// for the case a secret is found anywhere inside it. Mirrors
// server/execute/response.ts's own GENERIC_UNSAFE_TEXT wording.
const BOUNDARY_UNSAFE_TEXT = 'tool execution result could not be returned safely';

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

const finalizeOutcome = (outcome: ToolCallOutcome, redactor: Redactor): ToolCallOutcome => {
  if (
    (outcome.structuredContent !== undefined &&
      !wasSecretScanned(outcome.structuredContent, redactor) &&
      scanForSecretSafely(redactor, outcome.structuredContent)) ||
    (outcome.meta !== undefined && scanForSecretSafely(redactor, outcome.meta))
  ) {
    return textOutcome(BOUNDARY_UNSAFE_TEXT, true);
  }
  const redactedContent = outcome.content.map((block) => ({
    ...block,
    text: redactor.redactString(block.text),
  }));
  // Rescan after redaction: redactString's single ordered replacement pass
  // can, in composition, still leave or synthesize a registered secret in
  // its own output (e.g. an earlier, longer needle's replacement text can go
  // unchecked against a shorter needle whose turn in the pass already came
  // and went). Rescan the
  // REDACTED text itself before returning it — a hit, or the scan itself
  // throwing, downgrades the whole outcome to the same generic boundary
  // error as the structuredContent branch above, rather than ever returning
  // text that still matches a registered secret.
  if (redactedContent.some((block) => scanForSecretSafely(redactor, block.text))) {
    return textOutcome(BOUNDARY_UNSAFE_TEXT, true);
  }
  return {
    ...outcome,
    content: redactedContent,
  };
};

// The call_operation path: resolve the target among the snapshot's EXPOSED
// operations only (an operation a filter excluded was never built, so it is
// unknown here exactly as it is to a direct call), then run the target
// through the same validate-then-execute tail as a direct call of that tool.
// The rate limit was already charged once for this call_operation call by
// createDispatcher.call and is not charged again; the dispatch-boundary
// redaction runs once, on the outcome returned from there.
const callOperation = (
  deps: DispatcherDeps,
  data: unknown,
  { signal, trace }: CallRequest,
): Promise<ToolCallOutcome> => {
  const input = data as CallInput;
  const target = lookupOperation(deps.snapshot.operationsByName, input.name);
  if (target === undefined) {
    return Promise.resolve(unknownOperationOutcome(input.name));
  }
  return validateAndExecute(target, input.arguments, (targetData) =>
    deps.executor(target, targetData, signal, trace),
  );
};

const runDiscoveryTool = (
  deps: DispatcherDeps,
  tool: SnapshotTool,
  data: unknown,
  request: CallRequest,
): Promise<ToolCallOutcome> => {
  switch (tool.discovery) {
    case 'search': {
      return deps.snapshot.searchIndex === undefined
        ? Promise.resolve(textOutcome('tool execution failed unexpectedly', true))
        : Promise.resolve(searchOperations(deps.snapshot.searchIndex, data));
    }
    case 'describe': {
      return Promise.resolve(describeOperation(deps.snapshot.operationsByName, data));
    }
    case 'call': {
      return callOperation(deps, data, request);
    }
    default: {
      return Promise.resolve(textOutcome('tool execution failed unexpectedly', true));
    }
  }
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
      return deps.executor(tool, data, request.signal, request.trace);
    }
  }
};

export const createDispatcher = (
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
            retryableErrorOutcome('rate limit exceeded — too many tool calls', {
              error: 'rate_limited',
              retryAfterMs,
            }),
            deps.redactor,
          ),
        };
      }
      const outcome = await validateAndExecute(tool, request.arguments, (data) =>
        routeExecutor(deps, tool, data, request),
      );
      return { kind: 'outcome', outcome: finalizeOutcome(outcome, deps.redactor) };
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

export const createMetaExecutor = (): MetaExecutor => (snapshot) => {
  const { meta } = snapshot;
  const payload = {
    specTitle: meta.specTitle,
    specVersion: meta.specVersion,
    displaySource: meta.displaySource,
    toolCount: meta.toolCount,
    omittedCount: meta.omittedCount,
    omittedReasons: meta.omittedReasons,
    acceptedContentHash: meta.acceptedContentHash,
    deadPatternCount: meta.deadPatternCount,
  };
  return Promise.resolve(structuredOutcome(JSON.stringify(payload), payload));
};
