import { Buffer } from 'node:buffer';
import { constants, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { fetch as undiciFetch } from 'undici';
import type { PinnedDeps } from '../../src/index.ts';

// Test-only stand-ins for an OAuth authorization server: locally generated
// signing keys, a JWS signer, and a loopback HTTP server publishing RFC 8414
// metadata and a JWKS. Nothing here is a real credential.

export type TestAlg = 'RS256' | 'PS256' | 'ES256' | 'ES384' | 'EdDSA';

export type TestKey = {
  kid: string;
  alg: TestAlg;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
};

// Synchronous on purpose: fixtures are built at module scope and a test
// that needs a fresh key builds it inline; key generation is test setup,
// never on a serving path.
const generate = (alg: TestAlg, rsaBits: number) => {
  if (alg === 'RS256' || alg === 'PS256') {
    // oxlint-disable-next-line node/no-sync -- test fixture key generation (see above)
    return generateKeyPairSync('rsa', { modulusLength: rsaBits });
  }
  if (alg === 'EdDSA') {
    // oxlint-disable-next-line node/no-sync -- test fixture key generation (see above)
    return generateKeyPairSync('ed25519');
  }
  // oxlint-disable-next-line node/no-sync -- test fixture key generation (see above)
  return generateKeyPairSync('ec', { namedCurve: alg === 'ES256' ? 'P-256' : 'P-384' });
};

export const makeKey = (alg: TestAlg, kid: string, rsaBits = 2048): TestKey => {
  const { privateKey, publicKey } = generate(alg, rsaBits);
  return { kid, alg, privateKey, publicJwk: { ...publicKey.export({ format: 'jwk' }), kid } };
};

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const HASH: Record<TestAlg, string | undefined> = {
  RS256: 'sha256',
  PS256: 'sha256',
  ES256: 'sha256',
  ES384: 'sha384',
  EdDSA: undefined,
};

export const signWith = (key: TestKey, signingInput: string): string => {
  const data = Buffer.from(signingInput);
  if (key.alg === 'PS256') {
    return sign(HASH[key.alg], data, {
      key: key.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64url');
  }
  if (key.alg === 'ES256' || key.alg === 'ES384') {
    return sign(HASH[key.alg], data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString(
      'base64url',
    );
  }
  return sign(HASH[key.alg], data, key.privateKey).toString('base64url');
};

// Signs `payload` with `key`; `header` overrides/extends the default
// `{ alg, kid, typ: 'at+jwt' }` (an `undefined` value removes a member).
export const signJwt = (
  key: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string => {
  const fullHeader = Object.fromEntries(
    Object.entries({ alg: key.alg, kid: key.kid, typ: 'at+jwt', ...header }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const signingInput = `${b64(fullHeader)}.${b64(payload)}`;
  return `${signingInput}.${signWith(key, signingInput)}`;
};

// The algorithm-confusion forgery: an HS256 token whose HMAC secret is the
// verifier's PUBLIC key — accepted by any verifier that lets the token pick
// its own algorithm.
export const forgeHs256WithPublicKey = (key: TestKey, payload: Record<string, unknown>): string => {
  const signingInput = `${b64({ alg: 'HS256', kid: key.kid, typ: 'JWT' })}.${b64(payload)}`;
  const secret = JSON.stringify(key.publicJwk);
  return `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`;
};

export const unsignedJwt = (kid: string, payload: Record<string, unknown>): string =>
  `${b64({ alg: 'none', kid })}.${b64(payload)}.`;

export type TestIssuer = {
  // The issuer identifier (no trailing slash).
  issuer: string;
  port: number;
  setKeys: (keys: readonly TestKey[]) => void;
  // When set, JWKS requests answer this status instead of the key set.
  failJwks: (status?: number) => void;
  jwksFetches: () => number;
  metadataPaths: () => readonly string[];
  close: () => Promise<void>;
};

export type IssuerOptions = {
  // Issuer path component, e.g. '/tenant1'.
  path?: string;
  // Which well-known document the server publishes.
  style?: 'oauth' | 'oidc';
  // Overrides the `issuer` member of the published metadata.
  advertisedIssuer?: string;
  // Overrides the published jwks_uri.
  jwksUri?: string;
  omitJwksUri?: boolean;
};

export const startIssuer = async (
  keys: readonly TestKey[],
  options: IssuerOptions = {},
): Promise<TestIssuer> => {
  let currentKeys = keys;
  let jwksStatus: number | undefined;
  let jwksCount = 0;
  const seenMetadata: string[] = [];
  let issuer = '';
  const path = options.path ?? '';
  const metadataPath =
    options.style === 'oidc'
      ? `/.well-known/openid-configuration${path}`
      : `/.well-known/oauth-authorization-server${path}`;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/.well-known/')) {
      seenMetadata.push(url);
    }
    if (url === metadataPath) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: options.advertisedIssuer ?? issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(options.omitJwksUri === true
            ? {}
            : { jwks_uri: options.jwksUri ?? `${issuer}/jwks` }),
        }),
      );
      return;
    }
    if (url === `${path}/jwks`) {
      jwksCount += 1;
      if (jwksStatus !== undefined) {
        res.writeHead(jwksStatus).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/jwk-set+json' });
      res.end(JSON.stringify({ keys: currentKeys.map((key) => key.publicJwk) }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${String(port)}${path}`;
  const closeServer = promisify(server.close.bind(server));
  return {
    issuer,
    port,
    setKeys: (next) => {
      currentKeys = next;
    },
    failJwks: (status) => {
      jwksStatus = status;
    },
    jwksFetches: () => jwksCount,
    metadataPaths: () => seenMetadata,
    close: async () => {
      server.closeAllConnections();
      await closeServer();
    },
  };
};

// The real pinned transport with a resolver that never consults DNS: every
// test endpoint is an IP literal on loopback.
export const loopbackTransport: PinnedDeps = {
  fetch: undiciFetch,
  resolve: () => Promise.resolve(['127.0.0.1']),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};
