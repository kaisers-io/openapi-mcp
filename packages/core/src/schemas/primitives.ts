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

const BYTE_SIZE_RE = /^(?<count>[1-9]\d*)(?<unit>B|KB|MB)?$/u;

// A plain function rather than a `{ B: 1, KB: ..., MB: ... }` lookup object:
// a single-letter property key trips this repo's id-length floor, and a
// switch's case labels are string literals, not identifiers, so they are
// exempt.
const byteUnitMultiplier = (unit: string): number => {
  switch (unit) {
    case 'KB': {
      return 1024;
    }
    case 'MB': {
      return 1_048_576;
    }
    default: {
      return 1;
    }
  }
};

const BYTE_SIZE_GRAMMAR_HINT =
  'expected <int><B|KB|MB> or a plain positive byte count, e.g. "10MB", "512KB", "1048576"';

// A byte-size grammar for flags like --max-response-bytes. The regex alone
// rejects zero, negative, and non-integer input (the count group requires a
// leading 1-9 digit). Any "sane max" ceiling beyond simple representability
// is a policy decision that belongs to the flag consuming this, not to this
// generic parser.
export const zByteSize = z
  .string()
  .regex(BYTE_SIZE_RE, BYTE_SIZE_GRAMMAR_HINT)
  .transform((raw, ctx) => {
    // The regex above guarantees a match with a count group here
    const groups = BYTE_SIZE_RE.exec(raw)?.groups as { count: string; unit?: string };
    const bytes = Number(groups.count) * byteUnitMultiplier(groups.unit ?? 'B');
    if (!Number.isSafeInteger(bytes)) {
      ctx.addIssue({ code: 'custom', message: 'byte size is too large to represent' });
      return z.NEVER;
    }
    return bytes;
  });

export const parseByteSize = (raw: string): number => {
  const result = zByteSize.safeParse(raw);
  if (!result.success) {
    throw usageError(`invalid byte size "${raw}" — ${BYTE_SIZE_GRAMMAR_HINT}`);
  }
  return result.data;
};
