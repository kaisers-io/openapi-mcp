import { describe, expect, it } from 'vitest';
import { jsonPreview, truncateUtf8 } from '../src/server/execute/response.ts';
import { TRUNCATION_MARKER } from '../src/spec/sanitize.ts';

// The implementation before #48 encoded the whole text: the oracle
const encoder = new TextEncoder();
const reference = (text: string, maxBytes: number): string => {
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) {
    return text;
  }
  const markerBytes = encoder.encode(TRUNCATION_MARKER).byteLength;
  const walkBack = (budget: number): string => {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(encoded.slice(0, budget));
      return `${decoded}${TRUNCATION_MARKER}`;
    } catch {
      return walkBack(budget - 1);
    }
  };
  return walkBack(Math.max(0, maxBytes - markerBytes));
};

// A deterministic generator, so a failure reproduces
const randomFrom = (seed: number) => {
  let state = seed;
  return (bound: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };
};

// One to four UTF-8 bytes, and lone surrogates, which encode as U+FFFD
const PIECES = ['a', 'é', '€', '😀', '\uD83D', '\uDE00', '"', '\n'];

describe('truncateUtf8 (#48)', () => {
  it('matches encoding the whole text for every cut', () => {
    const pick = randomFrom(7);
    for (let round = 0; round < 3000; round += 1) {
      const text = Array.from({ length: pick(40) }, () => PIECES[pick(PIECES.length)]).join('');
      const maxBytes = pick(60);
      expect(truncateUtf8(text, maxBytes)).toBe(reference(text, maxBytes));
    }
  });

  it('keeps a text that fits and marks one that does not', () => {
    expect(truncateUtf8('😀😀', 8)).toBe('😀😀');
    expect(truncateUtf8('😀😀', 7)).toBe(reference('😀😀', 7));
    expect(truncateUtf8('a'.repeat(100), 20).endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

// Random JSON-like values, with what JSON.stringify skips or rewrites
const valueOf = (pick: (bound: number) => number, depth: number): unknown => {
  const kind = pick(depth > 3 ? 6 : 9);
  switch (kind) {
    case 0: {
      return Array.from({ length: pick(6) }, () => PIECES[pick(PIECES.length)]).join('');
    }
    case 1: {
      return [0, -0, 1.5, -2e21, Number.NaN, Number.POSITIVE_INFINITY][pick(6)];
    }
    case 2: {
      return pick(2) === 0;
    }
    case 3: {
      // oxlint-disable-next-line unicorn/no-null -- JSON null is what is under test
      return null;
    }
    case 4: {
      return undefined;
    }
    case 5: {
      return new Date(pick(1_000_000) * 1_000_000);
    }
    case 6:
    case 7: {
      return Array.from({ length: pick(5) }, () => valueOf(pick, depth + 1));
    }
    default: {
      return Object.fromEntries(
        Array.from({ length: pick(5) }, (_unused, index) => [
          `${PIECES[pick(PIECES.length)] ?? ''}k${String(index)}`,
          valueOf(pick, depth + 1),
        ]),
      );
    }
  }
};

describe('jsonPreview (#48)', () => {
  it('matches truncating the whole serialization', () => {
    const pick = randomFrom(11);
    for (let round = 0; round < 3000; round += 1) {
      const value = { data: valueOf(pick, 0), status: 200 };
      const maxBytes = pick(300);
      expect(jsonPreview(value, maxBytes)).toBe(truncateUtf8(JSON.stringify(value), maxBytes));
    }
  });

  it('returns a value that fits whole', () => {
    const value = { items: [1, 'two', { three: true }] };
    expect(jsonPreview(value, 1000)).toBe(JSON.stringify(value));
    // A small size hint takes the native serializer, with the same result
    expect(jsonPreview(value, 10, 0)).toBe(jsonPreview(value, 10));
  });
});
