import { Buffer } from 'node:buffer';
import { constants, createPublicKey, verify } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

// JSON Web Keys (RFC 7517) for JWT access-token validation (jwt.ts): the
// algorithm allowlist, key/algorithm consistency, key import and the
// signature check itself, plus parsing of the issuer's JWKS document.

export const ALLOWED_JWS_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
export type JwsAlg = (typeof ALLOWED_JWS_ALGS)[number];

// RSA keys below 2048 bits are rejected (RFC 7518 §3.3 requires >= 2048).
const MIN_RSA_BITS = 2048;

// The key set as handed in by the JWKS cache: keys indexed by `kid`. Keys
// without a `kid` are dropped by parseJwks, matching the requirement below
// that every token names its key.
export type KeySet = ReadonlyMap<string, JsonWebKey>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isAllowedAlg = (value: unknown): value is JwsAlg =>
  typeof value === 'string' && (ALLOWED_JWS_ALGS as readonly string[]).includes(value);

// The curve each ECDSA algorithm is defined over (RFC 7518 §3.4).
const EC_CURVE: Partial<Record<JwsAlg, string>> = {
  ES256: 'P-256',
  ES384: 'P-384',
  ES512: 'P-521',
};

const keyMatchesAlg = (jwk: JsonWebKey, alg: JwsAlg): boolean => {
  const { alg: keyAlg, use, key_ops: keyOps, kty, crv } = jwk;
  if (keyAlg !== undefined && keyAlg !== alg) {
    return false;
  }
  if (use !== undefined && use !== 'sig') {
    return false;
  }
  if (keyOps !== undefined && !(Array.isArray(keyOps) && keyOps.includes('verify'))) {
    return false;
  }
  if (alg.startsWith('RS') || alg.startsWith('PS')) {
    return kty === 'RSA';
  }
  if (alg === 'EdDSA') {
    return kty === 'OKP' && crv === 'Ed25519';
  }
  return kty === 'EC' && crv === EC_CURVE[alg];
};

// Only the public members are handed to createPublicKey: a JWKS that
// (wrongly) publishes a private key must still yield a public KeyObject.
const PUBLIC_JWK_MEMBERS = new Set(['kty', 'crv', 'n', 'e', 'x', 'y']);
const publicJwk = (jwk: JsonWebKey): JsonWebKey =>
  Object.fromEntries(
    Object.entries(jwk).filter(
      ([member, value]) => PUBLIC_JWK_MEMBERS.has(member) && value !== undefined,
    ),
  );

const importKey = (jwk: JsonWebKey): KeyObject | undefined => {
  try {
    const key = createPublicKey({ key: publicJwk(jwk), format: 'jwk' });
    if (
      key.asymmetricKeyType === 'rsa' &&
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS
    ) {
      return undefined;
    }
    return key;
  } catch {
    return undefined;
  }
};

const HASH_FOR_ALG: Record<JwsAlg, string | undefined> = {
  RS256: 'sha256',
  RS384: 'sha384',
  RS512: 'sha512',
  PS256: 'sha256',
  PS384: 'sha384',
  PS512: 'sha512',
  ES256: 'sha256',
  ES384: 'sha384',
  ES512: 'sha512',
  // Ed25519 hashes internally; node:crypto requires `undefined` here.
  EdDSA: undefined,
};

const verifySignature = (
  alg: JwsAlg,
  key: KeyObject,
  signingInput: string,
  signature: Buffer,
): boolean => {
  const data = Buffer.from(signingInput, 'ascii');
  try {
    if (alg.startsWith('PS')) {
      // RFC 7518 §3.5: the PSS salt length equals the hash output length.
      return verify(
        HASH_FOR_ALG[alg],
        data,
        {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signature,
      );
    }
    if (alg.startsWith('ES')) {
      // JWS carries ECDSA signatures as the raw R||S concatenation (RFC 7518
      // §3.4), not DER — ieee-p1363 is that encoding.
      return verify(HASH_FOR_ALG[alg], data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return verify(HASH_FOR_ALG[alg], data, key, signature);
  } catch {
    return false;
  }
};

// Verifies a JWS signature with the key the token named: the key must fit
// the algorithm before it is even imported.
export const verifyWithJwk = (
  alg: JwsAlg,
  jwk: JsonWebKey,
  signingInput: string,
  signature: Buffer,
): 'ok' | 'key-mismatch' | 'bad-signature' => {
  const key = keyMatchesAlg(jwk, alg) ? importKey(jwk) : undefined;
  if (key === undefined) {
    return 'key-mismatch';
  }
  return verifySignature(alg, key, signingInput, signature) ? 'ok' : 'bad-signature';
};

// Upper bound on keys taken from one JWKS document: real authorization
// servers publish a handful (current + next + previous); a document with
// hundreds is hostile or broken, and every key is parsed per refresh.
export const MAX_JWKS_KEYS = 32;

// Parses a JWKS document (RFC 7517 §5) into a kid-indexed key set. Keys
// without a `kid`, with a duplicate `kid`, or of an unsupported type are
// skipped rather than failing the whole set — one unusable key must not
// lock out tokens signed by the others. Returns undefined for a document
// that is not a JWKS at all.
export const parseJwks = (document: unknown): KeySet | undefined => {
  if (!isRecord(document) || !Array.isArray(document['keys'])) {
    return undefined;
  }
  const keys = new Map<string, JsonWebKey>();
  const duplicates = new Set<string>();
  for (const candidate of document['keys'].slice(0, MAX_JWKS_KEYS)) {
    if (!isRecord(candidate) || typeof candidate['kid'] !== 'string' || candidate['kid'] === '') {
      continue;
    }
    const { kid } = candidate;
    if (keys.has(kid)) {
      duplicates.add(kid);
    }
    keys.set(kid, candidate as JsonWebKey);
  }
  // An ambiguous kid is dropped entirely: picking either key would let the
  // JWKS's ordering decide which signature is accepted.
  for (const kid of duplicates) {
    keys.delete(kid);
  }
  return keys;
};
