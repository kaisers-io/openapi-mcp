// The literal multi-needle matcher behind redact.ts's createRedactor. Kept in
// its own module so redact.ts stays about WHICH strings are secret, and this
// one about FINDING them fast.

// A half-open [start, end) range of a matched needle in the scanned value.
export type Span = readonly [number, number];

// Why not only one `includes`/`split` per needle, as redact.ts did before:
// its derived needles (auth-scheme credentials, decoded Basic parts, more
// encodings) multiply the needle count (worst case ~27 per registered
// secret × MAX_SECRETS), and a per-needle scan is O(needles × body) —
// measured ~17x slower on a 10 MB body at the cap, and just as bad per
// string when scanning a parsed JSON tree of many short strings. Above
// NATIVE_SCAN_MAX_NEEDLES, every needle of PREFIX_LENGTH+ chars is instead
// keyed by a hash of its first PREFIX_LENGTH chars; the scan rolls that hash
// across the value once (O(body), independent of the needle count), and
// only a hash hit — pre-filtered by a 64 Ki-slot bitmap so the Map is rarely
// consulted — is verified with an exact `startsWith` (Rabin–Karp). Matching
// stays literal: hashes only nominate candidates, they never decide a
// match, and nothing is built from a secret except Map keys (no RegExp, no
// ReDoS surface). At or below the threshold — the common one-to-eight-
// credential configuration — the native per-needle indexOf scan (V8's
// Boyer–Moore–Horspool search) beats the rolling hash's fixed
// per-character cost, so it is kept; on a 10 MB body the crossover measured
// at ~90 needles. Needles shorter than PREFIX_LENGTH (in practice only raw
// short secrets, which get no encoding variants) always take indexOf.
const NATIVE_SCAN_MAX_NEEDLES = 64;
// Equal to redact.ts's MIN_VARIANT_LENGTH, so every encoding variant and
// derived needle is long enough to be hashed.
const PREFIX_LENGTH = 8;
// Each character is shifted 4 bits further left per step, so it falls out
// of the 32-bit hash exactly PREFIX_LENGTH (8) characters later: the hash is
// always that of the last PREFIX_LENGTH characters, with no explicit
// "remove the outgoing character" step (measured ~2x cheaper on the scan
// loop than a multiplicative rolling hash).
const HASH_SHIFT = 32 / PREFIX_LENGTH;
const FILTER_SIZE = 1 << 16;

// Imperative on purpose: these run once per character of an unbounded
// untrusted value — 32-bit integer arithmetic in a plain loop is the whole
// point of the matcher, so no per-character allocation (slice/array).
// UTF-16 code units (charCodeAt, not codePointAt) on purpose: the scan
// steps one code unit at a time exactly like indexOf/startsWith, and a
// code-point read at a lead surrogate would mix the NEXT unit into the hash,
// so a needle ending in a lead surrogate could hash differently from the
// same text inside the value and be missed.
const rollHash = (hash: number, code: number): number => (hash << HASH_SHIFT) ^ code;
const filterSlot = (hash: number): number => (hash ^ (hash >>> 16)) & (FILTER_SIZE - 1);
const hashPrefix = (needle: string): number => {
  let hash = 0;
  for (let index = 0; index < PREFIX_LENGTH; index += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- code-unit hashing must step like indexOf; see the comment above
    hash = rollHash(hash, needle.charCodeAt(index));
  }
  return hash;
};

// Returns a finder over `ordered`, which must be longest-first: each bucket
// then is too, so the first needle that matches at a position is the
// longest one starting there. The finder returns every needle occurrence
// (overlapping ones included) as a span or — with `firstOnly` — just the
// first one found, for a boolean scan.
export const createMatcher = (
  ordered: readonly string[],
): ((value: string, firstOnly: boolean) => Span[]) => {
  const useHash = ordered.length > NATIVE_SCAN_MAX_NEEDLES;
  const isHashed = (needle: string): boolean => useHash && needle.length >= PREFIX_LENGTH;
  const scannedNeedles = ordered.filter((needle) => !isHashed(needle));
  const buckets = new Map<number, string[]>();
  const filter = new Uint8Array(FILTER_SIZE);
  for (const needle of ordered.filter((candidate) => isHashed(candidate))) {
    const hash = hashPrefix(needle);
    filter[filterSlot(hash)] = 1;
    buckets.set(hash, [...(buckets.get(hash) ?? []), needle]);
  }
  return (value, firstOnly) => {
    const spans: Span[] = [];
    for (const needle of scannedNeedles) {
      for (let at = value.indexOf(needle); at !== -1; at = value.indexOf(needle, at + 1)) {
        spans.push([at, at + needle.length]);
        if (firstOnly) {
          return spans;
        }
      }
    }
    if (buckets.size === 0) {
      return spans;
    }
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      // oxlint-disable-next-line unicorn/prefer-code-point -- code-unit hashing must step like indexOf; see the comment above rollHash
      hash = rollHash(hash, value.charCodeAt(index));
      if (index >= PREFIX_LENGTH - 1 && filter[filterSlot(hash)] === 1) {
        const start = index - PREFIX_LENGTH + 1;
        const hit = buckets.get(hash)?.find((needle) => value.startsWith(needle, start));
        if (hit !== undefined) {
          spans.push([start, start + hit.length]);
          if (firstOnly) {
            return spans;
          }
        }
      }
    }
    return spans;
  };
};

// Replaces every maximal run of OVERLAPPING spans with one `marker`.
// Overlaps are merged so no fragment of either needle survives between two
// markers (the old sequential split/join could leave the tail of a shorter
// needle that overlapped a longer one); merely ADJACENT occurrences keep
// one marker each, as before. `spans` must be non-empty.
export const replaceSpans = (value: string, spans: readonly Span[], marker: string): string => {
  const sorted = spans.toSorted((first, second) => first[0] - second[0]);
  const pieces: string[] = [];
  let cursor = 0;
  let runEnd = -1;
  for (const [start, end] of sorted) {
    if (start < runEnd) {
      runEnd = Math.max(runEnd, end);
      continue;
    }
    if (runEnd !== -1) {
      pieces.push(marker);
      cursor = runEnd;
    }
    pieces.push(value.slice(cursor, start));
    runEnd = end;
  }
  pieces.push(marker, value.slice(runEnd));
  return pieces.join('');
};
