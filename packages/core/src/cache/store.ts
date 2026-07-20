import { join } from 'node:path';
import { z } from 'zod';
import { validationError } from '../errors.ts';
import {
  CACHE_META_SCHEMA_VERSION,
  CACHE_TEXT_MAX,
  type CacheMeta,
  zCacheMeta,
} from '../schemas/cache.ts';
import { hashContent } from '../spec/load.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import type { CacheFs } from './fs.ts';
import { withNamespaceLock } from './lock.ts';
import {
  CACHE_MAX_PERSISTED_BYTES,
  CACHE_META_MAX_BYTES,
  type CacheLayout,
  objectPath,
} from './paths.ts';

// Only http(s) display sources are re-derivable; a file source is its own path
const URL_DISPLAY_SOURCE_RE = /^https?:\/\//iu;

// Round-7 finding 1: `isCacheAbsence`, `cacheIoError`, `asCacheError` and
// `withCacheErrors` are DEFINED in `cache/errors.ts` (Task 2 Step 2b) — never
// redeclared here. The round-7 draft said so in a comment while keeping the
// definitions in this module, which would have left `lock.ts` importing a
// module that was never created.
//
// Round-8 finding 2: they are NOT imported yet either. Nothing in this task's
// store code calls them — the D17 boundary is applied to store.ts in Task 4
// Step 3b, and Task 4 adds the import at the same moment it adds the first use.
// Importing them here would leave this task's commit failing the repo's
// unused-import check, which Step 7 runs as part of a full `pnpm check`.
//
// So this task's exports — the writers AND `readCacheEntry` below — ship
// unwrapped for one commit, and that is deliberate. It differs from `lock.ts`,
// which is wrapped inside Task 2, because `lock.ts` is COMPLETE in that task
// while `store.ts` is genuinely built across Tasks 3 and 4. Wrapping half the
// module here and re-wrapping the rest there would mean renaming the same
// exports twice; Step 3b is the single coherent moment at which every export
// exists. The intermediate exposure is a raw I/O error surfacing as exit 1
// instead of exit 3 within one commit, and no released surface depends on it.

// D14: one persisted representation. The validated, dereferenced, normalized
// document, JSON.stringify'd — no pretty-printing, no trailing newline — so the
// bytes are reproducible and the hash over them is stable.
export const persistedSpecText = (document: Record<string, unknown>): string =>
  JSON.stringify(document);

// Spec §5.3: credentials, headers, and raw URLs with query strings are never
// cached. A URL display source must be exactly origin + path, which also rules
// out a fragment and userinfo (URL.origin excludes both).
const assertRedactedDisplaySource = (displaySource: string): void => {
  if (!URL_DISPLAY_SOURCE_RE.test(displaySource)) {
    return;
  }
  let url: URL;
  try {
    url = new URL(displaySource);
  } catch {
    throw validationError('cache metadata display source is not a valid URL');
  }
  if (`${url.origin}${url.pathname}` !== displaySource) {
    // Never echo the offending value: it is exactly the case where it may carry a secret
    throw validationError(
      'refusing to cache a spec source that is not in the redacted origin + path form (spec §5.3)',
    );
  }
};

const serializeMeta = (meta: CacheMeta): string => {
  const result = zCacheMeta.safeParse(meta);
  if (!result.success) {
    throw validationError(
      `refusing to write malformed cache metadata: ${z.prettifyError(result.error)}`,
    );
  }
  assertRedactedDisplaySource(result.data.displaySource);
  const json = `${JSON.stringify(result.data, undefined, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > CACHE_META_MAX_BYTES) {
    // The reader refuses anything over this cap, so the writer must too
    throw validationError(
      `refusing to write cache metadata larger than the ${CACHE_META_MAX_BYTES}-byte budget`,
    );
  }
  return json;
};

const prepareDirs = async (layout: CacheLayout, fs: CacheFs): Promise<void> => {
  // Explicit per-level creation so every level gets the 0700 chmod (D4)
  await fs.mkdirSecure(layout.dir);
  await fs.mkdirSecure(layout.objectsDir);
};

// D14 / round-3 finding 10: the budget is checked BEFORE the aggregate string
// exists. The round-3 draft called persistedSpecText (an unbounded
// JSON.stringify) and measured the result — but dereferencing can repeat a
// large source string through many $ref expansions while staying inside the
// 500,000-node budget, so the allocation being refused could already have
// happened, at whatever size the document implied.
//
// This walks the document and accumulates the serialized size incrementally,
// abandoning the walk the moment it exceeds the budget. It computes the same
// number JSON.stringify would produce for the shapes the cache persists (the
// validated, dereferenced document: objects, arrays, strings, finite numbers,
// booleans, null), so a document that passes here serializes to exactly what
// was measured.
// Round-4 finding 1: every fragment is measured in UTF-8 BYTES. The round-4
// draft accumulated `JSON.stringify(...).length`, which is UTF-16 code units,
// while `readFileTextCapped` and the stated policy are byte-based. Probed over
// a generated corpus: that version was wrong for 5,053 of 20,000 values and
// ALWAYS in the understating direction — so a multibyte document passed the
// writer, was persisted above the cap, and was corrupt on its very first read.
// That is precisely the D14 invariant this preflight exists to establish.
// The minimal case: JSON.stringify({x:'é' + EMOJI}) is 11 UTF-16 units and
// 14 UTF-8 bytes.
export const serializedSizeWithin = (value: unknown, budget: number): number | undefined => {
  let used = 0;
  const overflow = Symbol('overflow');
  const addBytes = (byteCount: number): void => {
    used += byteCount;
    if (used > budget) {
      throw overflow;
    }
  };
  // Structural characters are ASCII, so their byte count equals their count
  const addFragment = (fragment: string): void => {
    addBytes(Buffer.byteLength(fragment, 'utf8'));
  };
  // Round-5 finding 3: the sizer is EXACT only for a JSON-safe, dense,
  // plain-object tree, and the exported writers accept Record<string, unknown>,
  // which admits more than that. Rather than reimplement JSON.stringify's
  // replacement semantics, the domain is now ENFORCED: anything outside it is
  // refused before sizing, so the D14 write-then-read invariant cannot be
  // violated by a caller of the exported store. The parse+dereference pipeline
  // produces exactly this shape, so the precondition costs it nothing.
  //
  // Specifically rejected: undefined and holes inside arrays (stringify emits
  // null, the walker would skip them), objects carrying a toJSON hook
  // (stringify serializes the replacement), functions/symbols/bigint, and
  // cycles (which would otherwise fail only after the preflight).
  const unsupported = Symbol('unsupported');
  const seen = new Set<object>();
  // JSON.stringify(undefined) produces NO string at all, so a top-level
  // undefined must be refused rather than reported as zero bytes by the final
  // no-op branch (round-6 finding 1)
  if (value === undefined) {
    throw validationError('refusing to cache a document that is not a JSON object');
  }
  const walk = (node: unknown): void => {
    if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
      throw unsupported;
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'number') {
      // Non-finite numbers serialize as null — four ASCII bytes either way
      addFragment(JSON.stringify(node) ?? 'null');
      return;
    }
    if (typeof node === 'string') {
      // Exact: JSON.stringify escapes, so the ENCODED form is what counts, and
      // its byte length is what lands on disk
      addFragment(JSON.stringify(node));
      return;
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) {
        throw unsupported; // A cycle
      }
      // Round-7 finding 2: arrays get the SAME enforcement as objects. Round 7
      // added the prototype/descriptor rules to the object branch only, so an
      // own accessor at an index recreated the exact D14 bypass it had just
      // closed — the element was read for the undefined check, again for the
      // walk, and a third time by JSON.stringify, so a getter could answer
      // small twice and over-budget once. An array-level toJSON hook had the
      // same problem as on an object.
      if (Object.getPrototypeOf(node) !== Array.prototype) {
        throw unsupported; // A subclass is outside the domain
      }
      if (typeof (node as { toJSON?: unknown }).toJSON === 'function') {
        throw unsupported;
      }
      seen.add(node);
      addBytes(2); // The brackets
      for (let index = 0; index < node.length; index += 1) {
        // An own DATA descriptor, and the CAPTURED value is what gets walked,
        // so the element is read exactly once. A hole or an explicit undefined
        // serializes as null, which the round-5 walker skipped entirely —
        // {"x":[undefined]} is 12 bytes, it counted 8.
        const descriptor = Object.getOwnPropertyDescriptor(node, index);
        if (
          descriptor === undefined ||
          typeof descriptor.get === 'function' ||
          typeof descriptor.set === 'function' ||
          descriptor.value === undefined
        ) {
          throw unsupported;
        }
        if (index > 0) {
          addBytes(1); // The comma
        }
        walk(descriptor.value);
      }
      seen.delete(node);
      return;
    }
    if (typeof node === 'object') {
      if (seen.has(node)) {
        throw unsupported; // A cycle
      }
      // A toJSON hook means the serialized form is NOT this object
      if (typeof (node as { toJSON?: unknown }).toJSON === 'function') {
        throw unsupported;
      }
      // Round-6 finding 1: the round-6 draft CLAIMED a plain-object tree and
      // then accepted any object at all. Two consequences, both breaking
      // exactness. Boxed primitives: JSON.stringify(new Number(5)) is '5' while
      // Object.entries sees nothing and the walker counts '{}'. And an
      // enumerable GETTER is worse than inexact — sizing and persistedSpecText
      // read the property twice, so a getter can answer small for the preflight
      // and over-budget for the stringify that follows, defeating the check
      // entirely. Requiring a plain prototype and own enumerable DATA
      // descriptors makes the double read provably identical.
      const prototype = Object.getPrototypeOf(node) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw unsupported;
      }
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(node))) {
        if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
          throw unsupported;
        }
      }
      seen.add(node);
      addBytes(2); // The braces
      let first = true;
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          continue; // JSON.stringify omits the whole member, key included
        }
        if (!first) {
          addBytes(1); // The comma
        }
        first = false;
        addFragment(JSON.stringify(key));
        addBytes(1); // The colon
        walk(item);
      }
      seen.delete(node);
      // The if-chain above is now exhausted, so control falls out of `walk`
      // normally: an explicit return here would be redundant (no-useless-return)
    }
    // Undefined / function / symbol: JSON.stringify omits or nulls these, and
    // the persisted document contains none of them
  };
  try {
    walk(value);
  } catch (err) {
    if (err === overflow) {
      return undefined;
    }
    if (err === unsupported) {
      throw validationError(
        'refusing to cache a document containing values JSON cannot round-trip exactly (undefined or sparse array members, a toJSON hook, a bigint, a function, or a cycle)',
      );
    }
    throw err;
  }
  return used;
};

// Enforced BEFORE the lock is taken and before serialization, on both writers,
// against the same constant the read path uses — so "anything this build
// persisted, this build can read back" holds by construction.
const persistableTextOrThrow = (
  document: Record<string, unknown>,
  slot: 'accepted' | 'candidate',
): string => {
  if (serializedSizeWithin(document, CACHE_MAX_PERSISTED_BYTES) === undefined) {
    throw validationError(
      `refusing to cache the ${slot} spec: its dereferenced form exceeds the ${CACHE_MAX_PERSISTED_BYTES}-byte persisted-document budget`,
    );
  }
  return persistedSpecText(document);
};

// D12 mechanisms 1 and 2. Spec objects are immutable and content-addressed, so
// writing a generation only ever CREATES a file and can never disturb the bytes
// the live meta.json points at — which is precisely what the round-1 draft's
// fixed accepted/spec.json replacement did, leaving old metadata pointing at new
// bytes both transiently and, after a crash, permanently. meta.json is replaced
// atomically second, and unreferenced objects are collected only AFTER that
// commit succeeds, so meta.json is authoritative at every instant.
const commitEntry = async (
  layout: CacheLayout,
  fs: CacheFs,
  objects: readonly { hash: string; text: string }[],
  meta: CacheMeta,
): Promise<void> => {
  const metaJson = serializeMeta(meta);
  await prepareDirs(layout, fs);
  for (const object of objects) {
    const path = objectPath(layout, object.hash);
    // Round-3 finding 5: an existing file at this name is NOT trusted merely
    // because of its name. The round-3 draft skipped the write whenever the
    // path existed, so a damaged or attacker-planted file under a hash we were
    // about to commit became the authoritative object the moment the new
    // metadata named it. Verify the bytes; only genuinely identical content may
    // be reused, and anything else is a corrupt entry rather than something to
    // silently overwrite (overwriting would also be the one mutation this
    // layout exists to avoid, and a lock-free reader may be holding it).
    if (await fs.pathExists(path)) {
      const existing = await fs.readFileTextCapped(path, CACHE_MAX_PERSISTED_BYTES);
      if (hashContent(existing) !== object.hash) {
        throw validationError(
          `cache entry ${layout.namespace} already holds a spec object whose contents do not match its own name — run "openapi-mcp cache clear" to reset this entry deliberately`,
        );
      }
      continue;
    }
    await fs.writeFileAtomic(path, object.text);
  }
  await fs.writeFileAtomic(layout.metaPath, metaJson);
  await collectGarbage(layout, fs, meta);
};

// Runs strictly after the commit. Anything the newly committed meta.json does
// not reference is unreachable, including an object orphaned by a crash in an
// earlier attempt. A failure here is deliberately swallowed: the commit already
// succeeded, and leaving a stray object is a wasted inode, not a correctness
// problem — turning it into an error would fail a write that actually worked.
const collectGarbage = async (layout: CacheLayout, fs: CacheFs, meta: CacheMeta): Promise<void> => {
  const referenced = new Set<string>([`${meta.acceptedContentHash}.json`]);
  if (meta.candidate !== undefined) {
    referenced.add(`${meta.candidate.contentHash}.json`);
  }
  try {
    for (const name of await fs.readDirNames(layout.objectsDir)) {
      if (!referenced.has(name)) {
        await fs.removeFile(join(layout.objectsDir, name));
      }
    }
  } catch {
    // See above: best-effort by design
  }
};

// Three-way metadata read, shared by every store entry point (D5). "miss" means
// there is no evidence a baseline ever existed here; everything else that is
// not a clean parse is "corrupt" and fails closed.
export type MetaReadResult =
  | { kind: 'miss' }
  | { kind: 'ok'; meta: CacheMeta }
  | { kind: 'corrupt'; reason: string };

// Private (round-6 finding): it performs I/O and is not in the wrapped export
// list. Every consumer lives in this same module — the writers above, and the
// public reader below. (Round-9 prose: this said Task 4's read half was its
// only consumer, which was already untrue for writeCandidate and
// touchRevalidated, and is doubly so now that readCacheEntry is in this task.)
const readMetaFile = async (layout: CacheLayout, fs: CacheFs): Promise<MetaReadResult> => {
  if (!(await fs.pathExists(layout.dir))) {
    return { kind: 'miss' };
  }
  // Round-3 finding 3: the round-3 draft listed the objects directory here
  // inside a bare `catch {}`, which turned an EACCES or EIO on that directory
  // into "nothing cached" — a miss, the one outcome that may become
  // trust-on-first-use (D17). The listing is not needed at all now that
  // orphan-only namespaces are a miss by rule rather than by count, so the
  // swallowing catch is simply deleted rather than narrowed.
  const hasMeta = await fs.pathExists(layout.metaPath);
  if (!hasMeta) {
    // Round-3 finding 2, corrected. The round-3 draft returned `corrupt` here
    // whenever any object existed, which permanently wedged a namespace whose
    // FIRST-EVER commit crashed between the object write and the metadata
    // replace: objects present, no metadata, and D5 forbids healing a corrupt
    // entry automatically. There was no way out but a manual `cache clear` on a
    // first run — the exact failure D5's abandoned-scaffold rule already exists
    // to avoid.
    //
    // An orphan object is not a baseline. Nothing claims it: with content
    // addressing the bytes carry no authority unless some meta.json names them,
    // and no meta.json does. The security argument is D5's own: an attacker who
    // can delete meta.json can equally delete the whole directory, which yields
    // `miss` regardless — so treating orphan-only as `miss` grants no
    // capability that was not already there. What it does buy is that a crashed
    // first write self-heals on the next run instead of bricking the entry.
    //
    // The orphans are reclaimed by the next successful commit's GC.
    return { kind: 'miss' };
  }
  let raw: string;
  try {
    raw = await fs.readFileTextCapped(layout.metaPath, CACHE_META_MAX_BYTES);
  } catch {
    return {
      kind: 'corrupt',
      reason: `cache metadata for entry ${layout.namespace} cannot be read within its ${CACHE_META_MAX_BYTES}-byte budget`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the file contents: they are untrusted and possibly hostile
    return {
      kind: 'corrupt',
      reason: `cache metadata for entry ${layout.namespace} is not valid JSON`,
    };
  }
  const result = zCacheMeta.safeParse(parsed);
  if (!result.success) {
    // The zod issue list quotes the offending values, so it is not repeated here
    return {
      kind: 'corrupt',
      reason: `cache metadata for entry ${layout.namespace} does not match the expected schema (version ${CACHE_META_SCHEMA_VERSION})`,
    };
  }
  return { kind: 'ok', meta: result.data };
};

export const corruptEntryError = (reason: string): Error =>
  validationError(
    `${reason} — the accepted baseline is the durable record of what you approved, so it is not silently refetched; run "openapi-mcp cache clear" to reset this entry deliberately`,
  );

// The single place the 3.0/3.1 discriminator is derived from a document's own
// "openapi" field. Used by BOTH the read path (round-3 finding 7: verify rather
// than trust mutable metadata) and promotion, both of which land in Task 4 —
// but it is defined HERE because writeAccepted below is its first caller.
// Round-8 finding 2: the round-8 draft defined it in Task 4 while calling it in
// Task 3, so Task 3 could not have passed the typecheck its own Step 7 claims.
// Reading one field is not revalidation, so D16(b) still holds.
export const declaredOpenapiVersion = (
  document: Record<string, unknown>,
): OpenapiVersion | undefined => {
  const declared = document['openapi'];
  if (typeof declared === 'string') {
    if (declared.startsWith('3.0.')) {
      return '3.0';
    }
    if (declared.startsWith('3.1.')) {
      return '3.1';
    }
  }
  return undefined;
};

export const writeAccepted = async (
  layout: CacheLayout,
  fs: CacheFs,
  input: {
    document: Record<string, unknown>;
    sourceContentHash: string;
    displaySource: string;
    title: string;
    specVersion: string;
    fetchedAt: number;
    cacheKey?: string | undefined;
    etag?: string | undefined;
    lastModified?: string | undefined;
  },
): Promise<{ acceptedContentHash: string }> => {
  // Round-4 finding: openapiVersion is DERIVED here, not supplied. Round 2
  // added it to the input; round 3 then made the reader verify it against the
  // document — which left a public writer able to persist an entry that its own
  // next read rejects. Deriving it removes that state entirely: one function
  // decides the discriminator, on write and on read alike.
  const openapiVersion = declaredOpenapiVersion(input.document);
  if (openapiVersion === undefined) {
    throw validationError('refusing to cache a spec that declares no usable OpenAPI version');
  }
  // D14: bounded before the lock AND before serialization (round-3 finding 10),
  // so an over-budget document blocks no namespace, never allocates the string
  // it is being refused for, and — unlike the round-1 draft, which checked only
  // the candidate — cannot be persisted into an entry the next read classifies
  // as corrupt
  const acceptedText = persistableTextOrThrow(input.document, 'accepted');
  // D14: the store hashes the bytes it is about to persist. No caller supplies
  // this value, so meta.json cannot disagree with the file it describes.
  const acceptedContentHash = hashContent(acceptedText);
  return withNamespaceLock(layout, fs, input.fetchedAt, async () => {
    // This deliberately drops any waiting candidate: a new accepted baseline
    // written here supersedes it. That is correct HERE — but it is why the 304
    // path must NOT route through this function (D16a2), which is what
    // silently destroyed candidates in the round-1 draft.
    await commitEntry(layout, fs, [{ hash: acceptedContentHash, text: acceptedText }], {
      schemaVersion: CACHE_META_SCHEMA_VERSION,
      displaySource: input.displaySource,
      ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
      ...(input.etag === undefined ? {} : { etag: input.etag }),
      ...(input.lastModified === undefined ? {} : { lastModified: input.lastModified }),
      fetchedAt: input.fetchedAt,
      acceptedContentHash,
      sourceContentHash: input.sourceContentHash,
      title: input.title,
      specVersion: input.specVersion,
      // D16b: persisted so a hit needs no revalidation, and DERIVED above so
      // the value can never contradict the bytes it describes
      openapiVersion,
    });
    return { acceptedContentHash };
  });
};

export const writeCandidate = async (
  layout: CacheLayout,
  fs: CacheFs,
  input: {
    document: Record<string, unknown>;
    sourceContentHash: string;
    title: string;
    specVersion: string;
    fetchedAt: number;
    etag?: string | undefined;
    lastModified?: string | undefined;
  },
): Promise<{ candidateContentHash: string }> => {
  if (input.title.length > CACHE_TEXT_MAX || input.specVersion.length > CACHE_TEXT_MAX) {
    // Fail before the lock: nothing is written and no namespace is blocked
    throw validationError(
      'refusing to record a candidate whose title or version exceeds the metadata bounds',
    );
  }
  // D14: the same persisted-document budget the accepted writer and the reader
  // use, not the source-download budget the round-1 draft compared against —
  // and checked before serialization (round-3 finding 10)
  const candidateText = persistableTextOrThrow(input.document, 'candidate');
  const candidateContentHash = hashContent(candidateText);
  return withNamespaceLock(layout, fs, input.fetchedAt, async () => {
    const existing = await readMetaFile(layout, fs);
    if (existing.kind === 'miss') {
      throw validationError(
        `cache entry ${layout.namespace} has no accepted baseline — a candidate is only meaningful alongside one`,
      );
    }
    if (existing.kind === 'corrupt') {
      // D5: never paper over a broken baseline by writing next to it
      throw corruptEntryError(existing.reason);
    }
    // The accepted half is copied through untouched: a candidate is stored,
    // never activated (§6.3), so meta.title/specVersion keep describing what is
    // actually served. D16(a2): the validators recorded are the ones returned
    // WITH the candidate — they describe the most recently fetched
    // representation, which is this one. The round-1 draft carried the accepted
    // entry's stale validators forward, so the next conditional request asked
    // about a representation the cache no longer had.
    // Round-3 finding 6: the OLD validators are stripped first. The round-3
    // draft spread `existing.meta` and then conditionally added the new ones,
    // so a 200 response that carried NO ETag left the previous
    // representation's ETag in place — the next conditional request then asked
    // the server about a representation this cache no longer held, which is
    // precisely what D16(a2) exists to prevent. Retaining an omitted validator
    // is correct only for the 304 transition, which is why that lives in its
    // own function.
    const {
      etag: _staleEtag,
      lastModified: _staleLastModified,
      ...withoutValidators
    } = existing.meta;
    const meta: CacheMeta = {
      ...withoutValidators,
      fetchedAt: input.fetchedAt,
      ...(input.etag === undefined ? {} : { etag: input.etag }),
      ...(input.lastModified === undefined ? {} : { lastModified: input.lastModified }),
      candidate: {
        contentHash: candidateContentHash,
        sourceContentHash: input.sourceContentHash,
        title: input.title,
        specVersion: input.specVersion,
      },
    };
    // Both objects stay referenced, so the accepted bytes survive untouched and
    // GC reclaims only what the previous generation left behind
    await commitEntry(layout, fs, [{ hash: candidateContentHash, text: candidateText }], meta);
    return { candidateContentHash };
  });
};

// D16(a2): the 304 transition, which the round-1 draft did not have — it routed
// a 304 through writeAccepted, which rewrites the accepted entry and CLEARS the
// candidate, so revalidating silently discarded a candidate awaiting promotion
// without ever approving it. This updates the timestamp and the validators and
// touches nothing else: no object is written, and both slots survive verbatim.
export const touchRevalidated = (
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
  validators: { etag?: string | undefined; lastModified?: string | undefined },
): Promise<void> =>
  withNamespaceLock(layout, fs, nowMs, async () => {
    const existing = await readMetaFile(layout, fs);
    if (existing.kind === 'miss') {
      throw validationError(`cache entry ${layout.namespace} has no baseline to revalidate`);
    }
    if (existing.kind === 'corrupt') {
      throw corruptEntryError(existing.reason);
    }
    // A 304 answered to a request carrying no validator returns none either, in
    // which case the recorded ones stay as they are rather than being erased
    const meta: CacheMeta = {
      ...existing.meta,
      fetchedAt: nowMs,
      ...(validators.etag === undefined ? {} : { etag: validators.etag }),
      ...(validators.lastModified === undefined ? {} : { lastModified: validators.lastModified }),
    };
    await prepareDirs(layout, fs);
    await fs.writeFileAtomic(layout.metaPath, serializeMeta(meta));
  });

// ---------------------------------------------------------------------------
// The public reader. Round-9 finding 1 moved it here from Task 4: this task's
// tests verify the transactional write invariants, and those invariants are
// stated in terms of what a LOCK-FREE PUBLIC READER observes across a commit —
// so the reader is part of the store core, not of the promote/clear/list layer.
// Asserting them against the fake filesystem's raw map instead would be a
// weaker substitute rather than a clean write/read separation, and the task
// could not pass its own Step 6 and Step 7 gates without the reader present.
// ---------------------------------------------------------------------------

export interface CacheEntry {
  meta: CacheMeta;
  acceptedDocument: Record<string, unknown>;
}

// D5: absent, usable, and corrupt are three distinct outcomes, and only "miss"
// may become an accepted baseline without operator action
export type CacheReadResult =
  | { kind: 'miss' }
  | { kind: 'hit'; entry: CacheEntry }
  | { kind: 'corrupt'; reason: string };

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
};

// Every reason string below is assembled from layout.namespace — a hex digest by
// construction — and fixed English. Nothing read out of the suspect file is
// interpolated, so a hostile cache entry cannot steer the operator's terminal.
// Round-3 finding 1. Immutable objects do NOT by themselves make immediate
// reclamation safe. A lock-free reader can load meta generation A, a writer can
// then commit generation B and garbage-collect A's object, and the reader —
// still holding A's hash — finds nothing and reports corruption on a cache that
// is perfectly healthy. The round-3 draft introduced exactly this race while
// removing the previous one.
//
// The fix is a bounded re-read: if the object a generation names is missing,
// re-read meta.json. If it changed, the entry was committed underneath us and
// we simply retry against the new generation. If it did NOT change, the object
// is genuinely gone and the entry is corrupt (D5). Retries are bounded because
// each one requires a concurrent commit to have completed, so an unbounded
// sequence would require unbounded concurrent writers.
//
// Deliberately PRIVATE (round-9 finding 2): the tested behaviour is that the
// loop terminates within the documented bound, not that this number is part of
// the public API. The test names its own expected bound.
const READ_RETRY_LIMIT = 3;

export const readCacheEntry = async (
  layout: CacheLayout,
  fs: CacheFs,
): Promise<CacheReadResult> => {
  for (let attempt = 0; ; attempt += 1) {
    const metaRead = await readMetaFile(layout, fs);
    if (metaRead.kind !== 'ok') {
      return metaRead;
    }
    const { meta } = metaRead;
    let acceptedText: string;
    try {
      // D12.1: the object is addressed BY its recorded hash, so a stale
      // meta.json can never point at bytes some later write replaced — the
      // bytes for a given hash are immutable and the filename proves which
      // generation they belong to. D14: the cap is the persisted-document
      // budget the writers enforce, so a validly written entry is always
      // readable back.
      acceptedText = await fs.readFileTextCapped(
        objectPath(layout, meta.acceptedContentHash),
        CACHE_MAX_PERSISTED_BYTES,
      );
    } catch {
      // Round-4 finding 2: the round-4 draft retried only when the re-read
      // metadata was `ok` with a DIFFERENT accepted hash. That missed two
      // states. A concurrent `clear` leaves the recheck at `miss`, and the
      // reader then reported `corrupt` on an entry an operator had merely
      // asked to delete — contradicting the clear-vs-read assertion that the
      // reader stays exit 0. And a clear followed by re-seeding identical
      // content produces a NEW generation with the SAME hash, which a
      // hash-change test cannot see at all.
      //
      // The state machine is therefore: recheck `miss` is a miss (the entry is
      // gone, which is a legitimate outcome, not damage); any `ok` recheck is
      // retried while attempts remain, regardless of whether the hash changed,
      // because the object may have been re-created underneath us; only an
      // exhausted budget or a `corrupt` recheck falls through to corrupt.
      const recheck = await readMetaFile(layout, fs);
      if (recheck.kind === 'miss') {
        return { kind: 'miss' };
      }
      if (recheck.kind === 'ok' && attempt < READ_RETRY_LIMIT) {
        continue;
      }
      if (recheck.kind === 'corrupt') {
        return recheck;
      }
      return {
        kind: 'corrupt',
        reason: `the accepted spec for cache entry ${layout.namespace} cannot be read within its ${CACHE_MAX_PERSISTED_BYTES}-byte budget`,
      };
    }
    if (hashContent(acceptedText) !== meta.acceptedContentHash) {
      // Tampered bytes must never become the baseline. No retry here: the
      // object is filed UNDER this hash, so content that does not produce it is
      // damage, not a lost race.
      return {
        kind: 'corrupt',
        reason: `the accepted spec for cache entry ${layout.namespace} does not match its recorded content hash`,
      };
    }
    const acceptedDocument = parseJsonObject(acceptedText);
    if (acceptedDocument === undefined) {
      return {
        kind: 'corrupt',
        reason: `the accepted spec for cache entry ${layout.namespace} is not a JSON object`,
      };
    }
    // Round-3 finding 7: the 3.0/3.1 discriminator is verified against the
    // document's own "openapi" field rather than trusted from metadata. The
    // hash protects the OBJECT, not meta.json — so an attacker who can edit
    // metadata could otherwise force a 3.1 document to be normalized under 3.0
    // rules without breaking any hash. Reading one field is not revalidation
    // (promotion already does exactly this), so D16(b) still holds.
    const declared = declaredOpenapiVersion(acceptedDocument);
    if (declared === undefined || declared !== meta.openapiVersion) {
      return {
        kind: 'corrupt',
        reason: `the accepted spec for cache entry ${layout.namespace} declares an OpenAPI version that does not match its metadata`,
      };
    }
    return { kind: 'hit', entry: { meta, acceptedDocument } };
  }
};
