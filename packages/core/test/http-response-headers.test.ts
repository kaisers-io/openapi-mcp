import { describe, expect, it } from 'vitest';
import {
  captureResponseHeaders,
  MAX_CAPTURED_HEADERS,
  MAX_HEADER_VALUE_BYTES,
  parseLinkHeader,
  parseRetryAfter,
} from '../src/http/response-headers.ts';

describe('captureResponseHeaders', () => {
  it('keeps only the allowlist: pagination, location, validators, totals, rate limits', () => {
    const captured = captureResponseHeaders(
      new Headers({
        link: '<https://api.example.test/x?page=2>; rel="next"',
        location: '/things/1',
        etag: '"abc"',
        'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'retry-after': '3',
        'x-total-count': '42',
        'x-ratelimit-remaining': '9',
        'x-ratelimit-reset': '1700000000',
        ratelimit: 'limit=100, remaining=9, reset=30',
        'ratelimit-policy': '100;w=60',
        'set-cookie': 'session=example-token-not-a-secret',
        authorization: 'Bearer example-token-not-a-secret',
        'www-authenticate': 'Bearer realm="x"',
        'x-request-id': 'r-1',
        server: 'nginx',
      }),
    );
    expect(Object.keys(captured).toSorted()).toEqual(
      [
        'etag',
        'last-modified',
        'link',
        'location',
        'ratelimit',
        'ratelimit-policy',
        'retry-after',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'x-total-count',
      ].toSorted(),
    );
  });

  it('drops an over-long value whole instead of truncating it', () => {
    const captured = captureResponseHeaders([
      ['link', `<${'a'.repeat(MAX_HEADER_VALUE_BYTES)}>; rel="next"`],
      ['etag', '"ok"'],
    ]);
    expect(captured).toEqual({ etag: '"ok"' });
  });

  it('caps the number of captured headers and their total size', () => {
    const many = Array.from({ length: 40 }, (_unused, index): [string, string] => [
      `x-ratelimit-h${index}`,
      'v',
    ]);
    expect(Object.keys(captureResponseHeaders(many))).toHaveLength(MAX_CAPTURED_HEADERS);
    const big = Array.from({ length: 4 }, (_unused, index): [string, string] => [
      `x-ratelimit-b${index}`,
      'v'.repeat(3000),
    ]);
    // 8 KB total budget: only two 3 KB values fit.
    expect(Object.keys(captureResponseHeaders(big))).toHaveLength(2);
  });

  it('matches names case-insensitively', () => {
    expect(captureResponseHeaders([['X-Total-Count', '7']])).toEqual({ 'x-total-count': '7' });
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');

  it('parses delay-seconds', () => {
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
  });

  it('parses an IMF-fixdate HTTP-date relative to now, never negative', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 12:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('accepts the obsolete RFC 850 and asctime HTTP-date forms, as UTC', () => {
    expect(parseRetryAfter('Wednesday, 21-Oct-26 12:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Wed Oct 21 12:00:07 2026', now)).toBe(7000);
    expect(parseRetryAfter('Wed Oct  1 12:00:07 2026', now)).toBe(0);
  });

  it('caps an absurd value at one day', () => {
    expect(parseRetryAfter('99999999', now)).toBe(86_400_000);
  });

  it.each([
    '-1',
    '1.5',
    'soon',
    '',
    '3s',
    'Wed, 21 Foo 2026 12:00:05 GMT',
    '2026-10-21',
    'Wed Oct 21 12:00:07 2026 GMT',
  ])('rejects %j', (value) => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});

describe('parseLinkHeader (strict RFC 8288)', () => {
  it('parses the GitHub-style multi-link header', () => {
    expect(
      parseLinkHeader(
        '<https://api.github.com/repositories/1/issues?page=2>; rel="next", ' +
          '<https://api.github.com/repositories/1/issues?page=5>; rel="last"',
      ),
    ).toEqual([
      { target: 'https://api.github.com/repositories/1/issues?page=2', rels: ['next'] },
      { target: 'https://api.github.com/repositories/1/issues?page=5', rels: ['last'] },
    ]);
  });

  it('splits space-separated relation types, lowercases them, and honours only the first rel', () => {
    expect(parseLinkHeader('</p2>; REL="next Prefetch"; rel=last; title="a, b; c"')).toEqual([
      { target: '/p2', rels: ['next', 'prefetch'] },
    ]);
  });

  it('accepts a token rel, OWS around separators, and parameters without a value', () => {
    expect(parseLinkHeader(' </a> ;rel=next ; crossorigin ,</b>;rel=prev')).toEqual([
      { target: '/a', rels: ['next'] },
      { target: '/b', rels: ['prev'] },
    ]);
  });

  it('unescapes a quoted-pair inside a quoted parameter', () => {
    expect(parseLinkHeader(String.raw`</a>; title="say \"hi\""; rel="next"`)).toEqual([
      { target: '/a', rels: ['next'] },
    ]);
  });

  it('keeps a link without rel (no relation types)', () => {
    expect(parseLinkHeader('</a>')).toEqual([{ target: '/a', rels: [] }]);
  });

  it.each([
    ['missing angle brackets', 'https://x.test/a; rel="next"'],
    ['unterminated target', '<https://x.test/a; rel="next"'],
    ['whitespace in target', '<https://x.test/a b>; rel="next"'],
    ['unterminated quoted string', '</a>; rel="next'],
    ['junk after a link', '</a>; rel="next" junk'],
    ['empty parameter value', '</a>; rel='],
    ['missing parameter name', '</a>; ="next"'],
    ['trailing garbage after comma', '</a>; rel=next, garbage'],
  ])('rejects the whole header when malformed: %s', (_label, value) => {
    expect(parseLinkHeader(value)).toBeUndefined();
  });
});
