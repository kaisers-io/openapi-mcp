import type { RateLimiter } from './rate-limit.ts';
import type { Redactor } from '../redact.ts';
import { describeOperation, lookupOperation, unknownOperationOutcome } from './discovery.ts';
import type { CallInput } from './discovery-schemas.ts';
import { structuredOutcome, textOutcome } from './result.ts';
import { searchOperations } from './search-index.ts';
import type { DispatchResult, ToolCallOutcome } from './result.ts';
import type { ServerSnapshot, SnapshotTool } from './types.ts';
import { validateAndExecute } from './validation.ts';

export type ToolExecutor = (
  tool: SnapshotTool,
  args: unknown,
  signal: AbortSignal,
) => Promise<ToolCallOutcome>;

export type MetaExecutor = (
  snapshot: ServerSnapshot,
  signal: AbortSignal,
) => Promise<ToolCallOutcome>;

export type DispatcherDeps = {
  snapshot: ServerSnapshot;
  limiter: Pick<RateLimiter, 'consume'>;
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
};

// A single, generic, stable message — never the structured content itself —
// for the case a secret is found anywhere inside it. Mirrors
// server/execute/response.ts's own GENERIC_UNSAFE_TEXT wording.
const BOUNDARY_UNSAFE_TEXT = 'tool execution result could not be returned safely';

// The dispatch-boundary finalizer: runs as the LAST step before ANY outcome
// leaves createDispatcher.call. Every content[].text block is redacted; if
// structuredContent is present and a secret is found ANYWHERE inside it, the
// whole structuredContent is dropped and a generic isError is returned
// instead — never a redacted-but-successful envelope, and never a
// partially-redacted structuredContent (redactJson is NOT used here:
// rewriting structured data invites subtly-wrong reserialization; the only
// safe move on a hit is to withhold the data entirely). This runs for EVERY
// outcome, from the meta executor and from any future executor, not only the
// built-in upstream one — a bug in a single executor's own redaction can
// never alone leak a secret past this boundary.
// Fail-closed scan wrapper shared by both call sites in finalizeOutcome:
// scanForSecret can throw on a pathological input (redact.ts's own
// documented contract), and both sites below treat "found a secret" and
// "threw while scanning" identically — matching response.ts's own
// scanSafely contract. Extracting this keeps the try/catch itself intact
// (never converted to `.catch()` — this is a synchronous call, and a
// throwing getter/Proxy on the scanned value must still be caught here,
// not turned into an unhandled rejection or a missed sync throw).
const scanForSecretSafely = (redactor: Redactor, value: unknown): boolean => {
  try {
    return redactor.scanForSecret(value);
  } catch {
    return true;
  }
};

const finalizeOutcome = (outcome: ToolCallOutcome, redactor: Redactor): ToolCallOutcome => {
  if (
    outcome.structuredContent !== undefined &&
    scanForSecretSafely(redactor, outcome.structuredContent)
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
  signal: AbortSignal,
): Promise<ToolCallOutcome> => {
  const input = data as CallInput;
  const target = lookupOperation(deps.snapshot.operationsByName, input.name);
  if (target === undefined) {
    return Promise.resolve(unknownOperationOutcome(input.name));
  }
  return validateAndExecute(target, input.arguments, (targetData) =>
    deps.executor(target, targetData, signal),
  );
};

const runDiscoveryTool = (
  deps: DispatcherDeps,
  tool: SnapshotTool,
  data: unknown,
  signal: AbortSignal,
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
      return callOperation(deps, data, signal);
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
  signal: AbortSignal,
): Promise<ToolCallOutcome> => {
  switch (tool.kind) {
    case 'meta': {
      return deps.metaExecutor(deps.snapshot, signal);
    }
    case 'discovery': {
      return runDiscoveryTool(deps, tool, data, signal);
    }
    case 'upstream': {
      return deps.executor(tool, data, signal);
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
      if (!deps.limiter.consume(deps.now())) {
        return {
          kind: 'outcome',
          outcome: finalizeOutcome(
            textOutcome('rate limit exceeded — too many tool calls; retry later', true),
            deps.redactor,
          ),
        };
      }
      const outcome = await validateAndExecute(tool, request.arguments, (data) =>
        routeExecutor(deps, tool, data, request.signal),
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
