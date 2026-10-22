import type { RateLimiter } from './rate-limit.ts';
import type { Redactor } from '../redact.ts';
import { sanitizeDisplayText, sanitizeSpecText } from '../spec/sanitize.ts';
import {
  retryableErrorOutcome,
  structuredOutcome,
  textOutcome,
  wasSecretScanned,
} from './result.ts';
import type { DispatchResult, ToolCallOutcome } from './result.ts';
import type { TraceContext } from './trace.ts';
import type { ServerSnapshot, SnapshotTool } from './types.ts';

// Bounds how many Zod issues are rendered into a validation-failure message —
// defense in depth against a pathological schema producing thousands of
// issues for one call.
const MAX_ISSUE_COUNT = 20;
// A path segment can be a caller-controlled DYNAMIC key (a catchall /
// `additionalProperties` schema) — cap+sanitize each segment so one hostile
// key cannot blow the total-LENGTH budget below. Both caps bound UTF-16 CODE
// UNITS (`spec/sanitize.ts` truncates via `.length`/`.slice`), not UTF-8
// bytes or code points (`truncate` never splits a surrogate pair).
const MAX_PATH_SEGMENT_LENGTH = 40;
// The final rendered string is ALSO capped as a whole (2048 UTF-16 code
// units, see above) — belt-and-suspenders against a pathological total.
const MAX_RENDERED_LENGTH = 2048;

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

type ZodIssueLike = {
  path: readonly (string | number | symbol)[];
  code: string;
};

// A path SEGMENT can itself be caller-controlled (a dynamic object key from
// a catchall/additionalProperties schema) — sanitize (strip control/bidi)
// AND cap it independently, exactly like any other untrusted spec/caller
// text reaching a display sink (the untrusted-text rule extended to
// caller-supplied data, not just spec text).
const renderPathSegment = (segment: string | number | symbol): string =>
  sanitizeSpecText(String(segment), MAX_PATH_SEGMENT_LENGTH);

// Capped PATHS and CODES only. NEVER `issue.message` (Zod 4's own default
// messages can embed a rendering of the received value — e.g. an enum
// mismatch's message is "Invalid option: expected one of ...", which
// includes the caller's actual submitted string) and NEVER the raw
// submitted value directly. `code` is one of Zod's own small closed
// issue-code enum (e.g. "invalid_type", "invalid_value") — never
// caller-influenced, so it needs no sanitization. Issues are capped at
// MAX_ISSUE_COUNT; the fully-assembled string is ALSO capped at
// MAX_RENDERED_LENGTH via sanitizeDisplayText (which preserves the "\n"
// structure between lines, unlike sanitizeSpecText, which would collapse it
// to spaces) — two independent caps because either a huge issue COUNT or a
// huge aggregate PATH length could otherwise inflate the outcome unbounded.
const redactedValidationOutcome = (issues: readonly ZodIssueLike[]): ToolCallOutcome => {
  const capped = issues.slice(0, MAX_ISSUE_COUNT);
  const lines = capped.map((issue) => {
    const path = issue.path.map(renderPathSegment).join('.') || '(root)';
    return `${path}: ${issue.code}`;
  });
  // The overflow note goes on its OWN line, never appended to the last
  // rendered issue's line: each of the (up to MAX_ISSUE_COUNT) issue lines
  // must remain independently matchable by a caller/test as `<path>:
  // <code>` with nothing trailing — appending "(+N more)" directly to the
  // 20th line would make IT alone diverge in shape from lines 1-19, which
  // is both an inconsistent rendering and (concretely) breaks a
  // line-anchored regex like `^field\d+: invalid_type$` for exactly that
  // one line (see `caps a validation failure at 20 rendered issues total`).
  const suffix = issues.length > capped.length ? `\n(+${issues.length - capped.length} more)` : '';
  const rendered = `invalid tool arguments:\n${lines.join('\n')}${suffix}`;
  return textOutcome(sanitizeDisplayText(rendered, MAX_RENDERED_LENGTH), true);
};

// `safeParseAsync` does not only RESOLVE with `{ success: false }` on a bad shape —
// a REJECTION is also possible (a throwing getter/Proxy trap on the caller-supplied
// `arguments`, or a throwing Zod refinement/transform). A thrown value here is just as
// untrusted as a rejected parse's issues — a caller-supplied secret (the throwing
// getter itself) or an internal detail (a library's own Error#message) could be
// carried by it — so nothing about the thrown value is ever rendered below. This is a
// fixed, generic outcome (no per-issue detail is available, since parsing never
// completed), matching the same redacted "invalid tool arguments" isError shape the
// ordinary validation-failure path returns.
const PARSE_THREW_OUTCOME: ToolCallOutcome = textOutcome(
  'invalid tool arguments: unable to validate the request',
  true,
);

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

// Wraps `safeParseAsync`'s own throw case (see `PARSE_THREW_OUTCOME` above):
// a rejection — or a synchronous throw from a throwing getter/Proxy on the
// caller-supplied arguments — must never reach the executor and must never
// surface the thrown value. Returning a tagged result (rather than letting
// the throw propagate) keeps the try/catch itself exactly where it was,
// just named, so the call site below no longer needs an outer `let`.
const attemptParse = async (
  tool: SnapshotTool,
  args: unknown,
): Promise<
  | { threw: true }
  | { threw: false; parsed: Awaited<ReturnType<typeof tool.inputSchema.safeParseAsync>> }
> => {
  try {
    return { threw: false, parsed: await tool.inputSchema.safeParseAsync(args ?? {}) };
  } catch {
    return { threw: true };
  }
};

// Runs the routed executor and never lets a raw throw escape — see the call
// site's own comment: the raw error may carry an upstream secret, internal
// path, or stack detail, so only a generic, stable outcome is ever produced
// on failure. Same try/catch as before, just named.
const runRoutedExecutor = async (
  deps: DispatcherDeps,
  tool: SnapshotTool,
  data: unknown,
  { signal, trace }: CallRequest,
): Promise<ToolCallOutcome> => {
  try {
    return tool.kind === 'meta'
      ? await deps.metaExecutor(deps.snapshot, signal)
      : await deps.executor(tool, data, signal, trace);
  } catch {
    // Never surface the raw error — it may carry an upstream secret,
    // internal path, or stack detail. A generic, stable message only.
    return textOutcome('tool execution failed unexpectedly', true);
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
      const attempt = await attemptParse(tool, request.arguments);
      if (attempt.threw) {
        // See `PARSE_THREW_OUTCOME` above — a rejection here must never reach the
        // executor and must never surface the thrown value.
        return { kind: 'outcome', outcome: finalizeOutcome(PARSE_THREW_OUTCOME, deps.redactor) };
      }
      const { parsed } = attempt;
      if (!parsed.success) {
        return {
          kind: 'outcome',
          outcome: finalizeOutcome(redactedValidationOutcome(parsed.error.issues), deps.redactor),
        };
      }
      const outcome = await runRoutedExecutor(deps, tool, parsed.data, request);
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
