import { z } from 'zod';
import { usageError } from '../errors.ts';

const DURATION_RE = /^(?<count>[1-9]\d*)(?<unit>[smhd])$/u;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// Node's setTimeout maximum (~24.8 days); larger delays are clamped to 1 ms.
// Raising this requires a chunked long-delay scheduler first.
export const MAX_DURATION_MS = 2_147_483_647;

const GRAMMAR_HINT =
  'expected <int><s|m|h|d> up to the Node timer limit (~24.8d), e.g. "30m", "1h", "5d"';

export const zDuration = z
  .string()
  .regex(DURATION_RE, GRAMMAR_HINT)
  .transform((raw, ctx) => {
    // The regex above guarantees a match with both named groups here
    const groups = DURATION_RE.exec(raw)?.groups as { count: string; unit: keyof typeof UNIT_MS };
    const ms = Number(groups.count) * UNIT_MS[groups.unit];
    if (!Number.isSafeInteger(ms) || ms > MAX_DURATION_MS) {
      ctx.addIssue({ code: 'custom', message: 'duration exceeds the Node timer limit (~24.8d)' });
      return z.NEVER;
    }
    return ms;
  });

export const parseDuration = (raw: string): number => {
  const result = zDuration.safeParse(raw);
  if (!result.success) {
    throw usageError(`invalid duration "${raw}" — ${GRAMMAR_HINT}`);
  }
  return result.data;
};
