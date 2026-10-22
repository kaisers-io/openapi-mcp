import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/index.ts';

// Runtime (post-startup) secret registration: an OAuth2 access token is
// obtained long after the redactor is built and must be redacted from then
// on, exactly like a startup secret.

describe('createRedactor — registerRuntimeSecret', () => {
  it('redacts a runtime secret (and its encodings) after registration, never before', () => {
    const redactor = createRedactor(['startup-secret-value']);
    const token = 'runtime-access-token-123';
    expect(redactor.redactString(`a ${token} b`)).toBe(`a ${token} b`);
    redactor.registerRuntimeSecret(token, 10_000, 0);
    expect(redactor.redactString(`a ${token} b`)).toBe('a [redacted] b');
    expect(redactor.redactString(Buffer.from(token).toString('base64'))).toBe('[redacted]');
    expect(redactor.scanForSecret({ key: [token] })).toBe(true);
    expect(redactor.redactJson({ [token]: token })).toEqual({ '[redacted]': '[redacted]' });
    // Startup secrets are unaffected.
    expect(redactor.redactString('startup-secret-value')).toBe('[redacted]');
  });

  it('rejects what a startup secret would be rejected for, registering nothing', () => {
    const redactor = createRedactor([]);
    expect(() => redactor.registerRuntimeSecret('', 1, 0)).toThrow(/empty secret/u);
    expect(() => redactor.registerRuntimeSecret('x'.repeat(8193), 1, 0)).toThrow(/length budget/u);
    expect(() => redactor.registerRuntimeSecret('da', 1, 0)).toThrow(/redaction marker/u);
    expect(redactor.redactString('da')).toBe('da');
  });

  it('keeps a secret until its retention time, then lets it go on a later registration', () => {
    const redactor = createRedactor([]);
    redactor.registerRuntimeSecret('first-runtime-token', 100, 0);
    redactor.registerRuntimeSecret('second-runtime-token', 500, 50);
    // Not yet past retention: both still redacted.
    expect(redactor.redactString('first-runtime-token second-runtime-token')).toBe(
      '[redacted] [redacted]',
    );
    redactor.registerRuntimeSecret('third-runtime-token', 900, 100);
    expect(redactor.redactString('first-runtime-token')).toBe('first-runtime-token');
    expect(redactor.redactString('second-runtime-token')).toBe('[redacted]');
  });

  it('never evicts an unexpired secret: registration fails once the budget is full', () => {
    const redactor = createRedactor([]);
    for (let index = 0; index < 256; index += 1) {
      redactor.registerRuntimeSecret(`live-runtime-token-${String(index)}`, 1000, 0);
    }
    expect(() => redactor.registerRuntimeSecret('one-too-many-token', 1000, 0)).toThrow(
      /too many unexpired runtime secrets/u,
    );
    expect(redactor.redactString('live-runtime-token-0')).toBe('[redacted]');
    expect(redactor.redactString('one-too-many-token')).toBe('one-too-many-token');
    // Re-registering a known secret is not a new entry; once they expire,
    // room is made again.
    expect(() => redactor.registerRuntimeSecret('live-runtime-token-0', 2000, 0)).not.toThrow();
    expect(() => redactor.registerRuntimeSecret('after-expiry-token', 3000, 1000)).not.toThrow();
    expect(redactor.redactString('live-runtime-token-0 live-runtime-token-1')).toBe(
      '[redacted] live-runtime-token-1',
    );
  });
});
