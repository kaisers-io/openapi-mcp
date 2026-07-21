import { describe, expect, it } from 'vitest';
import { CACHE_META_SCHEMA_VERSION, type CacheMeta, evaluateFreshness } from '../src/index.ts';

// The openapiVersion field is REQUIRED on CacheMeta. The round-1 fixture
// omitted it and would have failed typecheck the moment this file was
// compiled — the frozen writeAccepted signature had the same gap while
// Tasks 3 and 9 both passed the field (round-2 correction 7).
const META: CacheMeta = {
  schemaVersion: CACHE_META_SCHEMA_VERSION,
  displaySource: 'https://api.example.com/openapi.json',
  fetchedAt: 1_000_000,
  acceptedContentHash: 'a'.repeat(64),
  sourceContentHash: 'b'.repeat(64),
  title: 'Petstore',
  specVersion: '1.0.0',
  openapiVersion: '3.1',
};

const TTL = 60_000;

describe('evaluateFreshness', () => {
  it('reports fresh at age zero', () => {
    expect(evaluateFreshness(META, META.fetchedAt, TTL)).toEqual({ kind: 'fresh' });
  });

  it('reports fresh one millisecond inside the TTL', () => {
    expect(evaluateFreshness(META, META.fetchedAt + TTL - 1, TTL)).toEqual({ kind: 'fresh' });
  });

  it('reports revalidate exactly at the TTL boundary', () => {
    expect(evaluateFreshness(META, META.fetchedAt + TTL, TTL)).toMatchObject({
      kind: 'revalidate',
    });
  });

  it('always revalidates with a zero TTL', () => {
    expect(evaluateFreshness(META, META.fetchedAt, 0)).toMatchObject({ kind: 'revalidate' });
  });

  it('carries both validators when the entry recorded them', () => {
    const meta: CacheMeta = {
      ...META,
      etag: '"v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    };
    expect(evaluateFreshness(meta, meta.fetchedAt + TTL, TTL)).toEqual({
      kind: 'revalidate',
      etag: '"v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
  });

  it('carries only the validator the entry actually has', () => {
    const meta: CacheMeta = { ...META, etag: '"only"' };
    expect(evaluateFreshness(meta, meta.fetchedAt + TTL, TTL)).toEqual({
      kind: 'revalidate',
      etag: '"only"',
    });
  });

  it('omits absent validators rather than carrying undefined', () => {
    const decision = evaluateFreshness(META, META.fetchedAt + TTL, TTL);
    expect(decision).toEqual({ kind: 'revalidate' });
    expect(Object.keys(decision)).toEqual(['kind']);
  });

  it('revalidates an entry whose timestamp lies in the future', () => {
    // A clock change or a hand-edited entry must not grant unbounded freshness
    expect(evaluateFreshness(META, META.fetchedAt - 1, TTL)).toMatchObject({
      kind: 'revalidate',
    });
  });
});
