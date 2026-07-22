import { z } from 'zod';
import type { OpenapiVersion } from '../spec/validate.ts';

// A literal, not a range: an entry written by any other version is unreadable
// by construction, which surfaces as a corrupt entry rather than a partially
// understood one (D5)
export const CACHE_META_SCHEMA_VERSION = 1;

// Content hashes are sha256 hex digests produced by the store from the exact
// persisted bytes (D14)
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/u;

// ETag and Last-Modified come back from a remote server and are replayed as
// request headers on the next revalidation: bound them to printable ASCII and
// 1–256 chars so a stored validator can never carry a header-injection
// sequence. Shared with fetch.ts's readValidator so the drop rule and the
// persisted schema can never diverge.
export const VALIDATOR_RE = /^[ -~]{1,256}$/u;

// The same charset parseCacheKey enforces (D9); revalidated here because
// meta.json is untrusted input on the way back in
const CACHE_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/u;

const DISPLAY_SOURCE_MAX = 2048;
const VALIDATOR_MAX = 256;
const TEXT_MAX = 256;

// The optional members are declared "?: string | undefined" because the repo
// compiles with exactOptionalPropertyTypes: zod infers "string | undefined" for
// an .optional() field, and the narrower "?: string" form makes the
// z.ZodType<CacheMeta> annotation below fail with TS2375 (D11).
// D18: ONE nested member rather than two independently optional hashes. The
// round-1 shape admitted a schema-valid file carrying exactly one of them, and
// promoteCandidate then silently fell back to the accepted entry's source hash
// — recording a promoted baseline whose provenance was that of the document it
// replaced. Nesting makes "a candidate is waiting" all-or-none by construction.
// Title and version live here too, so promotion no longer has to recover them
// from the document it is promoting.
export interface CacheCandidate {
  contentHash: string;
  sourceContentHash: string;
  title: string;
  specVersion: string;
}

export interface CacheMeta {
  schemaVersion: number;
  displaySource: string;
  cacheKey?: string | undefined;
  // D16(a2): these describe the MOST RECENTLY FETCHED representation, whichever
  // slot it landed in — so a candidate write updates them, and a later 304
  // means "that representation is still current" and must preserve both slots
  etag?: string | undefined;
  lastModified?: string | undefined;
  fetchedAt: number;
  // Sha256 of the persisted accepted bytes, which is also its object filename (D14)
  acceptedContentHash: string;
  // Sha256 of the SOURCE text those bytes were derived from (D14)
  sourceContentHash: string;
  candidate?: CacheCandidate | undefined;
  title: string;
  specVersion: string;
  // Info.version is NOT the OpenAPI version: normalizeSpec needs the 3.0/3.1
  // discriminator, and persisting it is what lets a cache hit skip revalidation
  openapiVersion: OpenapiVersion;
}

const zContentHash = z.string().regex(CONTENT_HASH_RE);
const zValidator = z.string().min(1).max(VALIDATOR_MAX).regex(VALIDATOR_RE);

// D18: the largest value new Date(x).toISOString() renders. Probed:
// new Date(Number.MAX_SAFE_INTEGER).toISOString() throws RangeError, so the
// round-1 bound admitted metadata that crashed "cache list" while printing it.
export const FETCHED_AT_MAX = 8_640_000_000_000_000;

const zCandidate = z.strictObject({
  contentHash: zContentHash,
  sourceContentHash: zContentHash,
  title: z.string().max(TEXT_MAX),
  specVersion: z.string().max(TEXT_MAX),
});

// A strict object, not a loose one: an unknown key means the file was written
// by something this build does not understand, and guessing is the failure
// mode D5 exists to prevent.
export const zCacheMeta: z.ZodType<CacheMeta> = z.strictObject({
  schemaVersion: z.literal(CACHE_META_SCHEMA_VERSION),
  // Always the redacted origin + path form (spec §5.3); enforced again on write
  displaySource: z.string().min(1).max(DISPLAY_SOURCE_MAX),
  cacheKey: z.string().regex(CACHE_KEY_RE).optional(),
  etag: zValidator.optional(),
  lastModified: zValidator.optional(),
  // D18: the Date limit, not MAX_SAFE_INTEGER — a schema-valid entry must always
  // be renderable by cache list
  fetchedAt: z.number().int().nonnegative().max(FETCHED_AT_MAX),
  acceptedContentHash: zContentHash,
  sourceContentHash: zContentHash,
  candidate: zCandidate.optional(),
  title: z.string().max(TEXT_MAX),
  specVersion: z.string().max(TEXT_MAX),
  // Exactly the OpenapiVersion union, not a free string: a cache hit does not
  // revalidate (D16b), so this value alone decides which normalize rules apply
  openapiVersion: z.enum(['3.0', '3.1']),
});

export const CACHE_TEXT_MAX = TEXT_MAX;

// Exported so cache/store.ts's summarize() can bound the sanitized
// displaySource it copies into a CacheEntrySummary at the same length this
// schema enforces on write, rather than a magic number of its own.
export const CACHE_DISPLAY_SOURCE_MAX = DISPLAY_SOURCE_MAX;
