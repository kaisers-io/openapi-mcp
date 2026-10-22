import { describe, expect, it } from 'vitest';
import { deriveAccept, FALLBACK_ACCEPT } from '../src/server/execute/accept.ts';

const content = (...types: string[]) => ({
  content: Object.fromEntries(types.map((type) => [type, { schema: {} }])),
});

describe('deriveAccept', () => {
  it('falls back to JSON-first when no success response declares content', () => {
    expect(deriveAccept({})).toBe(FALLBACK_ACCEPT);
    expect(deriveAccept({ '204': { description: 'no content' } })).toBe(FALLBACK_ACCEPT);
    // Only error and default responses declare content: not a success type.
    expect(deriveAccept({ '404': content('text/html'), default: content('text/plain') })).toBe(
      FALLBACK_ACCEPT,
    );
  });

  it('puts every JSON variant first, then other declared types at q=0.9', () => {
    expect(
      deriveAccept({
        '200': content('text/csv', 'application/json'),
        '201': content('application/vnd.api+json'),
      }),
    ).toBe('application/json, application/vnd.api+json, text/csv;q=0.9, */*;q=0.1');
  });

  it('honours the OpenAPI 3.1 2XX range key', () => {
    expect(deriveAccept({ '2XX': content('application/json') })).toBe(
      'application/json, */*;q=0.1',
    );
  });

  it('keeps only the lowercased essence: parameters are dropped, duplicates collapsed', () => {
    expect(
      deriveAccept({
        '200': content('Application/JSON; charset=utf-8', 'application/json'),
      }),
    ).toBe('application/json, */*;q=0.1');
  });

  it('never copies a value that is not a bare type/subtype into the header', () => {
    expect(
      deriveAccept({
        '200': content('application/json\r\nX-Injected: 1', 'text plain', 'nonsense', 'a/b/c'),
      }),
    ).toBe(FALLBACK_ACCEPT);
  });

  it('treats a declared */* like no declaration, but keeps a declared subtype range', () => {
    expect(deriveAccept({ '200': content('*/*') })).toBe(FALLBACK_ACCEPT);
    expect(deriveAccept({ '200': content('image/*') })).toBe('image/*;q=0.9, */*;q=0.1');
  });

  it('caps the number of declared types it copies', () => {
    const many = Array.from({ length: 40 }, (_unused, index) => `application/x-t${index}+json`);
    const accept = deriveAccept({ '200': content(...many) });
    expect(accept.split(', ')).toHaveLength(16 + 1);
  });
});
