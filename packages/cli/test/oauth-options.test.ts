import { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { createRedactor, OpenapiMcpError } from '@kaisers-io/openapi-mcp-core';
import type { SecurityScheme } from '@kaisers-io/openapi-mcp-core';
import { registerApiOptions, resolveApiConfig } from '../src/api-options.ts';
import { testContext } from '../src/context.ts';
import { resolveTokenUrl } from '../src/oauth-options.ts';
import type { ResolvedOAuthConfig } from '../src/oauth-options.ts';

// --oauth-* option parsing and token-URL selection (in-process; the
// subprocess E2E lives in serve-oauth.test.ts).

const ENV = { CID: 'demo-client', CSECRET: 'example-token-not-a-secret' };
const BASE_FLAGS = ['--oauth-client-id-env', 'CID', '--oauth-client-secret-env', 'CSECRET'];

const resolve = (args: readonly string[], env: Record<string, string | undefined> = ENV) => {
  const command = registerApiOptions(new Command()).exitOverride();
  command.parse([...args], { from: 'user' });
  return resolveApiConfig(command.opts(), testContext({ env }));
};

const usageMessage = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OpenapiMcpError);
    expect((error as OpenapiMcpError).code).toBe('usage');
    return (error as OpenapiMcpError).message;
  }
  return expect.unreachable('expected a usage error');
};

describe('--oauth-* option resolution', () => {
  it('is absent without any --oauth-* flag', () => {
    expect(resolve([]).oauth).toBeUndefined();
  });

  it('reads id and secret from env, defaults to client_secret_basic, dedupes scopes', () => {
    const config = resolve([...BASE_FLAGS, '--oauth-scope', 'read', '--oauth-scope', 'read']);
    expect(config.oauth).toMatchObject({
      clientId: 'demo-client',
      clientSecret: 'example-token-not-a-secret',
      clientAuth: 'client_secret_basic',
      scopes: ['read'],
      envVarHint: 'CID / CSECRET',
    });
  });

  it('registers the secret and the exact Basic credential with the redactor', () => {
    const config = resolve(BASE_FLAGS);
    const redactor = createRedactor(config.secretValues);
    const basic = `Basic ${Buffer.from('demo-client:example-token-not-a-secret').toString('base64')}`;
    expect(redactor.redactString(`${basic} example-token-not-a-secret`)).toBe(
      '[redacted] [redacted]',
    );
    // The client id is an identifier, not a secret (RFC 6749 §2.2).
    expect(redactor.redactString('demo-client')).toBe('demo-client');
  });

  it('requires BOTH env flags whenever any --oauth-* flag is used', () => {
    expect(usageMessage(() => resolve(['--oauth-client-id-env', 'CID']))).toContain(
      'requires both --oauth-client-id-env and --oauth-client-secret-env',
    );
    expect(usageMessage(() => resolve(['--oauth-scope', 'read']))).toContain('requires both');
  });

  it('is a usage error together with --header-env Authorization', () => {
    expect(
      usageMessage(() => resolve([...BASE_FLAGS, '--header-env', 'Authorization=CSECRET'])),
    ).toContain('cannot be combined with --header-env Authorization');
  });

  it('rejects a missing env value without echoing anything secret', () => {
    const message = usageMessage(() => resolve(BASE_FLAGS, { CID: 'demo-client' }));
    expect(message).toContain('"CSECRET" (for --oauth-client-secret-env) is not set or empty');
  });

  it('rejects control characters, bad env names, bad scopes and an unknown auth method', () => {
    expect(usageMessage(() => resolve(BASE_FLAGS, { ...ENV, CSECRET: 'a\r\nb' }))).toContain(
      'contains control characters',
    );
    expect(
      usageMessage(() =>
        resolve(['--oauth-client-id-env', '1BAD', '--oauth-client-secret-env', 'CSECRET']),
      ),
    ).toContain('invalid env var name');
    expect(usageMessage(() => resolve([...BASE_FLAGS, '--oauth-scope', 'a b']))).toContain(
      'invalid --oauth-scope',
    );
    expect(
      usageMessage(() => resolve([...BASE_FLAGS, '--oauth-client-auth', 'private_key_jwt'])),
    ).toContain('--oauth-client-auth must be one of');
  });

  it('validates --oauth-token-url: https (or loopback http), no userinfo, no fragment', () => {
    expect(
      resolve([...BASE_FLAGS, '--oauth-token-url', 'https://auth.example/t?x=1']).oauth
        ?.tokenUrlOverride?.href,
    ).toBe('https://auth.example/t?x=1');
    expect(
      resolve([...BASE_FLAGS, '--oauth-token-url', 'http://127.0.0.1:8080/t']).oauth,
    ).toBeDefined();
    for (const [url, part] of [
      ['http://auth.example/t', 'must use https'],
      ['https://u:p@auth.example/t', 'credentials'],
      ['https://auth.example/t#f', 'fragment'],
      ['not a url', 'must be an absolute https URL'],
    ] as const) {
      expect(usageMessage(() => resolve([...BASE_FLAGS, '--oauth-token-url', url]))).toContain(
        part,
      );
    }
  });
});

describe('resolveTokenUrl', () => {
  const oauth = (extra: Partial<ResolvedOAuthConfig> = {}): ResolvedOAuthConfig => ({
    ...(resolve(BASE_FLAGS).oauth as ResolvedOAuthConfig),
    ...extra,
  });
  const cc = (name: string, tokenUrl: string): SecurityScheme => ({
    name,
    type: 'oauth2',
    flows: ['clientCredentials'],
    clientCredentials: { tokenUrl, scopes: [] },
  });
  const base = new URL('https://api.example.com/v1');

  it('resolves a relative spec tokenUrl against the API base', () => {
    expect(
      resolveTokenUrl(oauth(), { securitySchemes: [cc('a', '/oauth/token')] }, base).href,
    ).toBe('https://api.example.com/oauth/token');
  });

  it('refuses a cross-origin spec tokenUrl, but accepts the operator override', () => {
    const spec = { securitySchemes: [cc('a', 'https://auth.example.com/token')] };
    expect(usageMessage(() => resolveTokenUrl(oauth(), spec, base))).toContain(
      'is not on the API origin',
    );
    const override = new URL('https://auth.example.com/token');
    expect(resolveTokenUrl(oauth({ tokenUrlOverride: override }), spec, base)).toBe(override);
  });

  it('needs --oauth-scheme when several schemes qualify, and checks the name', () => {
    const spec = { securitySchemes: [cc('a', '/t1'), cc('b', '/t2')] };
    expect(usageMessage(() => resolveTokenUrl(oauth(), spec, base))).toContain(
      'pass --oauth-scheme',
    );
    expect(resolveTokenUrl(oauth({ scheme: 'b' }), spec, base).pathname).toBe('/t2');
    expect(usageMessage(() => resolveTokenUrl(oauth({ scheme: 'c' }), spec, base))).toContain(
      'available: "a", "b"',
    );
  });

  it('needs --oauth-token-url when the spec declares no client-credentials flow', () => {
    expect(usageMessage(() => resolveTokenUrl(oauth(), {}, base))).toContain(
      'pass --oauth-token-url',
    );
    const override = new URL('https://auth.example.com/token');
    expect(resolveTokenUrl(oauth({ tokenUrlOverride: override }), {}, base)).toBe(override);
  });

  it('rejects an insecure spec tokenUrl on a non-loopback origin', () => {
    const httpBase = new URL('http://api.example.com/');
    expect(
      usageMessage(() => resolveTokenUrl(oauth(), { securitySchemes: [cc('a', '/t')] }, httpBase)),
    ).toContain('must use https');
  });
});
