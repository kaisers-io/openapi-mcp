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

  it('scanForSecret finds a numeric secret in a JSON number, in any spelling', () => {
    const redactor = createRedactor(['987654321']);
    expect(redactor.scanForSecret({ pin: 987_654_321 })).toBe(true);
    expect(redactor.scanForSecret([JSON.parse('9.87654321e8')])).toBe(true);
    expect(redactor.scanForSecret({ pin: 123_456_789 })).toBe(false);
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

// Issue kaisers-io/openapi-mcp-archive#58: a header secret is registered as its
// WHOLE value (`Bearer <token>`), but an upstream echoing the credential echoes
// only the part after the auth scheme, or a Basic credential's decoded parts.
describe('createRedactor — credentials derived from an auth-scheme value (kaisers-io/openapi-mcp-archive#58)', () => {
  const basic = (scheme: string, userPass: string): string =>
    `${scheme} ${Buffer.from(userPass, 'utf8').toString('base64')}`;

  it('redacts the bare credential of a `Bearer <token>` secret', () => {
    const redactor = createRedactor(['Bearer example-token-not-a-secret']);
    expect(redactor.redactString('invalid api key example-token-not-a-secret')).toBe(
      'invalid api key [redacted]',
    );
    expect(redactor.scanForSecret({ error: 'key example-token-not-a-secret' })).toBe(true);
  });

  it.each(['bearer', 'BEARER', 'Token', 'ApiKey', 'Custom-Scheme'])(
    'splits any RFC 9110 token auth-scheme (%s)',
    (scheme) => {
      const redactor = createRedactor([`${scheme} example-token-not-a-secret`]);
      expect(redactor.redactString('got example-token-not-a-secret')).toBe('got [redacted]');
    },
  );

  it('also redacts the bare credential in its encoded variants', () => {
    const token = 'example/token+not-a-secret';
    const redactor = createRedactor([`Bearer ${token}`]);
    expect(redactor.redactString(encodeURIComponent(token))).toBe('[redacted]');
    expect(redactor.redactString(Buffer.from(token).toString('base64'))).toBe('[redacted]');
  });

  it.each(['Basic', 'basic', 'BASIC'])(
    'redacts the decoded `user:pass` and the password of a `%s` secret, but not the user-id',
    (scheme) => {
      const redactor = createRedactor([basic(scheme, 'alice:example-pass-not-a-secret')]);
      expect(redactor.redactString('login failed for alice:example-pass-not-a-secret')).toBe(
        'login failed for [redacted]',
      );
      expect(redactor.redactString('bad password example-pass-not-a-secret')).toBe(
        'bad password [redacted]',
      );
      expect(redactor.redactString('unknown user alice')).toBe('unknown user alice');
    },
  );

  it('splits a Basic password at the FIRST colon (RFC 7617: the user-id has none)', () => {
    const redactor = createRedactor([basic('Basic', 'bob:pass:with:colons')]);
    expect(redactor.redactString('pw=pass:with:colons')).toBe('pw=[redacted]');
  });

  it('does not derive parts shorter than 8 chars (no false positives, no startup failure)', () => {
    // "red" and "da" are substrings of the "[redacted]" marker: registering
    // them as derived needles would make construction throw for a
    // legitimate (if weak) credential.
    expect(() => createRedactor([basic('Basic', 'u:red')])).not.toThrow();
    expect(() => createRedactor(['Bearer da'])).not.toThrow();
    const redactor = createRedactor([basic('Basic', 'alice:pw12345'), 'Token short12']);
    expect(redactor.redactString('pw12345 short12 alice:pw12345')).toBe(
      'pw12345 short12 [redacted]',
    );
  });

  it('fails closed when a derived needle of 8+ chars is a substring of the marker', () => {
    expect(() => createRedactor(['Bearer redacted'])).toThrow(/substring of the redaction marker/u);
  });

  it.each([
    [
      'a static value whose first word is not a token',
      'client/1.2 extra-info-here',
      'extra-info-here',
    ],
    ['a list value with several spaces', 'text/html, application/json', 'application/json'],
    [
      'an auth-param list',
      'Digest username="someone", realm="example-realm"',
      'realm="example-realm"',
    ],
  ])('does not split %s', (_label, value, fragment) => {
    const redactor = createRedactor([value]);
    expect(redactor.redactString(`see ${fragment}`)).toBe(`see ${fragment}`);
  });

  it('derives only the bare credential when a Basic credential is not UTF-8', () => {
    const notUtf8 = Buffer.from([0x75, 0x3a, 0xff, 0xfe, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67]);
    const credential = notUtf8.toString('base64');
    const redactor = createRedactor([`Basic ${credential}`]);
    expect(redactor.redactString(`k=${credential}`)).toBe('k=[redacted]');
  });

  it('does not decode a non-canonical Basic credential', () => {
    // Buffer.from(…, 'base64') alone would leniently decode this anyway.
    const lenient = `${Buffer.from('alice:example-pass-not-a-secret').toString('base64')}!!`;
    const redactor = createRedactor([`Basic ${lenient}`]);
    expect(redactor.redactString('example-pass-not-a-secret')).toBe('example-pass-not-a-secret');
  });
});

describe('createRedactor — additional encoding variants (kaisers-io/openapi-mcp-archive#58)', () => {
  // The issue's own probe secret: '/', '+', ' ', ':' and '=' all encode.
  const secret = 'ab/cd+ef gh:ij==';
  const redactor = createRedactor([secret]);

  it('redacts uppercase percent-encoding (unchanged behavior)', () => {
    expect(redactor.redactString(`q=${encodeURIComponent(secret)}`)).toBe('q=[redacted]');
  });

  it('redacts lowercase percent-encoding', () => {
    expect(redactor.redactString('q=ab%2fcd%2bef%20gh%3aij%3d%3d')).toBe('q=[redacted]');
  });

  it('redacts application/x-www-form-urlencoded (space as +)', () => {
    const form = new URLSearchParams({ q: secret }).toString();
    expect(form).toBe('q=ab%2Fcd%2Bef+gh%3Aij%3D%3D');
    expect(redactor.redactString(form)).toBe('q=[redacted]');
  });

  it('redacts the JSON `\\/`-escaped form inside non-JSON text', () => {
    expect(redactor.redactString(String.raw`echo: {"k":"ab\/cd+ef gh:ij=="}`)).toBe(
      'echo: {"k":"[redacted]"}',
    );
  });

  it('redacts the JSON.stringify-escaped form of a secret with a quote or backslash', () => {
    const quoted = String.raw`abc"def\ghi-example`;
    const json = JSON.stringify({ k: quoted });
    expect(createRedactor([quoted]).redactString(json)).toBe('{"k":"[redacted]"}');
  });
});

// Above its needle threshold the redactor switches from one indexOf scan
// per needle to a single rolling-hash pass (redact-match.ts). These pin
// that path: every needle occurrence must be gone, and scanForSecret must
// agree with plain `includes`.
describe('createRedactor — many-needle matcher path', () => {
  const bare = (index: number): string => `pass/word ${index}+example`;
  const secrets = Array.from(
    { length: 64 },
    (_value, index) => `Basic ${Buffer.from(`user-${index}:${bare(index)}`).toString('base64')}`,
  );
  const redactor = createRedactor(secrets);

  it('redacts every registered secret and its derived parts, wherever they appear', () => {
    const lines = secrets.map(
      (secret, index) =>
        `a${secret}b ${secret.slice(6)} c${bare(index)}d ${encodeURIComponent(bare(index))}`,
    );
    const out = redactor.redactString(lines.join('\n'));
    expect(out.split('\n')).toEqual(
      lines.map(() => 'a[redacted]b [redacted] c[redacted]d [redacted]'),
    );
  });

  it('scanForSecret agrees with includes on hits, misses, and value boundaries', () => {
    expect(redactor.scanForSecret(bare(63))).toBe(true);
    expect(redactor.scanForSecret(`x${bare(0)}`)).toBe(true);
    expect(redactor.scanForSecret(bare(0).slice(0, -1))).toBe(false);
    expect(redactor.scanForSecret({ list: ['nothing', 'here', 'pass/word'] })).toBe(false);
    expect(redactor.scanForSecret('')).toBe(false);
  });

  it('still redacts a short (< 8 char) raw secret alongside the hashed needles', () => {
    const mixed = createRedactor([...secrets.slice(0, 63), 'shrt']);
    expect(mixed.redactString(`shrt ${bare(1)}`)).toBe('[redacted] [redacted]');
  });

  it('merges overlapping occurrences of two secrets so no fragment survives', () => {
    const overlap = createRedactor([
      ...secrets.slice(0, 62),
      'AAAAexample-overlap',
      'example-overlapZZZZ',
    ]);
    expect(overlap.redactString('<AAAAexample-overlapZZZZ>')).toBe('<[redacted]>');
    // The same on the per-needle (few-secrets) path.
    const few = createRedactor(['AAAAexample-overlap', 'example-overlapZZZZ']);
    expect(few.redactString('<AAAAexample-overlapZZZZ>')).toBe('<[redacted]>');
  });
});

// Issue #46: a short secret embedded in a JSON string inside a text or HTML
// body appears JSON-escaped; that form is redacted too
describe('createRedactor — JSON-escaped short secrets', () => {
  it('redacts the escaped form of a short secret with a quote, backslash or control character', () => {
    for (const secret of ['a"b1', 'a\\b1', 'a\nb1', 'a\u0001b', 'a/b"']) {
      const redactor = createRedactor([secret]);
      const escaped = JSON.stringify(secret).slice(1, -1);
      const html = `<pre>{"token":"${escaped}"}</pre>`;
      expect(redactor.redactString(html)).toBe('<pre>{"token":"[redacted]"}</pre>');
      expect(redactor.scanForSecret(html)).toBe(true);
    }
    // `\/` as some encoders write it
    expect(createRedactor(['a/b"']).redactString('x=a\\/b\\"')).toBe('x=[redacted]');
  });

  it('leaves a body unchanged that has the same escapes but not the secret', () => {
    const redactor = createRedactor(['a"b1']);
    const benign = String.raw`{"note":"say \"hi\"\n","path":"C:\\temp"}`;
    expect(redactor.redactString(benign)).toBe(benign);
    expect(redactor.scanForSecret(benign)).toBe(false);
  });

  it('adds no needle for a short secret without characters JSON escapes', () => {
    const redactor = createRedactor(['ab12']);
    expect(redactor.redactString(String.raw`x\"y ab12`)).toBe(String.raw`x\"y [redacted]`);
  });

  it('applies to runtime secrets and object keys too', () => {
    const redactor = createRedactor([]);
    redactor.registerRuntimeSecret('t"k1', Number.MAX_SAFE_INTEGER, 0);
    expect(redactor.redactString(String.raw`{"t\"k1":1}`)).toBe('{"[redacted]":1}');
  });
});
