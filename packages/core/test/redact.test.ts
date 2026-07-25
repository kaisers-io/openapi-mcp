import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/index.ts';

describe('createRedactor', () => {
  it('redacts a raw exact secret value found in a string', () => {
    const redactor = createRedactor(['topsecretvalue']);
    expect(redactor.redactString('token=topsecretvalue;done')).toBe('token=[redacted];done');
  });

  it('computes bounded encoding variants only for secrets >= 8 chars', () => {
    const longSecret = 'longsecretvalue1';
    const shortSecret = 'shortpw';
    const redactor = createRedactor([longSecret, shortSecret]);

    const longStd = Buffer.from(longSecret, 'utf8').toString('base64');
    const longUrl = longStd.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const longPct = encodeURIComponent(longSecret);
    const shortStd = Buffer.from(shortSecret, 'utf8').toString('base64');

    expect(redactor.redactString(`std:${longStd}`)).toBe('std:[redacted]');
    expect(redactor.redactString(`url:${longUrl}`)).toBe('url:[redacted]');
    expect(redactor.redactString(`pct:${longPct}`)).toBe('pct:[redacted]');
    // A 7-char secret's base64 form must survive: variants are only computed at >= 8 chars.
    expect(redactor.redactString(`b64:${shortStd}`)).toBe(`b64:${shortStd}`);
    // Its raw form is still redacted.
    expect(redactor.redactString(`raw:${shortSecret}`)).toBe('raw:[redacted]');
  });

  it('redacts string values and object keys recursively through arrays and nested objects', () => {
    const redactor = createRedactor(['sekrit']);
    const input = {
      sekrit: 'the value is sekrit',
      nested: { list: ['sekrit-embedded', 42, null, true] },
    };
    expect(redactor.redactJson(input)).toEqual({
      '[redacted]': 'the value is [redacted]',
      nested: { list: ['[redacted]-embedded', 42, null, true] },
    });
  });

  it('scanForSecret finds a secret nested in an array, an object value, or an object key', () => {
    const redactor = createRedactor(['findme']);
    expect(redactor.scanForSecret(['a', 'findme'])).toBe(true);
    expect(redactor.scanForSecret({ nested: { deep: 'findme' } })).toBe(true);
    expect(redactor.scanForSecret({ findme: 'value' })).toBe(true);
    expect(redactor.scanForSecret({ nested: ['no', 'match', 'here'] })).toBe(false);
    expect(redactor.scanForSecret(42)).toBe(false);
  });

  it('redacts the longest matching needle first, whole, when it contains a shorter secret as a substring', () => {
    const longSecret = 'anotherlongsecretvalue';
    const std = Buffer.from(longSecret, 'utf8').toString('base64');
    const shortSecret = std.slice(2, 10);
    expect(shortSecret.length).toBeGreaterThan(0);
    expect(std).toContain(shortSecret);

    // Registered short-before-long so that, absent the longest-first sort,
    // insertion order alone would process the short needle first.
    const redactor = createRedactor([shortSecret, longSecret]);
    const text = `prefix ${std} suffix`;
    expect(redactor.redactString(text)).toBe('prefix [redacted] suffix');
  });

  it('is a no-op when constructed with no secrets', () => {
    const redactor = createRedactor([]);
    expect(redactor.redactString('nothing to see here')).toBe('nothing to see here');
    expect(redactor.redactJson({ a: 'b' })).toEqual({ a: 'b' });
    expect(redactor.scanForSecret({ a: 'b' })).toBe(false);
  });

  it('throws on an empty secret', () => {
    expect(() => createRedactor([''])).toThrow(/empty secret/u);
  });

  it('throws on a secret over the length budget', () => {
    const tooLong = 'x'.repeat(8193);
    expect(() => createRedactor([tooLong])).toThrow(/length budget/u);
  });

  it('throws when the secret count exceeds the budget', () => {
    const many = Array.from({ length: 65 }, (_value, index) => `secret-${index}`);
    expect(() => createRedactor(many)).toThrow(/too many secrets/u);
  });

  it('throws at construction when a secret is a substring of the redaction marker itself', () => {
    // '[redacted]' contains 'red' and 'redacted' — either as a registered
    // secret would be reintroduced into the output by the very replacement
    // meant to remove it, so construction must fail closed.
    expect(() => createRedactor(['red'])).toThrow(/substring of the redaction marker/u);
    expect(() => createRedactor(['redacted'])).toThrow(/substring of the redaction marker/u);
  });

  it('does not throw at construction for a normal, non-trivial secret', () => {
    expect(() => createRedactor(['a-normal-looking-secret-value'])).not.toThrow();
  });

  it('redacts a secret and does not pollute the prototype when the input carries an own enumerable __proto__ key', () => {
    const redactor = createRedactor(['SECRET']);
    // Built via JSON.parse (not an object literal) so '__proto__' lands as an
    // own enumerable property of the parsed object, exactly as a hostile
    // wire payload would produce it — an object literal would instead set
    // the prototype at author time and never exercise the guard.
    const input: unknown = JSON.parse('{"__proto__":{"x":1},"a":"SECRET"}');
    const result = redactor.redactJson(input) as Record<string, unknown>;

    // A null-prototype output means bracket assignment could not have
    // invoked the inherited __proto__ setter to reparent `result`.
    expect(Object.getPrototypeOf(result)).toBeNull();
    // The hostile key survived as an ordinary own data property instead of
    // being consumed as a magic prototype slot.
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result['a']).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
