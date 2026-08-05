import { join } from 'node:path';
import { z } from 'zod';
import { OpenapiMcpError, conflictError, notFoundError, validationError } from '../errors.ts';
import { cacheIoError, isCacheAbsence, withCacheErrors } from './errors.ts';
import {
  CACHE_DISPLAY_SOURCE_MAX,
  CACHE_META_SCHEMA_VERSION,
  CACHE_TEXT_MAX,
  zCacheMeta,
} from '../schemas/cache.ts';
import type { CacheMeta } from '../schemas/cache.ts';
import { hashContent } from '../spec/load.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import type { CacheFs } from './fs.ts';
import { withNamespaceLock } from './lock.ts';
import {
  CACHE_MAX_PERSISTED_BYTES,
  CACHE_META_MAX_BYTES,
  cacheLayout,
  objectPath,
} from './paths.ts';
import type { CacheLayout } from './paths.ts';

// Only http(s) display sources are re-derivable; a file source is its own path
const URL_DISPLAY_SOURCE_RE = /^https?:\/\//iu;

// The one error boundary for this module: `isCacheAbsence`, `cacheIoError`
// and `withCacheErrors` are DEFINED in `cache/errors.ts` — never redeclared
// here. Every public store operation is wrapped in `withCacheErrors` at the
// bottom of this file, which is the single place a raw filesystem failure is
// typed as a validation error (exit 3) rather than surfacing as an unexpected
// exit 1.
//
// Credentials, headers, and raw URLs with query strings are never
// cached. A URL display source must be exactly origin + path, which also rules
// out a fragment and userinfo (URL.origin excludes both).
const assertRedactedDisplaySource = (displaySource: string): void => {
  if (!URL_DISPLAY_SOURCE_RE.test(displaySource)) {
    return;
  }
  // Imperative on purpose: `new URL` is synchronous, so there is no `.catch`
  // to inline into, and this security module forbids the helper extraction
  // or IIFE a try-as-expression would otherwise need.
  let url: URL;
  try {
    url = new URL(displaySource);
  } catch {
    throw validationError('cache metadata display source is not a valid URL');
  }
  if (`${url.origin}${url.pathname}` !== displaySource) {
    // Never echo the offending value: it is exactly the case where it may carry a secret
    throw validationError(
      'refusing to cache a spec source that is not in the redacted origin + path form',
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
  // Explicit per-level creation so every level gets the 0700 chmod
  await fs.mkdirSecure(layout.dir);
  await fs.mkdirSecure(layout.objectsDir);
};

// The budget is checked BEFORE the aggregate string exists. Calling an
// unbounded JSON.stringify and measuring the result would not work:
// dereferencing can repeat a large source string through many $ref expansions
// while staying inside the 500,000-node budget, so the allocation being
// refused could already have happened, at whatever size the document implied.
//
// This walks the document and accumulates the serialized size incrementally,
// abandoning the walk the moment it exceeds the budget. It computes the same
// number JSON.stringify would produce for the shapes the cache persists (the
// validated, dereferenced document: objects, arrays, strings, finite numbers,
// booleans, null), so a document that passes here serializes to exactly what
// was measured.
//
// Every fragment is measured in UTF-8 BYTES, not UTF-16 code units:
// `readFileTextCapped` and the stated policy are byte-based, while measuring
// via `JSON.stringify(...).length` counts UTF-16 code units and undercounts
// any multibyte character. Probed over a generated corpus: the code-unit
// version was wrong for 5,053 of 20,000 values and ALWAYS in the understating
// direction — a multibyte document would pass the writer, be persisted above
// the cap, and be corrupt on its very first read. That is precisely the
// invariant this preflight exists to establish: JSON.stringify({x:'é' +
// EMOJI}) is 11 UTF-16 units but 14 UTF-8 bytes.
export const serializeWithinBudget = (value: unknown, budget: number): string | undefined => {
  // Imperative on purpose, for `used`, `parts`, and `seen` alike: this is the
  // accumulate-then-abort shape the design note above requires — a
  // map/filter/reduce pipeline would build the whole string (or the whole
  // membership set) before any abort could happen, which is exactly the
  // unbounded-allocation-before-refusal this preflight exists to prevent.
  let used = 0;
  const parts: string[] = [];
  const overflow = Symbol('overflow');
  const unsupported = Symbol('unsupported');
  const seen = new Set<object>();
  // Emit a fragment and charge its bytes; abort as soon as the running total
  // passes the budget so a hostile document never materializes in full.
  const emit = (fragment: string): void => {
    used += Buffer.byteLength(fragment, 'utf8');
    if (used > budget) {
      throw overflow;
    }
    parts.push(fragment);
  };
  // The sizer is EXACT only for a JSON-safe, dense, plain-object tree, and the
  // exported writers accept Record<string, unknown>, which admits more than
  // that. Rather than reimplement JSON.stringify's replacement semantics, the
  // domain is ENFORCED: anything outside it is refused before sizing, so the
  // write-then-read invariant (what this build persists, this build can read
  // back) cannot be violated by a caller of the exported store. The
  // parse+dereference pipeline produces exactly this shape, so the
  // precondition costs it nothing.
  //
  // Specifically rejected: undefined and holes inside arrays (stringify emits
  // null, the walker would skip them), objects carrying a toJSON hook
  // (stringify serializes the replacement), functions/symbols/bigint, and
  // cycles (which would otherwise fail only after the preflight).
  //
  // JSON.stringify(undefined) produces NO string at all, so a top-level
  // undefined must be refused rather than reported as zero bytes by the final
  // no-op branch
  if (value === undefined) {
    throw validationError('refusing to cache a document that is not a JSON object');
  }
  const walk = (node: unknown): void => {
    if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
      throw unsupported;
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'number') {
      // Non-finite numbers serialize as null — JSON.stringify(node) ?? 'null'
      emit(JSON.stringify(node) ?? 'null');
      return;
    }
    if (typeof node === 'string') {
      emit(JSON.stringify(node));
      return;
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) {
        throw unsupported; // A cycle
      }
      // Arrays get the SAME enforcement as objects. Applying the
      // prototype/descriptor rules to the object branch only would leave an
      // own accessor at an index able to recreate the exact size-vs-bytes
      // bypass those rules exist to close: the element would be read for the
      // undefined check, again for the walk, and a third time by
      // JSON.stringify, so a getter could answer small twice and over-budget
      // once. An array-level toJSON hook has the same problem as on an object.
      if (Object.getPrototypeOf(node) !== Array.prototype) {
        throw unsupported; // A subclass is outside the domain
      }
      // Reject a toJSON via its own descriptor so a getter is never invoked (a
      // getter could mutate the document mid-serialization and desync the
      // bytes from metadata derived before this pass). A non-function toJSON
      // DATA property is a legitimate JSON key and must still serialize
      // normally.
      const arrayToJsonDescriptor = Object.getOwnPropertyDescriptor(node, 'toJSON');
      if (
        arrayToJsonDescriptor !== undefined &&
        (typeof arrayToJsonDescriptor.get === 'function' ||
          typeof arrayToJsonDescriptor.set === 'function' ||
          typeof arrayToJsonDescriptor.value === 'function')
      ) {
        throw unsupported;
      }
      // Imperative on purpose: `seen.add`/`seen.delete` (here and in the
      // object branch below) track cycle-detection membership shared across
      // the whole recursive walk — a value read afterward by every nested
      // `walk` call, not a local accumulation a map/filter could replace.
      seen.add(node);
      emit('[');
      // Imperative on purpose: the index is used to fetch
      // `Object.getOwnPropertyDescriptor(node, index)` rather than
      // `node[index]` specifically so an own accessor is never invoked (see
      // the descriptor comment below). A for-of over the array's values, or
      // `.entries()`, would read through `[[Get]]` and trigger exactly the
      // getter this loop exists to avoid calling.
      for (let index = 0; index < node.length; index += 1) {
        // Own DATA descriptor, captured value walked exactly once (a hole or
        // explicit undefined serializes as null, which the domain refuses).
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
          emit(',');
        }
        walk(descriptor.value);
      }
      emit(']');
      seen.delete(node);
      return;
    }
    if (typeof node === 'object') {
      if (seen.has(node)) {
        throw unsupported; // A cycle
      }
      // Reject a toJSON via its own descriptor so a getter is never invoked (a
      // getter could mutate the document mid-serialization and desync the
      // bytes from metadata derived before this pass). A non-function toJSON
      // DATA property is a legitimate JSON key and must still serialize
      // normally.
      const toJSONDescriptor = Object.getOwnPropertyDescriptor(node, 'toJSON');
      if (
        toJSONDescriptor !== undefined &&
        (typeof toJSONDescriptor.get === 'function' ||
          typeof toJSONDescriptor.set === 'function' ||
          typeof toJSONDescriptor.value === 'function')
      ) {
        throw unsupported;
      }
      const prototype = Object.getPrototypeOf(node) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw unsupported;
      }
      seen.add(node);
      emit('{');
      // Imperative on purpose: `first` tracks the first member actually
      // EMITTED, not the first key iterated — a skipped member (the
      // `continue` below, for an undefined/function/symbol value) must not
      // still cause the next real member to render a leading comma, so this
      // cannot be replaced by an index-based iteration.
      let first = true;
      // Object.keys is exactly the set JSON.stringify iterates, in the same
      // order; getOwnPropertyDescriptor captures each value once (an accessor is
      // refused on that same read, so it can never be measured then serialized).
      for (const key of Object.keys(node)) {
        const descriptor = Object.getOwnPropertyDescriptor(node, key);
        if (
          descriptor === undefined ||
          typeof descriptor.get === 'function' ||
          typeof descriptor.set === 'function'
        ) {
          throw unsupported;
        }
        const item = descriptor.value as unknown;
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          continue; // JSON.stringify omits the whole member, key included
        }
        if (!first) {
          emit(',');
        }
        first = false;
        emit(JSON.stringify(key));
        emit(':');
        walk(item);
      }
      emit('}');
      seen.delete(node);
      // The if-chain above is now exhausted, so control falls out of `walk`
      // normally: an explicit return here would be redundant (no-useless-return)
    }
  };
  try {
    walk(value);
  } catch (error) {
    if (error === overflow) {
      return undefined;
    }
    if (error === unsupported) {
      throw validationError(
        'refusing to cache a document containing values JSON cannot round-trip exactly (undefined or sparse array members, a toJSON hook, a bigint, a function, or a cycle)',
      );
    }
    throw error;
  }
  return parts.join('');
};

// Kept for existing callers/tests that only need the size.
export const serializedSizeWithin = (value: unknown, budget: number): number | undefined => {
  const text = serializeWithinBudget(value, budget);
  return text === undefined ? undefined : Buffer.byteLength(text, 'utf8');
};

// The `toJSON` member is checked via its own
// `Object.getOwnPropertyDescriptor`, in both the object and array branches of
// `walk` above, rather than a plain `node.toJSON` property read. A plain read
// invokes a `toJSON` GETTER — even a non-enumerable one Object.keys never
// visits — which could mutate the document mid-walk and desync the serialized
// bytes from metadata already derived from the (pre-mutation) document. The
// descriptor check rejects a `toJSON` accessor or function-valued data
// property WITHOUT ever calling it, and still lets a legitimate non-function
// `toJSON` data property (e.g. `{"toJSON":"x"}`) serialize normally, since
// JSON.stringify only treats a CALLABLE toJSON specially.

// Enforced BEFORE the lock is taken, on both writers, against the same constant
// the read path uses — so "anything this build persisted, this build can read
// back" holds by construction. Serialized ONCE here: the bytes returned are the
// bytes written and hashed, with no independent JSON.stringify to diverge from.
const persistableTextOrThrow = (
  document: Record<string, unknown>,
  slot: 'accepted' | 'candidate',
): string => {
  const text = serializeWithinBudget(document, CACHE_MAX_PERSISTED_BYTES);
  if (text === undefined) {
    throw validationError(
      `refusing to cache the ${slot} spec: its dereferenced form exceeds the ${CACHE_MAX_PERSISTED_BYTES}-byte persisted-document budget`,
    );
  }
  return text;
};

// Spec objects are immutable and content-addressed, so writing a generation
// only ever CREATES a file and can never disturb the bytes the live meta.json
// points at — unlike a fixed accepted/spec.json path that gets REPLACED on
// every write, which would leave old metadata pointing at new bytes both
// transiently and, after a crash, permanently. meta.json is replaced
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
    // An existing file at this name is NOT trusted merely because of its
    // name. Skipping the write whenever the path already exists would let a
    // damaged or attacker-planted file under a hash we are about to commit
    // become the authoritative object the moment the new metadata names it.
    // Verify the bytes; only genuinely identical content may be reused, and
    // anything else is a corrupt entry rather than something to silently
    // overwrite (overwriting would also be the one mutation this layout
    // exists to avoid, and a lock-free reader may be holding it).
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
  const referenced = new Set<string>(
    meta.candidate === undefined
      ? [`${meta.acceptedContentHash}.json`]
      : [`${meta.acceptedContentHash}.json`, `${meta.candidate.contentHash}.json`],
  );
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

// Three-way metadata read, shared by every store entry point. "miss" means
// there is no evidence a baseline ever existed here; everything else that is
// not a clean parse is "corrupt" and fails closed.
export type MetaReadResult =
  | { kind: 'miss' }
  | { kind: 'ok'; meta: CacheMeta }
  | { kind: 'corrupt'; reason: string };

// Private: it performs I/O and is not in the wrapped export list. Every
// consumer lives in this same module — the writers above, and the public
// reader below.
const readMetaFile = async (layout: CacheLayout, fs: CacheFs): Promise<MetaReadResult> => {
  if (!(await fs.pathExists(layout.dir))) {
    return { kind: 'miss' };
  }
  // Listing the objects directory here inside a bare `catch {}` would turn an
  // EACCES or EIO on that directory into "nothing cached" — a miss, the one
  // outcome that may become trust-on-first-use. The listing is not needed at
  // all: orphan-only namespaces are a miss by rule rather than by count, so
  // there is no swallowing catch to narrow.
  const hasMeta = await fs.pathExists(layout.metaPath);
  if (!hasMeta) {
    // Returning `corrupt` here whenever any object exists would permanently
    // wedge a namespace whose FIRST-EVER commit crashed between the object
    // write and the metadata replace: objects present, no metadata, and a
    // corrupt entry is never healed automatically. There would be no way out
    // but a manual `cache clear` on a first run.
    //
    // An orphan object is not a baseline. Nothing claims it: with content
    // addressing the bytes carry no authority unless some meta.json names
    // them, and no meta.json does. Unlike a damaged entry, this path is
    // deliberately NOT fail-closed — and that costs nothing: an attacker who
    // can delete meta.json can equally delete the whole directory, which
    // yields `miss` regardless, so treating orphan-only as `miss` grants no
    // capability that was not already there. What it does buy is that a crashed first
    // write self-heals on the next run instead of bricking the entry.
    //
    // The orphans are reclaimed by the next successful commit's GC.
    return { kind: 'miss' };
  }
  // Imperative on purpose: unlike the `.catch`-eligible reads below, both
  // catch branches here `return` a MetaReadResult — a type distinct from the
  // `string` this variable holds on success — so folding this into
  // `.catch(...)` would need a sentinel checked afterward, i.e. control-flow
  // restructuring this security module forbids.
  let raw: string;
  try {
    raw = await fs.readFileTextCapped(layout.metaPath, CACHE_META_MAX_BYTES);
  } catch (error) {
    // The pathExists probe above and this read are two separate calls: a
    // concurrent clear can unlink meta.json in between (TOCTOU). That is a
    // legitimate miss (the one outcome that may re-enter trust-on-first-use),
    // not corruption — the entry was raced away, not damaged.
    if (isCacheAbsence(error)) {
      return { kind: 'miss' };
    }
    // The read above throws a typed validationError ONLY for over-budget; a
    // raw Node error (EACCES/EIO) means the file could not be read at all.
    // Split the wording so the operator message matches the cause.
    const overBudget = error instanceof OpenapiMcpError && error.code === 'validation';
    return {
      kind: 'corrupt',
      reason: overBudget
        ? `cache metadata for entry ${layout.namespace} exceeds its ${CACHE_META_MAX_BYTES}-byte budget`
        : `cache metadata for entry ${layout.namespace} could not be read`,
    };
  }
  // Imperative on purpose: JSON.parse is synchronous, so there is no promise
  // to `.catch`, and a try-as-expression here would need an IIFE or a helper
  // extraction, neither of which this security module allows.
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
// "openapi" field. Used by BOTH the read path (verify rather than trust
// mutable metadata) and promotion, but it is defined HERE because
// writeAccepted below is its first caller. Reading one field is not
// revalidation, so a cache hit still skips revalidation as designed.
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

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  // Imperative on purpose: same reasoning as readMetaFile's JSON.parse above
  // — synchronous, so no `.catch` applies, and this security module allows
  // neither an IIFE nor a helper extraction to make it an expression.
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

// Shared by the lock-free public reader and every write path below: verifies
// that an accepted object's bytes actually correspond to what meta.json
// claims about them — the recorded content hash, JSON-object shape, and
// openapiVersion agreement (the discriminator is checked against the
// document's own "openapi" field rather than trusted from metadata, because
// the hash protects the OBJECT, not meta.json). Pure: it takes bytes already
// read and never touches the filesystem, so it has no opinion about retries —
// that is a property of the caller, not of this check.
type AcceptedObjectVerification =
  | { kind: 'ok'; document: Record<string, unknown> }
  | { kind: 'corrupt'; reason: string };

const verifyAcceptedObject = (
  layout: CacheLayout,
  meta: CacheMeta,
  acceptedText: string,
): AcceptedObjectVerification => {
  if (hashContent(acceptedText) !== meta.acceptedContentHash) {
    // Tampered bytes must never become (or remain) the baseline. No retry
    // here: the object is filed UNDER this hash, so content that does not
    // produce it is damage, not a lost race.
    return {
      kind: 'corrupt',
      reason: `the accepted spec for cache entry ${layout.namespace} does not match its recorded content hash`,
    };
  }
  const document = parseJsonObject(acceptedText);
  if (document === undefined) {
    return {
      kind: 'corrupt',
      reason: `the accepted spec for cache entry ${layout.namespace} is not a JSON object`,
    };
  }
  const declared = declaredOpenapiVersion(document);
  if (declared === undefined || declared !== meta.openapiVersion) {
    return {
      kind: 'corrupt',
      reason: `the accepted spec for cache entry ${layout.namespace} declares an OpenAPI version that does not match its metadata`,
    };
  }
  return { kind: 'ok', document };
};

// Without this check, every write path would decide whether an entry is
// corrupt purely from readMetaFile — i.e. from meta.json alone — so a write
// could build on top of, or silently replace, an accepted object whose BYTES
// had been damaged or tampered with. That is exactly the laundering the
// "restart is not approval" rule forbids: it only holds if a write cannot
// quietly paper over damage either. Concretely, without this, a damaged accepted
// object would not merely fail to be rejected: the next writeAccepted would
// install the changed document as the new accepted baseline, and the entry
// would then read back as a healthy hit.
//
// No retry loop here, unlike the lock-free public reader's use of
// verifyAcceptedObject: every caller of this function already holds the
// namespace lock, so no concurrent commit can move the generation or
// garbage-collect the object while this check runs, and a single, unretried
// read is exactly as authoritative as any other read taken under the lock.
const assertAcceptedObjectIntact = async (
  layout: CacheLayout,
  fs: CacheFs,
  meta: CacheMeta,
): Promise<void> => {
  // Kept as try/catch (not .catch()): CacheFs is an injected seam whose methods may throw synchronously despite their Promise return type; only the try block also catches that case.
  let acceptedText: string;
  try {
    acceptedText = await fs.readFileTextCapped(
      objectPath(layout, meta.acceptedContentHash),
      CACHE_MAX_PERSISTED_BYTES,
    );
  } catch (error) {
    // Only genuine absence is corruption. Anything else (EACCES, EIO)
    // rethrows unchanged, so withCacheErrors types it at the definition
    // boundary as validation exit 3 itself, rather than this call
    // mislabelling an I/O failure as a corrupt entry.
    if (!isCacheAbsence(error)) {
      throw error;
    }
    throw corruptEntryError(`the accepted spec for cache entry ${layout.namespace} cannot be read`);
  }
  const verified = verifyAcceptedObject(layout, meta, acceptedText);
  if (verified.kind === 'corrupt') {
    throw corruptEntryError(verified.reason);
  }
};

const writeAcceptedImpl = async (
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
  // The openapiVersion is DERIVED here, not supplied by the caller: accepting
  // it as an independent input would let a public writer persist an entry
  // whose recorded version disagrees with the reader's own verification
  // against the document, so its own next read would reject it. Deriving it
  // removes that state entirely: one function decides the discriminator, on
  // write and on read alike.
  const openapiVersion = declaredOpenapiVersion(input.document);
  if (openapiVersion === undefined) {
    throw validationError('refusing to cache a spec that declares no usable OpenAPI version');
  }
  // Bounded before the lock AND before serialization, so an over-budget
  // document blocks no namespace, never allocates the string it is being
  // refused for, and — checking the accepted document here, not only the
  // candidate — cannot be persisted into an entry the next read classifies
  // as corrupt
  const acceptedText = persistableTextOrThrow(input.document, 'accepted');
  // The store hashes the bytes it is about to persist. No caller supplies
  // this value, so meta.json cannot disagree with the file it describes.
  const acceptedContentHash = hashContent(acceptedText);
  return withNamespaceLock(layout, fs, input.fetchedAt, async () => {
    // A fresh fetch must not be able to silently "heal" a damaged baseline by
    // overwriting it — only an explicit "openapi-mcp cache clear" may. `miss`
    // (including the abandoned-scaffold case) is the trust-on-first-use path
    // and has no existing accepted object to verify; any `ok` result's
    // accepted object is checked before this proceeds.
    const existing = await readMetaFile(layout, fs);
    if (existing.kind === 'corrupt') {
      throw corruptEntryError(existing.reason);
    }
    if (existing.kind === 'ok') {
      await assertAcceptedObjectIntact(layout, fs, existing.meta);
    }
    // This deliberately drops any waiting candidate: a new accepted baseline
    // written here supersedes it. That is correct HERE — but it is why the
    // 304 path must NOT route through this function: doing so would silently
    // destroy a candidate awaiting promotion on every revalidation.
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
      // Persisted so a hit needs no revalidation, and DERIVED above so the
      // value can never contradict the bytes it describes
      openapiVersion,
    });
    return { acceptedContentHash };
  });
};

const writeCandidateImpl = async (
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
  // The same persisted-document budget the accepted writer and the reader
  // use, not the source-download budget — and checked before serialization
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
      // Never paper over a broken baseline by writing next to it
      throw corruptEntryError(existing.reason);
    }
    // Meta.json alone is not enough: verify the accepted OBJECT it names is
    // still intact before recording a candidate beside it
    await assertAcceptedObjectIntact(layout, fs, existing.meta);
    // The accepted half is copied through untouched: a candidate is stored,
    // never activated, so meta.title/specVersion keep describing what is
    // actually served. The validators recorded are the ones returned WITH the
    // candidate — they describe the most recently fetched representation,
    // which is this one. Carrying the accepted entry's stale validators
    // forward instead would leave the next conditional request asking about a
    // representation the cache no longer had.
    //
    // The OLD validators are stripped first, rather than spreading
    // `existing.meta` and conditionally adding the new ones: the latter would
    // leave a 200 response that carried NO ETag with the previous
    // representation's ETag still in place, so the next conditional request
    // would ask the server about a representation this cache no longer held.
    // Retaining an omitted validator is correct only for the 304 transition,
    // which is why that lives in its own function.
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

// The 304 transition. Routing a 304 through writeAccepted instead would rewrite
// the accepted entry and CLEAR the candidate, so revalidating would silently
// discard a candidate awaiting promotion without ever approving it. This
// updates the timestamp and the validators and touches nothing else: no
// object is written, and both slots survive verbatim.
const touchRevalidatedImpl = (
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
    // Meta.json alone is not enough: a 304 confirms the SOURCE is unchanged,
    // it says nothing about whether the locally persisted bytes are still
    // intact, so the object it names is verified before the touch proceeds
    await assertAcceptedObjectIntact(layout, fs, existing.meta);
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
// The public reader. The transactional write invariants are stated in terms
// of what a LOCK-FREE PUBLIC READER observes across a commit — so the reader
// is part of the store core, not of the promote/clear/list layer. Asserting
// those invariants against the fake filesystem's raw map instead would be a
// weaker substitute rather than a clean write/read separation.
// ---------------------------------------------------------------------------

export type CacheEntry = {
  meta: CacheMeta;
  acceptedDocument: Record<string, unknown>;
};

// Absent, usable, and corrupt are three distinct outcomes, and only "miss"
// may become an accepted baseline without operator action
export type CacheReadResult =
  | { kind: 'miss' }
  | { kind: 'hit'; entry: CacheEntry }
  | { kind: 'corrupt'; reason: string };

// Every reason string below is assembled from layout.namespace — a hex digest by
// construction — and fixed English. Nothing read out of the suspect file is
// interpolated, so a hostile cache entry cannot steer the operator's terminal.
//
// Immutable objects do NOT by themselves make immediate reclamation safe. A
// lock-free reader can load meta generation A, a writer can then commit
// generation B and garbage-collect A's object, and the reader — still holding
// A's hash — finds nothing and reports corruption on a cache that is
// perfectly healthy.
//
// The fix is a bounded re-read: if the object a generation names is missing,
// re-read meta.json. If it changed, the entry was committed underneath us and
// we simply retry against the new generation. If it did NOT change, the object
// is genuinely gone and the entry is corrupt. Retries are bounded because
// each one requires a concurrent commit to have completed, so an unbounded
// sequence would require unbounded concurrent writers.
//
// The lock-free reader retries a failed object read on two distinct grounds:
// a GENERATION ADVANCE (a concurrent commit replaced the object — self-limiting,
// each advance is a real commit, capped for a pathological sustained adversary),
// or a bounded number of STATIC-generation confirmations (fetchedAt is not
// guaranteed unique, so a same-content same-ms clear→reseed can look static
// while the object reappears). A static generation still missing after the
// confirmations is genuine deletion, and the read fails closed.
const READ_GENERATION_RETRY_CAP = 64;
const READ_STATIC_CONFIRM_LIMIT = 2;
const generationKey = (meta: CacheMeta): string =>
  `${meta.acceptedContentHash}:${String(meta.fetchedAt)}`;

const readCacheEntryImpl = async (layout: CacheLayout, fs: CacheFs): Promise<CacheReadResult> => {
  // Imperative on purpose: these three are a bounded retry state machine
  // across an unbounded `for (;;)` — each is reassigned from a different
  // branch on a different iteration, so there is no pure accumulation
  // (map/reduce) shape to fold them into without changing when the loop
  // retries versus gives up.
  let advanceRetries = 0;
  let staticConfirms = 0;
  let previousGenKey: string | undefined;
  for (;;) {
    const metaRead = await readMetaFile(layout, fs);
    if (metaRead.kind !== 'ok') {
      return metaRead;
    }
    const { meta } = metaRead;
    const genKey = generationKey(meta);
    // The advance branch below resets staticConfirms when ITS OWN recheck sees
    // a new generation, but a commit can just as easily land between one
    // iteration's static-confirm retry and the NEXT iteration's own
    // readMetaFile call — the loop then starts reading a new generation here,
    // silently, with no recheck ever noticing the change. Track the
    // generation this loop last read and reset the budget whenever the TOP of
    // the loop itself observes a change, so every generation gets its own
    // static-confirm budget no matter how the change was noticed.
    if (previousGenKey !== undefined && genKey !== previousGenKey) {
      // A generation advance observed at the TOP of the loop must consume the
      // generation-retry budget too, or a sustained clear/reseed+advance storm
      // that keeps resetting staticConfirms here (never reaching the advance
      // branch) would loop unboundedly — bypassing both caps. Every advance,
      // however observed, is bounded.
      if (advanceRetries >= READ_GENERATION_RETRY_CAP) {
        return {
          kind: 'corrupt',
          reason: `the accepted spec for cache entry ${layout.namespace} could not be read`,
        };
      }
      advanceRetries += 1;
      staticConfirms = 0;
    }
    previousGenKey = genKey;
    // Imperative on purpose: the catch below can `continue` the enclosing
    // `for (;;)` loop to retry against a new generation — a control-flow
    // move `.catch` cannot express and this security module forbids
    // restructuring around.
    let acceptedText: string;
    try {
      acceptedText = await fs.readFileTextCapped(
        objectPath(layout, meta.acceptedContentHash),
        CACHE_MAX_PERSISTED_BYTES,
      );
    } catch (error) {
      // An over-budget object is genuine corruption, not a lost race.
      if (error instanceof OpenapiMcpError && error.code === 'validation') {
        return {
          kind: 'corrupt',
          reason: `the accepted spec for cache entry ${layout.namespace} exceeds its ${CACHE_MAX_PERSISTED_BYTES}-byte budget`,
        };
      }
      // Only a genuine absence (ENOENT/ENOTDIR) is a candidate lost race — an
      // EACCES or EIO under a stable meta is a real I/O failure, not a
      // concurrent commit or deletion, and must propagate like every other
      // isCacheAbsence site in this module rather than being retried toward
      // an eventual, misleading "corrupt" report.
      if (!isCacheAbsence(error)) {
        throw error;
      }
      const recheck = await readMetaFile(layout, fs);
      if (recheck.kind === 'miss') {
        return { kind: 'miss' };
      }
      if (recheck.kind === 'corrupt') {
        return recheck;
      }
      if (generationKey(recheck.meta) !== genKey) {
        // A concurrent commit advanced the generation: retry against it, and
        // RESET the static-confirm budget — the new generation is entitled to
        // its own confirmations; leaking staticConfirms across an advance
        // would corrupt a healthy later generation prematurely.
        if (advanceRetries < READ_GENERATION_RETRY_CAP) {
          advanceRetries += 1;
          staticConfirms = 0;
          continue;
        }
        return {
          kind: 'corrupt',
          reason: `the accepted spec for cache entry ${layout.namespace} could not be read`,
        };
      }
      // Static generation: re-loop a bounded number of times — the next pass
      // re-reads meta (catching an advancing commit that GC'd the object) AND
      // the object (catching a same-key re-create race). Still missing after
      // the confirmations under a stable generation is genuine deletion.
      if (staticConfirms < READ_STATIC_CONFIRM_LIMIT) {
        staticConfirms += 1;
        continue;
      }
      return {
        kind: 'corrupt',
        reason: `the accepted spec for cache entry ${layout.namespace} could not be read`,
      };
    }
    // The hash, shape, and openapiVersion-agreement checks are shared with
    // every write path via verifyAcceptedObject (defined above, near
    // declaredOpenapiVersion): a lock-free reader has no opinion on retries
    // itself, so this call is pure and this loop is entirely responsible for
    // deciding when to retry.
    const verified = verifyAcceptedObject(layout, meta, acceptedText);
    if (verified.kind === 'corrupt') {
      return verified;
    }
    return { kind: 'hit', entry: { meta, acceptedDocument: verified.document } };
  }
};

// ---------------------------------------------------------------------------
// Promotion, clearing and listing. These three round out the store's public
// surface, built on top of readCacheEntry and the write paths defined above.
// ---------------------------------------------------------------------------

export type CacheEntrySummary = {
  id: string;
  displaySource: string;
  cacheKey?: string | undefined;
  title: string;
  specVersion: string;
  fetchedAt: number;
  acceptedContentHash: string;
  candidateContentHash?: string | undefined;
};

// Namespaces are 16-char sha256 prefixes; anything else in the root is not ours
const NAMESPACE_RE = /^[0-9a-f]{16}$/u;

// Derived from the promoted document, never inherited from the accepted entry:
// a candidate that legitimately moved 3.0 -> 3.1 would otherwise be normalized
// under the wrong rules.
const promotedOpenapiVersion = (
  document: Record<string, unknown>,
  namespace: string,
): OpenapiVersion => {
  const derived = declaredOpenapiVersion(document);
  if (derived !== undefined) {
    return derived;
  }
  // The candidate was validated before it was persisted, so an unusable
  // version here means the persisted bytes are inconsistent with what was
  // stored — promotion must not proceed
  throw conflictError(
    `the candidate spec for cache entry ${namespace} declares no usable OpenAPI version — refresh before promoting`,
  );
};

// Promotion moves the trust baseline, so it runs inside the namespace
// lock: the expectedHash comparison and the accepted switch happen without a
// concurrent refresh interleaving between them, which is what makes --hash a
// real compare-and-swap rather than an advisory check.
const promoteCandidateImpl = async (
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
  opts: { expectedHash?: string | undefined },
): Promise<{ promotedHash: string }> =>
  withNamespaceLock(layout, fs, nowMs, async () => {
    const metaRead = await readMetaFile(layout, fs);
    if (metaRead.kind === 'miss') {
      throw notFoundError(`no cache entry ${layout.namespace} exists — nothing to promote`);
    }
    if (metaRead.kind === 'corrupt') {
      // A damaged baseline is never repaired by writing over it
      throw corruptEntryError(metaRead.reason);
    }
    const { meta } = metaRead;
    // Meta.json alone is not enough: verify the CURRENT accepted object is
    // intact before promoting over it. Without this, a damaged accepted
    // object would not merely go unrejected — the promotion below would
    // install the candidate as the new baseline over undetected damage
    await assertAcceptedObjectIntact(layout, fs, meta);
    // One nested member, so "a candidate is waiting" is all-or-none and
    // this single check cannot be half-true
    const { candidate } = meta;
    if (candidate === undefined) {
      throw conflictError(
        `no candidate is waiting for promotion in cache entry ${layout.namespace}`,
      );
    }
    // Kept as try/catch (not .catch()): CacheFs is an injected seam whose methods may throw synchronously despite their Promise return type; only the try block also catches that case.
    let candidateText: string;
    try {
      candidateText = await fs.readFileTextCapped(
        objectPath(layout, candidate.contentHash),
        CACHE_MAX_PERSISTED_BYTES,
      );
    } catch (error) {
      // Only genuine absence means "the candidate is gone, refresh before
      // promoting". Catching EVERY failure here and returning conflict exit 5
      // would let an EACCES on the candidate object silently contradict the
      // frozen validation exit 3 for persistent-cache I/O — and, being
      // already typed as a conflictError, it would sail through the
      // definition-level wrapper unchanged.
      if (!isCacheAbsence(error)) {
        throw error;
      }
      throw conflictError(
        `the candidate spec for cache entry ${layout.namespace} cannot be read — refresh before promoting`,
      );
    }
    const promotedHash = hashContent(candidateText);
    if (promotedHash !== candidate.contentHash) {
      throw conflictError(
        `the candidate spec for cache entry ${layout.namespace} does not match its recorded hash — refresh before promoting`,
      );
    }
    if (opts.expectedHash !== undefined && opts.expectedHash !== promotedHash) {
      // --hash pins the promotion against a candidate replaced by a concurrent refresh
      throw conflictError(`--hash does not match the waiting candidate (${promotedHash})`);
    }
    const document = parseJsonObject(candidateText);
    if (document === undefined) {
      throw conflictError(
        `the candidate spec for cache entry ${layout.namespace} is not a JSON object — refresh before promoting`,
      );
    }
    // The candidate bytes are promoted verbatim: re-serializing the parsed
    // document could reorder keys and change the hash the operator pinned.
    // The provenance and display fields come from meta.candidate, which
    // recorded them at write time. There is no fallback to the accepted
    // entry's own source hash: the nested member is all-or-none.
    await commitEntry(layout, fs, [{ hash: promotedHash, text: candidateText }], {
      schemaVersion: CACHE_META_SCHEMA_VERSION,
      displaySource: meta.displaySource,
      ...(meta.cacheKey === undefined ? {} : { cacheKey: meta.cacheKey }),
      ...(meta.etag === undefined ? {} : { etag: meta.etag }),
      ...(meta.lastModified === undefined ? {} : { lastModified: meta.lastModified }),
      fetchedAt: meta.fetchedAt,
      acceptedContentHash: promotedHash,
      sourceContentHash: candidate.sourceContentHash,
      title: candidate.title,
      specVersion: candidate.specVersion,
      // Re-derived from the promoted bytes, not inherited from meta: the
      // candidate may legitimately have moved between 3.0 and 3.1
      openapiVersion: promotedOpenapiVersion(document, layout.namespace),
    });
    return { promotedHash };
  });

// Clear runs UNDER the namespace lock.
// A lock-free clear only ever protects against concurrent READERS. Against a
// concurrent WRITER it fails outright: clear removes the metadata, the writer
// commits new metadata naming its new object, clear then removes that object —
// and the durable end state is metadata-without-spec, a permanently corrupt
// entry produced by the one operation whose whole purpose was to leave a clean
// absence. Ordering cannot fix an interleaving with a writer. Removing .lock
// mid-flight would be worse still: it would re-admit a second writer to a
// namespace already being torn down.
//
// The meta-first unlink ORDER is kept as defence in depth for lock-free readers,
// but it is no longer what makes this safe — the lock is. The directory and the
// lock path stay in place until withNamespaceLock releases normally.
const clearNamespaceImpl = async (
  layout: CacheLayout,
  fs: CacheFs,
  nowMs: number,
): Promise<boolean> => {
  if (!(await fs.pathExists(layout.dir))) {
    return false;
  }
  return withNamespaceLock(layout, fs, nowMs, async () => {
    // Re-checked inside the lock: another clear may have won the race between
    // the probe above and the acquisition, and "removed something" has to
    // describe what THIS call actually removed
    const hadMeta = await fs.pathExists(layout.metaPath);
    // Kept as try/catch (not .catch()): CacheFs is an injected seam whose methods may throw synchronously despite their Promise return type; only the try block also catches that case.
    let objectNames: readonly string[] = [];
    try {
      objectNames = await fs.readDirNames(layout.objectsDir);
    } catch (error) {
      // Only a genuinely absent objects directory means "nothing to remove".
      // Swallowing every failure here and then deleting meta.json anyway
      // would manufacture the metadata-without-spec corruption this function
      // exists to avoid producing.
      if (!isCacheAbsence(error)) {
        throw cacheIoError(`list the objects of cache entry ${layout.namespace}`, error);
      }
    }
    // Meta.json first: it is the commit point, so removing it invalidates the
    // entry for any reader already in flight
    await fs.removeFile(layout.metaPath);
    // Then every object the entry owned. Content addressing means there is no
    // fixed path to guess — the directory listing is the authority.
    for (const name of objectNames) {
      await fs.removeFile(join(layout.objectsDir, name));
    }
    await fs.removeDir(layout.objectsDir);
    // The namespace directory and .lock deliberately survive until release:
    // deleting the lock we are holding would re-admit a second writer, and the
    // next write recreates the directory anyway. What is left — a directory
    // with neither meta.json nor any object — reads as a miss, which is
    // exactly the clean absence clear is supposed to produce.
    return hadMeta || objectNames.length > 0;
  });
};

// CacheEntrySummary is display-only (a later task renders it in `cache list`),
// and title/specVersion/displaySource are derived from spec documents this
// project treats as untrusted. The meta schema bounds them by LENGTH but not
// by character set, so a hand-planted or damaged meta.json could otherwise put
// an ANSI escape sequence or a bidi override onto the operator's terminal.
// Routed through sanitizeSpecText (the single-line variant: a summary is one
// table row, so a newline in a title must not break it) HERE ONLY — the `meta`
// object readCacheEntry returns carries hashes, validators and timestamps used
// for logic, and rewriting those would break hash comparison and conditional
// GET.
const summarize = async (
  root: string,
  name: string,
  fs: CacheFs,
): Promise<CacheEntrySummary | undefined> => {
  if (!NAMESPACE_RE.test(name)) {
    return undefined;
  }
  const metaRead = await readMetaFile(cacheLayout(root, name), fs);
  if (metaRead.kind !== 'ok') {
    // Listing skips what it cannot read; readCacheEntry reports the reason on
    // the path where the entry is actually trusted
    return undefined;
  }
  const { meta } = metaRead;
  return {
    id: name,
    displaySource: sanitizeSpecText(meta.displaySource, CACHE_DISPLAY_SOURCE_MAX),
    ...(meta.cacheKey === undefined ? {} : { cacheKey: meta.cacheKey }),
    title: sanitizeSpecText(meta.title, CACHE_TEXT_MAX),
    specVersion: sanitizeSpecText(meta.specVersion, CACHE_TEXT_MAX),
    fetchedAt: meta.fetchedAt,
    acceptedContentHash: meta.acceptedContentHash,
    // The summary keeps a flat hash: the nesting exists to enforce the
    // all-or-none invariant on disk, not to shape the listing output
    ...(meta.candidate === undefined ? {} : { candidateContentHash: meta.candidate.contentHash }),
  };
};

// Shared by listNamespaceIdsImpl and listCacheEntriesImpl below, so the two
// callers cannot carry two divergent copies of this exact try/catch (down to
// the same `cacheIoError('list the cache root', err)` message) — precisely
// the kind of divergence a single error boundary exists to prevent, even
// between two callers in the same module. Only genuine absence is an empty
// cache: catching every readDirNames failure here would print "no cache
// entries" for an unreadable root and make "cache clear --all" silently a
// no-op on a cache it simply could not see. Callers apply their own
// filtering/mapping — this is only the raw directory listing plus the
// absence-vs-I/O decision.
const namespaceRootNames = async (root: string, fs: CacheFs): Promise<readonly string[]> => {
  try {
    return await fs.readDirNames(root);
  } catch (error) {
    if (isCacheAbsence(error)) {
      return [];
    }
    throw cacheIoError('list the cache root', error);
  }
};

// Every namespace-shaped directory under the root, readable or not. This is
// what "cache clear --all" enumerates: listCacheEntries deliberately skips
// entries whose metadata it cannot parse, and those are exactly the entries an
// operator reaches for --all to remove.
const listNamespaceIdsImpl = async (root: string, fs: CacheFs): Promise<readonly string[]> => {
  const names = await namespaceRootNames(root, fs);
  return names.filter((name) => NAMESPACE_RE.test(name)).toSorted();
};

// Reads only meta.json so listing stays cheap; the accepted-spec hash is
// verified in readCacheEntry, on the path where the entry is actually used.
const listCacheEntriesImpl = async (
  root: string,
  fs: CacheFs,
): Promise<readonly CacheEntrySummary[]> => {
  const names = await namespaceRootNames(root, fs);
  // Promise.all rather than a sequential loop: the entries are independent, and
  // it keeps the scan clear of the no-await-in-loop rule
  const summaries = await Promise.all(names.map((name) => summarize(root, name, fs)));
  return summaries
    .filter((summary): summary is CacheEntrySummary => summary !== undefined)
    .toSorted((left, right) => right.fetchedAt - left.fetchedAt || left.id.localeCompare(right.id));
};

// ---------------------------------------------------------------------------
// The one error boundary, applied at the DEFINITION rather than at call
// sites, so coverage is structural rather than a checklist no caller can be
// trusted to complete. `asCacheError` passes a typed OpenapiMcpError through
// untouched, so a lock conflictError keeps exit 5 and a corrupt-entry
// validationError keeps its message. Because the boundary lives here, no call
// site anywhere else in the package wraps anything.
// ---------------------------------------------------------------------------

export const readCacheEntry = withCacheErrors('read a cache entry', readCacheEntryImpl);
export const writeAccepted = withCacheErrors('write the accepted spec', writeAcceptedImpl);
export const writeCandidate = withCacheErrors('write the candidate spec', writeCandidateImpl);
export const touchRevalidated = withCacheErrors('record a revalidation', touchRevalidatedImpl);
export const promoteCandidate = withCacheErrors('promote the candidate spec', promoteCandidateImpl);
export const clearNamespace = withCacheErrors('clear a cache entry', clearNamespaceImpl);
export const listCacheEntries = withCacheErrors('list cache entries', listCacheEntriesImpl);
export const listNamespaceIds = withCacheErrors('list cache namespaces', listNamespaceIdsImpl);
