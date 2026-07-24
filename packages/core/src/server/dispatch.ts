import type { RateLimiter } from './rate-limit.ts';
import { sanitizeDisplayText, sanitizeSpecText } from '../spec/sanitize.ts';
import {
  structuredOutcome,
  textOutcome,
  type DispatchResult,
  type ToolCallOutcome,
} from './result.ts';
import type { ServerSnapshot, SnapshotTool } from './types.ts';

// Bounds how many Zod issues are rendered into a validation-failure message —
// defense in depth against a pathological schema producing thousands of
// issues for one call.
const MAX_ISSUE_COUNT = 20;
// A path segment can be a caller-controlled DYNAMIC key (an object schema
// using a catchall/`additionalProperties`), not just a fixed property name —
// cap+sanitize each segment independently so one hostile key cannot itself
// blow the total-LENGTH budget below. Both this cap and MAX_RENDERED_LENGTH
// bound UTF-16 CODE UNITS (`sanitizeSpecText`/`sanitizeDisplayText` truncate
// via JS string `.length`/`.slice`, per `spec/sanitize.ts`) — NOT UTF-8
// bytes and not Unicode code points either (a surrogate pair counts as 2
// code units here, though `truncate` takes care never to split one).
const MAX_PATH_SEGMENT_LENGTH = 40;
// The final rendered string is ALSO capped as a whole (not just by issue
// count) — belt-and-suspenders against a pathological aggregate size even
// after the per-issue and per-segment caps above. 2048 UTF-16 code units —
// see the units note above.
const MAX_RENDERED_LENGTH = 2048;

export type ToolExecutor = (
  tool: SnapshotTool,
  args: unknown,
  signal: AbortSignal,
) => Promise<ToolCallOutcome>;

export type MetaExecutor = (
  snapshot: ServerSnapshot,
  signal: AbortSignal,
) => Promise<ToolCallOutcome>;

export interface DispatcherDeps {
  snapshot: ServerSnapshot;
  limiter: Pick<RateLimiter, 'consume'>;
  now: () => number;
  executor: ToolExecutor;
  metaExecutor: MetaExecutor;
}

export interface CallRequest {
  name: string;
  arguments: unknown;
  signal: AbortSignal;
}

interface ZodIssueLike {
  path: readonly (string | number | symbol)[];
  code: string;
}

// A path SEGMENT can itself be caller-controlled (a dynamic object key from
// a catchall/additionalProperties schema) — sanitize (strip control/bidi)
// AND cap it independently, exactly like any other untrusted spec/caller
// text reaching a display sink (§6.4 untrusted-text rule extended to
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

export const createDispatcher = (
  deps: DispatcherDeps,
): { call: (request: CallRequest) => Promise<DispatchResult> } => ({
  call: async (request: CallRequest): Promise<DispatchResult> => {
    const tool = deps.snapshot.toolsByName.get(request.name);
    if (tool === undefined) {
      return { kind: 'unknown-tool', name: request.name };
    }
    // Rate consume BEFORE validation: a known-but-invalid call still spends
    // budget (ordering decision); an unknown tool never does (handled
    // above, before this point).
    if (!deps.limiter.consume(deps.now())) {
      return {
        kind: 'outcome',
        outcome: textOutcome('rate limit exceeded — too many tool calls; retry later', true),
      };
    }
    let parsed: Awaited<ReturnType<typeof tool.inputSchema.safeParseAsync>>;
    try {
      parsed = await tool.inputSchema.safeParseAsync(request.arguments ?? {});
    } catch {
      // See `PARSE_THREW_OUTCOME` above — a rejection here must never reach the
      // executor and must never surface the thrown value.
      return { kind: 'outcome', outcome: PARSE_THREW_OUTCOME };
    }
    if (!parsed.success) {
      return { kind: 'outcome', outcome: redactedValidationOutcome(parsed.error.issues) };
    }
    let outcome: ToolCallOutcome;
    try {
      outcome =
        tool.kind === 'meta'
          ? await deps.metaExecutor(deps.snapshot, request.signal)
          : await deps.executor(tool, parsed.data, request.signal);
    } catch {
      // Never surface the raw error — it may carry an upstream secret,
      // internal path, or stack detail. A generic, stable message only.
      outcome = textOutcome('tool execution failed unexpectedly', true);
    }
    return { kind: 'outcome', outcome };
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
