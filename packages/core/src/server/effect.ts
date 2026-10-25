import { textOutcome } from './result.ts';
import type { EffectNote, ToolCallOutcome } from './result.ts';
import { carryOutcomeTag } from './telemetry.ts';
import type { SnapshotTool } from './types.ts';

// What a failed tool call can say about its effect on the upstream API
// (issue #25), from the evidence this server has. It states evidence, never
// a transactional guarantee:
// - not_sent: no request of this call reached the API (a local refusal);
// - upstream_rejected: the one request sent was answered with a 4xx;
// - upstream_reported_success: a 2xx was received, but the result could not
//   be returned (it did not match the declared schema, or held a secret);
// - outcome_unknown: anything else, including every call that sent more
//   than one attempt. When in doubt, this one.
export type CallEffect =
  | 'not_sent'
  | 'upstream_rejected'
  | 'upstream_reported_success'
  | 'outcome_unknown';

// Under this server's own `_meta` prefix, next to the retry hints
export const EFFECT_META_KEY = 'openapi-mcp/effect';

export const effectOf = (outcome: ToolCallOutcome): CallEffect | undefined => {
  const effect = outcome.meta?.[EFFECT_META_KEY];
  return typeof effect === 'string' ? (effect as CallEffect) : undefined;
};

// The rebuilt outcome keeps the original's call-log tag, and the mark that
// its text already carries the warning
export const withEffect = (outcome: ToolCallOutcome, effect: CallEffect): ToolCallOutcome =>
  withMetaEntry(outcome, EFFECT_META_KEY, effect);

// Outcomes whose text this server already wrote with the "do not retry"
// warning (a refused redirect, a withheld success). Recorded as data on the
// outcome, never found by searching the text: an upstream excerpt could
// contain the words.
const noted = (outcome: ToolCallOutcome, note: EffectNote): ToolCallOutcome => ({
  ...outcome,
  effectNote: { ...outcome.effectNote, ...note },
});
const isWarned = (outcome: ToolCallOutcome): boolean => outcome.effectNote?.warned === true;

export const markRetryWarned = (outcome: ToolCallOutcome): ToolCallOutcome =>
  carryOutcomeTag(outcome, noted(outcome, { warned: true }));

// A text that states the upstream reported success, with the text to use
// instead when the final effect is unknown (a 2xx after a redirect or a
// retry proves nothing about the write itself)
export const markSuccessClaim = (outcome: ToolCallOutcome, uncertain: string): ToolCallOutcome =>
  carryOutcomeTag(outcome, noted(outcome, { warned: true, uncertainText: uncertain }));

// The effect of a successful result, kept out of its `_meta` (a success
// carries no effect field): if the boundary withholds it, the withheld error
// states this effect instead of assuming a reported success
export const rememberEffect = (outcome: ToolCallOutcome, effect: CallEffect): ToolCallOutcome =>
  carryOutcomeTag(outcome, noted(outcome, { successEffect: effect }));

export const rememberedEffect = (outcome: ToolCallOutcome): CallEffect | undefined =>
  outcome.effectNote?.successEffect;

// A copy with one more `_meta` entry; the call-log tag and the effect note
// come along
export const withMetaEntry = (
  outcome: ToolCallOutcome,
  key: string,
  value: unknown,
): ToolCallOutcome =>
  carryOutcomeTag(outcome, { ...outcome, meta: { ...outcome.meta, [key]: value } });

// The methods whose request can change state. GET, HEAD and QUERY are safe
// (RFC 9110 §9.2.1, RFC 10008): their messages stay as they are.
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'QUERY']);

const WARNING: Readonly<Partial<Record<CallEffect, string>>> = {
  outcome_unknown: 'the request may have reached the upstream and been applied',
  upstream_reported_success: 'the upstream reported success, so the write was likely applied',
};

// Records the effect and, for a write that may have been applied, appends a
// fixed warning to the first text block. Fixed text only: nothing here is
// derived from the upstream.
export const withEffectWarning = (
  outcome: ToolCallOutcome,
  effect: CallEffect,
  method: string,
): ToolCallOutcome => {
  const recorded = withEffect(outcome, effect);
  const uncertain = effect === 'outcome_unknown' ? outcome.effectNote?.uncertainText : undefined;
  if (uncertain !== undefined) {
    const [, ...rest] = recorded.content;
    return carryOutcomeTag(outcome, {
      ...recorded,
      content: [{ type: 'text', text: uncertain }, ...rest],
    });
  }
  const warning = WARNING[effect];
  if (
    warning === undefined ||
    !outcome.isError ||
    SAFE_METHODS.has(method.toUpperCase()) ||
    isWarned(outcome)
  ) {
    return recorded;
  }
  return appendWarning(recorded, warning);
};

const appendWarning = (outcome: ToolCallOutcome, warning: string): ToolCallOutcome => {
  const [first, ...rest] = outcome.content;
  return markRetryWarned(
    carryOutcomeTag(outcome, {
      ...outcome,
      content: [
        { type: 'text', text: `${first?.text ?? ''}; ${warning}, so do not retry it blindly` },
        ...rest,
      ],
    }),
  );
};

// For a step that replaces an outcome's text (secret withholding at the
// boundary): the effect, and a warning the original carried, stay
export const carryEffect = (from: ToolCallOutcome, to: ToolCallOutcome): ToolCallOutcome => {
  const effect = effectOf(from);
  if (effect === undefined) {
    return to;
  }
  const recorded = withEffect(to, effect);
  const warning = WARNING[effect];
  return isWarned(from) && warning !== undefined && !isWarned(to)
    ? appendWarning(recorded, warning)
    : recorded;
};

// Runs an upstream tool call. An error the executor did not classify, and a
// throw, may have come after sending: both are an unknown outcome, with the
// warning for a write. An operation without a known method counts as one.
export const executeWithEffect = async (
  tool: SnapshotTool,
  run: () => Promise<ToolCallOutcome>,
): Promise<ToolCallOutcome> => {
  const method = tool.generated?.operation.method ?? 'POST';
  let outcome: ToolCallOutcome;
  try {
    outcome = await run();
  } catch {
    outcome = textOutcome('tool execution failed unexpectedly', true);
  }
  return outcome.isError && effectOf(outcome) === undefined
    ? withEffectWarning(outcome, 'outcome_unknown', method)
    : outcome;
};
