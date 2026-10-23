import { z } from 'zod';
import { usageError } from '../errors.ts';

const DURATION_RE = /^(?<count>[1-9]\d*)(?<unit>[smhd])$/u;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// Node's setTimeout maximum (~24.8 days); larger delays are clamped to 1 ms.
// Raising this requires a chunked long-delay scheduler first. It bounds
// durations that ARE timers (--timeout); see MAX_AGE_DURATION_MS for ages.
export const MAX_DURATION_MS = 2_147_483_647;

// A cache TTL is never handed to a timer: it is only compared with the age of
// an entry (cache/ttl.ts, `ageMs < ttlMs`), so the timer limit does not apply
// to it (kaisers-io/openapi-mcp-archive#88). One year still bounds it: pinning
// a slowly changing spec for months is reasonable, a TTL beyond a year is
// almost certainly a typo. Any future feature that schedules a timer from the
// TTL must clamp or chunk it to MAX_DURATION_MS at that point.
export const MAX_AGE_DURATION_MS = 365 * 86_400_000;

const GRAMMAR_HINT =
  'expected <int><s|m|h|d> up to the Node timer limit (~24.8d), e.g. "30m", "1h", "5d"';
const AGE_GRAMMAR_HINT = 'expected <int><s|m|h|d> up to 365d, e.g. "30m", "1h", "90d"';

const durationSchema = (maxMs: number, tooLong: string) =>
  z
    .string()
    .regex(DURATION_RE, GRAMMAR_HINT)
    .transform((raw, ctx) => {
      // The regex above guarantees a match with both named groups here
      const groups = DURATION_RE.exec(raw)?.groups as {
        count: string;
        unit: keyof typeof UNIT_MS;
      };
      const ms = Number(groups.count) * UNIT_MS[groups.unit];
      if (!Number.isSafeInteger(ms) || ms > maxMs) {
        ctx.addIssue({ code: 'custom', message: tooLong });
        return z.NEVER;
      }
      return ms;
    });

// A real timer (--timeout)
export const zDuration = durationSchema(
  MAX_DURATION_MS,
  'duration exceeds the Node timer limit (~24.8d)',
);

// An age compared against a timestamp (--ttl)
export const zAgeDuration = durationSchema(MAX_AGE_DURATION_MS, 'duration exceeds 365d');

// `flag` names the option in the message: --timeout and --ttl now have
// different limits, and a message that only says "duration" would leave the
// operator guessing which one was meant
const invalidDuration = (raw: string, flag: string | undefined, hint: string): Error =>
  usageError(`invalid ${flag === undefined ? '' : `${flag} `}duration "${raw}" — ${hint}`);

export const parseDuration = (raw: string, flag?: string): number => {
  const result = zDuration.safeParse(raw);
  if (!result.success) {
    throw invalidDuration(raw, flag, GRAMMAR_HINT);
  }
  return result.data;
};

export const parseAgeDuration = (raw: string, flag?: string): number => {
  const result = zAgeDuration.safeParse(raw);
  if (!result.success) {
    throw invalidDuration(raw, flag, AGE_GRAMMAR_HINT);
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
