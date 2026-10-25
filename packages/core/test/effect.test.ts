import { describe, expect, it } from 'vitest';
import { decorateTextOutcome } from '../src/server/execute/forwarded-headers.ts';
import { textOutcome } from '../src/server/result.ts';
import {
  effectOf,
  markRetryWarned,
  rememberEffect,
  withEffectWarning,
  withMetaEntry,
} from '../src/server/effect.ts';
import { BOUNDARY_WITHHELD_UNCERTAIN_TEXT, withheld } from '../src/server/withheld.ts';

// Issue #25: the effect of a failed call, and the warning for a write that
// may have been applied, survive every later step that copies or replaces
// the outcome.

const WARNING = 'may have reached the upstream and been applied, so do not retry it blindly';

describe('call effect', () => {
  it('warns once for a write, never for a read or a success', () => {
    const write = withEffectWarning(textOutcome('timed out', true), 'outcome_unknown', 'post');
    expect(write.content[0]?.text).toBe(`timed out; the request ${WARNING}`);
    expect(effectOf(write)).toBe('outcome_unknown');
    const read = withEffectWarning(textOutcome('timed out', true), 'outcome_unknown', 'GET');
    expect(read.content[0]?.text).toBe('timed out');
    const success = withEffectWarning(textOutcome('ok'), 'outcome_unknown', 'POST');
    expect(success.content[0]?.text).toBe('ok');
    // A text the server already wrote with the warning gets no second one
    const already = markRetryWarned(textOutcome('redirect refused; do not retry it blindly', true));
    expect(withEffectWarning(already, 'outcome_unknown', 'POST').content[0]?.text).toBe(
      'redirect refused; do not retry it blindly',
    );
  });

  it('is not suppressed by upstream text that says "do not retry"', () => {
    const upstream = textOutcome('upstream says: do not retry', true);
    expect(withEffectWarning(upstream, 'outcome_unknown', 'POST').content[0]?.text).toContain(
      WARNING,
    );
  });

  // Review of #25: the recovery key is added to a copy; withholding that copy
  // at the boundary must keep the warning
  it('keeps the warning through a meta copy and boundary withholding', () => {
    const warned = withEffectWarning(textOutcome('timed out', true), 'outcome_unknown', 'POST');
    const keyed = withMetaEntry(warned, 'openapi-mcp/idempotencyKey', 'key');
    const replaced = withheld(keyed);
    expect(effectOf(replaced)).toBe('outcome_unknown');
    expect(replaced.content[0]?.text).toContain(WARNING);
    // An unwarned read keeps its effect but gets no warning
    const read = withEffectWarning(textOutcome('timed out', true), 'outcome_unknown', 'GET');
    expect(withheld(read).content[0]?.text).not.toContain(WARNING);
    // A withheld success is a reported success
    const withheldSuccess = withheld(textOutcome('ok'));
    expect(effectOf(withheldSuccess)).toBe('upstream_reported_success');
    // Review of #25: an outcome already carrying the warning keeps the mark
    // through every copy, so withholding it again keeps the warning
    // Review of #25: a success after a redirect or a retry that is withheld
    // stays unknown, not a reported success
    const redirected = rememberEffect(textOutcome('ok'), 'outcome_unknown');
    const uncertain = withheld(redirected);
    expect(effectOf(uncertain)).toBe('outcome_unknown');
    expect(uncertain.content[0]?.text).toBe(BOUNDARY_WITHHELD_UNCERTAIN_TEXT);
    expect(uncertain.content[0]?.text).not.toContain('succeeded');
    // Review of #25: a text claiming success follows the final effect, also
    // through a meta copy
    const claimed = withMetaEntry(withheldSuccess, 'openapi-mcp/idempotencyKey', 'key');
    const unknownClaim = withEffectWarning(claimed, 'outcome_unknown', 'POST');
    expect(unknownClaim.content[0]?.text).toBe(BOUNDARY_WITHHELD_UNCERTAIN_TEXT);
    expect(effectOf(unknownClaim)).toBe('outcome_unknown');
    const copied = withEffectWarning(withheldSuccess, 'upstream_reported_success', 'POST');
    expect(withheld(copied).content[0]?.text).toContain('so do not retry it blindly');
  });

  // Review of #25: forwarded headers copy the outcome before the effect is
  // classified; the success claim must survive that copy
  it('keeps a success claim through forwarded-header decoration', () => {
    const decorated = decorateTextOutcome(
      withheld(textOutcome('ok')),
      { location: '/orders/1' },
      1000,
    );
    expect(decorated.content.at(-1)?.text).toContain('location');
    const final = withEffectWarning(decorated, 'outcome_unknown', 'POST');
    expect(final.content[0]?.text).toBe(BOUNDARY_WITHHELD_UNCERTAIN_TEXT);
    expect(JSON.stringify(final.content)).not.toContain('succeeded');
  });
});
