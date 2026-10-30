import {
  carryEffect,
  markRetryWarned,
  markSuccessClaim,
  rememberedEffect,
  withEffect,
} from './effect.ts';
import { textOutcome } from './result.ts';
import type { ToolCallOutcome } from './result.ts';
import { tagOutcome } from './telemetry.ts';

// A result whose image carries a secret is withheld as a whole (#14)
export { imageHasSecret } from '../images/scan.ts';
export { someDecodedForm } from './execute/response-media.ts';

// A fixed message — never the withheld content itself — for the case a
// registered secret is found anywhere in a result. It tells the caller what
// happened and what it may conclude: when the executor reported success,
// the upstream call DID succeed (a write has likely taken effect), so a
// blind retry could repeat it.
export const BOUNDARY_WITHHELD_SUCCESS_TEXT =
  'the upstream call succeeded, but its result was withheld because it contained a registered secret; the action has likely taken effect, so do not retry it blindly';
// A result after a redirect or a retry proves nothing about the write
// itself (issue #25), so it is withheld without claiming success
export const BOUNDARY_WITHHELD_UNCERTAIN_TEXT =
  'the tool call returned a result, but it was withheld because it contained a registered secret; the request may have reached the upstream and been applied, so do not retry it blindly';
// An execute_code program calls read-only operations only, so nothing it did
// changed data
export const BOUNDARY_WITHHELD_READ_TEXT =
  'the program ran, but its result was withheld because it contained a registered secret; it only read data, so it changed nothing';
export const BOUNDARY_WITHHELD_ERROR_TEXT =
  'the tool call failed, and its error details were withheld because they contained a registered secret';

// The effect survives the withholding (issue #25): a withheld success is a
// reported success, a withheld error keeps what the executor recorded
export const withheld = (outcome: ToolCallOutcome, readOnly = false): ToolCallOutcome => {
  if (!outcome.isError && readOnly) {
    return tagOutcome(textOutcome(BOUNDARY_WITHHELD_READ_TEXT, true), 'secret_withheld');
  }
  if (!outcome.isError) {
    // A 2xx after a redirect or a retry is no proof the write succeeded
    if (rememberedEffect(outcome) === 'outcome_unknown') {
      const uncertain = textOutcome(BOUNDARY_WITHHELD_UNCERTAIN_TEXT, true);
      return markRetryWarned(
        withEffect(tagOutcome(uncertain, 'secret_withheld'), 'outcome_unknown'),
      );
    }
    return withheldSuccess();
  }
  return carryEffect(
    outcome,
    tagOutcome(textOutcome(BOUNDARY_WITHHELD_ERROR_TEXT, true), 'secret_withheld'),
  );
};

// For a 2xx body the executor itself refuses to return (execute/response.ts):
// every such path is a success, so the same success wording applies. Tagged
// so the call log reports `secret_withheld`, not `response_error`.
export const withheldSuccess = (): ToolCallOutcome => {
  const outcome = tagOutcome(textOutcome(BOUNDARY_WITHHELD_SUCCESS_TEXT, true), 'secret_withheld');
  return markSuccessClaim(
    withEffect(outcome, 'upstream_reported_success'),
    BOUNDARY_WITHHELD_UNCERTAIN_TEXT,
  );
};

// The response mapper marks the texts it already writes with this warning
export { markRetryWarned, markSuccessClaim } from './effect.ts';
