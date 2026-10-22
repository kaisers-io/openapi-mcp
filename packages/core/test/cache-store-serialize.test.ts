import { assert, jsonValue, oneof, property } from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cacheLayout,
  hashContent,
  objectPath,
  promoteCandidate,
  serializeWithinBudget,
  serializedSizeWithin,
  writeAccepted,
  writeCandidate,
} from '../src/index.ts';
import type { CacheFs } from '../src/index.ts';
import { memoryCacheFs } from './helpers/cache-fs.ts';

// #75 replaced the fragment-by-fragment serializer with a measuring walk plus
// one native JSON.stringify. These properties pin the contract that change
// must keep: byte-identical output, and an exact UTF-8 budget boundary, over
// arbitrary JSON including non-ASCII, astral and lone-surrogate strings and
// the characters JSON escapes.
describe('serializeWithinBudget properties', () => {
  // 'binary' draws any code point, lone surrogates included; 'grapheme'
  // favours realistic multibyte text. Both units are needed: the first finds
  // escape-length bugs, the second multibyte-length bugs.
  const jsonValues = oneof(
    jsonValue({ stringUnit: 'binary' }),
    jsonValue({ stringUnit: 'grapheme' }),
    jsonValue(),
  );

  it('is byte-identical to JSON.stringify with an unlimited budget', () => {
    assert(
      property(jsonValues, (value) => {
        expect(serializeWithinBudget(value, Infinity)).toBe(JSON.stringify(value));
      }),
      { numRuns: 2000 },
    );
  });

  it('accepts at exactly the UTF-8 size and refuses one byte below it', () => {
    assert(
      property(jsonValues, (value) => {
        const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
        expect(serializeWithinBudget(value, bytes)).toBe(JSON.stringify(value));
        expect(serializedSizeWithin(value, bytes)).toBe(bytes);
        expect(serializeWithinBudget(value, bytes - 1)).toBeUndefined();
      }),
      { numRuns: 2000 },
    );
  });

  it('refuses a far-over-budget document without serializing it', () => {
    // One 1 MB string referenced 64 times: the shape $ref expansion produces.
    // The walk's lower bound passes the budget long before the end, so
    // JSON.stringify — which would allocate the full 64 MB — never runs.
    const big = 'x'.repeat(1_000_000);
    const doc = { paths: Array.from({ length: 64 }, () => ({ description: big })) };
    const original = JSON.stringify;
    let stringified = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      if (args[0] === doc) {
        stringified += 1;
      }
      return original(...args);
    }) as typeof JSON.stringify;
    try {
      expect(serializeWithinBudget(doc, 10_000_000)).toBeUndefined();
    } finally {
      JSON.stringify = original;
    }
    expect(stringified).toBe(0);
  });

  it('still refuses a document whose escapes alone push it over the budget', () => {
    // Every C0 control is ONE UTF-16 unit but a six-byte \u00XX escape, so the
    // lower bound fits while the real bytes do not: the exact check after
    // stringify must catch it
    const value = { s: '\u0001'.repeat(100) };
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(bytes).toBe(608);
    expect(serializeWithinBudget(value, 200)).toBeUndefined();
    expect(serializeWithinBudget(value, bytes)).toBe(JSON.stringify(value));
  });

  it('refuses a control-character-heavy document without serializing it', () => {
    // A control character is one UTF-16 unit but six output bytes: charged at
    // its UTF-16 length, these 4 MB of them would pass a 10 MB walk and make
    // JSON.stringify build ~24 MB before the exact check refused it
    const big = '\u0001'.repeat(1_000_000);
    const doc = { paths: Array.from({ length: 4 }, () => ({ description: big })) };
    const original = JSON.stringify;
    let stringified = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      if (args[0] === doc) {
        stringified += 1;
      }
      return original(...args);
    }) as typeof JSON.stringify;
    try {
      expect(serializeWithinBudget(doc, 10_000_000)).toBeUndefined();
    } finally {
      JSON.stringify = original;
    }
    expect(stringified).toBe(0);
  });

  it('detects a cycle deeper than the shallow-path window', () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 200; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor['next'] = child;
      cursor = child;
    }
    // Acyclic: serializes normally, deep and all
    expect(serializeWithinBudget(root, Infinity)).toBe(JSON.stringify(root));
    // A back-edge to the root and one to a deep ancestor are both cycles
    cursor['back'] = root;
    expect(() => serializeWithinBudget(root, Infinity)).toThrow(/round-trip exactly/u);
    delete cursor['back'];
    cursor['back'] = (root['next'] as Record<string, unknown>)['next'];
    expect(() => serializeWithinBudget(root, Infinity)).toThrow(/round-trip exactly/u);
  });

  it('accepts a shared (non-cyclic) subtree, as JSON.stringify does', () => {
    const shared = { type: 'object' };
    const doc = { a: shared, b: [shared, shared], c: { d: shared } };
    expect(serializeWithinBudget(doc, Infinity)).toBe(JSON.stringify(doc));
  });
});

// #75 point 3: one write must not read and hash the same object twice
describe('commitEntry reuses an object already verified under the lock', () => {
  const LAYOUT = cacheLayout('/cache', 'abcdef0123456789');
  const DOC = { openapi: '3.1.0', info: { title: 'v1', version: '1' }, paths: {} };
  const input = {
    document: DOC,
    sourceContentHash: hashContent('source-v1'),
    displaySource: 'https://api.example.com/openapi.json',
    title: 'v1',
    specVersion: '1',
    fetchedAt: 1,
  };

  const countingReads = (): { fs: CacheFs; reads: (path: string) => number } => {
    const inner = memoryCacheFs();
    const seen: string[] = [];
    return {
      fs: {
        ...inner,
        readFileTextCapped: (path, maxBytes) => {
          seen.push(path);
          return inner.readFileTextCapped(path, maxBytes);
        },
      },
      reads: (path) => seen.filter((entry) => entry === path).length,
    };
  };

  it('writeAccepted over the same accepted bytes reads that object once', async () => {
    const { fs, reads } = countingReads();
    const { acceptedContentHash } = await writeAccepted(LAYOUT, fs, input);
    const path = objectPath(LAYOUT, acceptedContentHash);
    expect(reads(path)).toBe(0);
    await writeAccepted(LAYOUT, fs, { ...input, fetchedAt: 2 });
    expect(reads(path)).toBe(1);
  });

  it('promoteCandidate reads the candidate object once', async () => {
    const { fs, reads } = countingReads();
    await writeAccepted(LAYOUT, fs, input);
    const { candidateContentHash } = await writeCandidate(LAYOUT, fs, {
      document: { ...DOC, paths: { '/a': {} } },
      sourceContentHash: hashContent('source-v2'),
      title: 'v1',
      specVersion: '2',
      fetchedAt: 2,
    });
    const path = objectPath(LAYOUT, candidateContentHash);
    const before = reads(path);
    await promoteCandidate(LAYOUT, fs, 3, {});
    expect(reads(path) - before).toBe(1);
  });
});
