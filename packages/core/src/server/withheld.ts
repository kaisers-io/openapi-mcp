import { textOutcome } from './result.ts';
import type { ToolCallOutcome } from './result.ts';
import { tagOutcome } from './telemetry.ts';

// A fixed message — never the withheld content itself — for the case a
// registered secret is found anywhere in a result. It tells the caller what
// happened and what it may conclude: when the executor reported success,
// the upstream call DID succeed (a write has likely taken effect), so a
// blind retry could repeat it.
export const BOUNDARY_WITHHELD_SUCCESS_TEXT =
  'the upstream call succeeded, but its result was withheld because it contained a registered secret; the action has likely taken effect, so do not retry it blindly';
export const BOUNDARY_WITHHELD_ERROR_TEXT =
  'the tool call failed, and its error details were withheld because they contained a registered secret';

export const withheld = (outcome: ToolCallOutcome): ToolCallOutcome =>
  tagOutcome(
    textOutcome(
      outcome.isError ? BOUNDARY_WITHHELD_ERROR_TEXT : BOUNDARY_WITHHELD_SUCCESS_TEXT,
      true,
    ),
    'secret_withheld',
  );

// For a 2xx body the executor itself refuses to return (execute/response.ts):
// every such path is a success, so the same success wording applies. Tagged
// so the call log reports `secret_withheld`, not `response_error`.
export const withheldSuccess = (): ToolCallOutcome =>
  tagOutcome(textOutcome(BOUNDARY_WITHHELD_SUCCESS_TEXT, true), 'secret_withheld');
