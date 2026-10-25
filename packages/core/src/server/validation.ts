import { sanitizeDisplayText, sanitizeSpecText } from '../spec/sanitize.ts';
import { textOutcome } from './result.ts';
import { tagOutcome } from './telemetry.ts';
import type { ToolCallOutcome } from './result.ts';
import type { SnapshotTool } from './types.ts';
import { withEffect } from './effect.ts';

// Argument validation for a tool call, the redacted rendering of its
// failures, and the guarded executor call that follows. Moved out of
// dispatch.ts (the rendering unchanged) when call_operation (issue
// kaisers-io/openapi-mcp-archive#38) became a second caller: a direct tool call
// and call_operation share this one validate-then-execute tail, so the same
// arguments produce the same outcome through either entry point.

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
  return tagOutcome(
    textOutcome(sanitizeDisplayText(rendered, MAX_RENDERED_LENGTH), true),
    'validation_error',
  );
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
const PARSE_THREW_OUTCOME: ToolCallOutcome = tagOutcome(
  textOutcome('invalid tool arguments: unable to validate the request', true),
  'validation_error',
);

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

// Runs an executor step and never lets a raw throw escape — the raw error
// may carry an upstream secret, internal path, or stack detail, so only a
// generic, stable outcome is ever produced on failure.
const runGuarded = async (run: () => Promise<ToolCallOutcome>): Promise<ToolCallOutcome> => {
  try {
    return await run();
  } catch {
    // Never surface the raw error — it may carry an upstream secret,
    // internal path, or stack detail. A generic, stable message only.
    return textOutcome('tool execution failed unexpectedly', true);
  }
};

// Validates `args` against `tool`'s own closed schema, then runs the
// executor — the shared tail of a direct tool call and of call_operation.
// Validation failures render through the one redactedValidationOutcome, so
// both entry points produce the same message for the same arguments.
export const validateAndExecute = async (
  tool: SnapshotTool,
  args: unknown,
  execute: (data: unknown) => Promise<ToolCallOutcome>,
): Promise<ToolCallOutcome> => {
  const attempt = await attemptParse(tool, args);
  // Refused before the executor runs: nothing was sent (issue #25)
  if (attempt.threw) {
    // See `PARSE_THREW_OUTCOME` above — a rejection here must never reach the
    // executor and must never surface the thrown value.
    return withEffect(PARSE_THREW_OUTCOME, 'not_sent');
  }
  const { parsed } = attempt;
  if (!parsed.success) {
    return withEffect(redactedValidationOutcome(parsed.error.issues), 'not_sent');
  }
  return runGuarded(() => execute(parsed.data));
};
