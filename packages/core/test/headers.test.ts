import { describe, expect, it } from 'vitest';
import {
  OpenapiMcpError,
  parseHeaderEnvMapping,
  resolveHeaderEnvMappings,
  trimSpaces,
} from '../src/index.ts';

const expectUsageError = (fn: () => unknown, messagePart: string): void => {
  try {
    fn();
    expect.unreachable('expected a usage error');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenapiMcpError);
    expect((error as OpenapiMcpError).code).toBe('usage');
    expect((error as OpenapiMcpError).message).toContain(messagePart);
  }
};

describe('parseHeaderEnvMapping', () => {
  it('parses Header=ENV', () => {
    expect(parseHeaderEnvMapping('Authorization=SPEC_TOKEN')).toEqual({
      headerName: 'Authorization',
      envVar: 'SPEC_TOKEN',
    });
  });

  it('splits on the first equals sign only', () => {
    // The env var name grammar then rejects the remainder
    expectUsageError(() => parseHeaderEnvMapping('X-Key=ENV=EXTRA'), 'ENV=EXTRA');
  });

  it('accepts token characters in header names', () => {
    expect(parseHeaderEnvMapping('X-Api-Key=MY_KEY').headerName).toBe('X-Api-Key');
  });

  it.each(['NoSeparator', '=ENV', 'Bad Header=ENV', 'Bad:Name=ENV', 'Bad\u0000=ENV'])(
    'rejects %j',
    (raw) => {
      expectUsageError(() => parseHeaderEnvMapping(raw), '');
    },
  );

  it.each(['H=', 'H=1BAD', 'H=BAD-NAME', 'H=bad name'])('rejects invalid env var in %j', (raw) => {
    expectUsageError(() => parseHeaderEnvMapping(raw), '');
  });
});

describe('resolveHeaderEnvMappings', () => {
  const mapping = { headerName: 'Authorization', envVar: 'SPEC_TOKEN' };

  it('resolves values from the environment', () => {
    const resolved = resolveHeaderEnvMappings([mapping], { SPEC_TOKEN: 'Bearer abc' });
    expect(resolved).toEqual([{ name: 'Authorization', value: 'Bearer abc' }]);
  });

  it('fails hard on a missing env var, naming it', () => {
    expectUsageError(() => resolveHeaderEnvMappings([mapping], {}), 'SPEC_TOKEN');
  });

  it('fails hard on an empty env var, naming it', () => {
    expectUsageError(() => resolveHeaderEnvMappings([mapping], { SPEC_TOKEN: '' }), 'SPEC_TOKEN');
  });

  it('rejects duplicate header names case-insensitively', () => {
    expectUsageError(
      () =>
        resolveHeaderEnvMappings([mapping, { headerName: 'AUTHORIZATION', envVar: 'OTHER' }], {
          SPEC_TOKEN: 'x',
          OTHER: 'y',
        }),
      'duplicate',
    );
  });

  it('rejects control characters in values without echoing the value', () => {
    try {
      resolveHeaderEnvMappings([mapping], { SPEC_TOKEN: 'evil\r\ninjected' });
      expect.unreachable('expected a usage error');
    } catch (error) {
      expect((error as OpenapiMcpError).code).toBe('usage');
      expect((error as OpenapiMcpError).message).not.toContain('evil');
      expect((error as OpenapiMcpError).message).toContain('SPEC_TOKEN');
    }
  });

  it('rejects a character above U+00FF in a value without echoing the value', () => {
    try {
      resolveHeaderEnvMappings([mapping], { SPEC_TOKEN: 'secret-日本-token' });
      expect.unreachable('expected a usage error');
    } catch (error) {
      expect((error as OpenapiMcpError).code).toBe('usage');
      expect((error as OpenapiMcpError).message).not.toContain('secret');
      expect((error as OpenapiMcpError).message).toContain('SPEC_TOKEN');
      expect((error as OpenapiMcpError).message).toContain('above U+00FF');
    }
  });

  it('accepts a Latin-1 value (U+0080..U+00FF are valid header bytes)', () => {
    const resolved = resolveHeaderEnvMappings([mapping], { SPEC_TOKEN: 'café' });
    expect(resolved).toEqual([{ name: mapping.headerName, value: 'café' }]);
  });

  it('resolves multiple distinct headers in order', () => {
    const resolved = resolveHeaderEnvMappings(
      [
        { headerName: 'Authorization', envVar: 'TOK_A' },
        { headerName: 'X-Tenant', envVar: 'TOK_B' },
      ],
      { TOK_A: 'a', TOK_B: 'b' },
    );
    expect(resolved.map((header) => header.name)).toEqual(['Authorization', 'X-Tenant']);
  });
});

// The HTTP client drops spaces around a header value, so the value kept (and
// registered for redaction) is the one it sends
describe('resolveHeaderEnvMappings — spaces around the value', () => {
  it('drops them, and refuses a value of only spaces', () => {
    const mapping = [{ headerName: 'Authorization', envVar: 'T' }];
    expect(
      resolveHeaderEnvMappings(mapping, { T: '  Bearer example-not-a-real-secret ' }),
    ).toStrictEqual([{ name: 'Authorization', value: 'Bearer example-not-a-real-secret' }]);
    expect(() => resolveHeaderEnvMappings(mapping, { T: '   ' })).toThrow('is not set or empty');
  });
});

describe('trimSpaces', () => {
  it('drops only the spaces around a value, in linear time', () => {
    expect(trimSpaces('  a b  ')).toBe('a b');
    expect(trimSpaces('\ta\t')).toBe('\ta\t');
    expect(trimSpaces('   ')).toBe('');
    // A long run of spaces before a last character: quadratic for `/ +$/`
    const hostile = `${' '.repeat(200_000)}x`;
    const started = performance.now();
    expect(trimSpaces(hostile)).toBe('x');
    expect(trimSpaces(`x${' '.repeat(200_000)}x`)).toBe(`x${' '.repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
