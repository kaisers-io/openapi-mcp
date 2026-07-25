import { describe, expect, it } from 'vitest';
import {
  MAX_DURATION_MS,
  OpenapiMcpError,
  parseByteSize,
  parseDuration,
  zByteSize,
  zDuration,
} from '../src/index.ts';

describe('zDuration', () => {
  it.each([
    ['30s', 30_000],
    ['30m', 1_800_000],
    ['1h', 3_600_000],
    ['5d', 432_000_000],
  ])('parses %s to %d ms', (raw, ms) => {
    expect(zDuration.parse(raw)).toBe(ms);
  });

  it.each(['', '5', 'h1', '1.5h', '1 h', '5w', '-1h', '0s'])('rejects %j', (raw) => {
    expect(zDuration.safeParse(raw).success).toBe(false);
  });

  it('accepts values up to the Node timer maximum (24d)', () => {
    expect(zDuration.parse('24d')).toBe(2_073_600_000);
  });

  it('accepts the exact maximum in seconds granularity', () => {
    // 2147483s * 1000 = 2_147_483_000 <= MAX_DURATION_MS
    expect(zDuration.parse('2147483s')).toBe(2_147_483_000);
  });

  it('rejects values above the Node timer maximum', () => {
    // 25d = 2_160_000_000 > 2_147_483_647
    expect(zDuration.safeParse('25d').success).toBe(false);
    expect(zDuration.safeParse('2147484s').success).toBe(false);
  });

  it('exposes the Node timer limit as the maximum', () => {
    expect(MAX_DURATION_MS).toBe(2_147_483_647);
  });

  it('rejects overflow instead of returning Infinity', () => {
    const huge = `${'9'.repeat(400)}d`;
    const result = zDuration.safeParse(huge);
    expect(result.success).toBe(false);
  });

  it('rejects unsafe-integer magnitudes', () => {
    // 104249991375d is roughly 9.0072e15 ms, above Number.MAX_SAFE_INTEGER
    const result = zDuration.safeParse('104249991375d');
    expect(result.success).toBe(false);
  });
});

describe('parseDuration', () => {
  it('returns milliseconds for valid input', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('throws a usage error naming the invalid input', () => {
    expect(() => parseDuration('5w')).toThrowError(OpenapiMcpError);
    try {
      parseDuration('5w');
    } catch (err) {
      expect((err as OpenapiMcpError).code).toBe('usage');
      expect((err as OpenapiMcpError).message).toContain('5w');
    }
  });

  it('throws a usage error on overflow', () => {
    expect(() => parseDuration('9999999d')).toThrowError(OpenapiMcpError);
  });
});

describe('zByteSize', () => {
  it.each([
    ['1', 1],
    ['1024', 1024],
    ['10B', 10],
    ['5KB', 5 * 1024],
    ['10MB', 10 * 1024 * 1024],
  ])('parses %s to %d bytes', (raw, bytes) => {
    expect(zByteSize.parse(raw)).toBe(bytes);
  });

  it.each(['', '0', '-5', '1.5MB', '10 MB', '10GB', 'MB', '10mb'])('rejects %j', (raw) => {
    expect(zByteSize.safeParse(raw).success).toBe(false);
  });

  it('rejects a magnitude too large to represent safely', () => {
    const huge = `${'9'.repeat(300)}MB`;
    expect(zByteSize.safeParse(huge).success).toBe(false);
  });
});

describe('parseByteSize', () => {
  it('returns bytes for valid input', () => {
    expect(parseByteSize('10MB')).toBe(10 * 1024 * 1024);
  });

  it('throws a usage error naming the invalid input', () => {
    expect(() => parseByteSize('10GB')).toThrowError(OpenapiMcpError);
    try {
      parseByteSize('10GB');
    } catch (err) {
      expect((err as OpenapiMcpError).code).toBe('usage');
      expect((err as OpenapiMcpError).message).toContain('10GB');
    }
  });

  it('throws a usage error on overflow', () => {
    const huge = `${'9'.repeat(300)}MB`;
    expect(() => parseByteSize(huge)).toThrowError(OpenapiMcpError);
  });
});
