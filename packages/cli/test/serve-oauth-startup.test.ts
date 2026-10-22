import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

const CLIENT_ID = 'demo-client';
const CLIENT_SECRET = 'example-token-not-a-secret';

const specFor = (tokenUrl: string): string =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'OAuth API', version: '1.0.0' },
    components: {
      securitySchemes: {
        cc: { type: 'oauth2', flows: { clientCredentials: { tokenUrl, scopes: {} } } },
      },
    },
    paths: {
      '/pets': { get: { operationId: 'listPets', responses: { '200': { description: 'ok' } } } },
    },
  });

// OAuth2 token-URL startup refusals (#55). They end the run before any
// listener exists, so they run in-process; the subprocess E2E for the token
// flow itself is serve-oauth.test.ts.
describe('serve — OAuth2 token URL startup checks (in-process)', () => {
  const runServe = async (tokenUrl: string, extra: readonly string[]): Promise<string> => {
    const spec = specFor(tokenUrl);
    const errLines: string[] = [];
    const ctx = testContext({
      errLines,
      env: { CLIENT_ID, CLIENT_SECRET },
      readFileText: () => Promise.resolve(spec),
      fileSizeBytes: () => Promise.resolve(spec.length),
    });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'serve',
      '--spec',
      'oauth.json',
      '--base-url',
      'http://127.0.0.1:9',
      '--upstream-oauth-client-id-env',
      'CLIENT_ID',
      '--upstream-oauth-client-secret-env',
      'CLIENT_SECRET',
      ...extra,
    ]);
    expect(code).not.toBe(EXIT.OK);
    return errLines.join('\n');
  };

  it('refuses a private/loopback token URL without --allow-private-network', async () => {
    const text = await runServe('/oauth/token', []);
    expect(text).toContain('the OAuth token URL is refused');
    expect(text).toContain('--allow-private-network');
  });

  it('refuses a cloud-metadata token URL even with --allow-private-network', async () => {
    const text = await runServe('/t', [
      '--allow-private-network',
      '--upstream-oauth-token-url',
      'http://169.254.169.254/t',
    ]);
    expect(text).toContain('must use https');
    const https = await runServe('/t', [
      '--allow-private-network',
      '--upstream-oauth-token-url',
      'https://169.254.169.254/t',
    ]);
    expect(https).toContain('cloud-metadata');
  });

  it('refuses a cross-origin spec token URL unless --upstream-oauth-token-url confirms it', async () => {
    const text = await runServe('https://auth.example.com/oauth/token', []);
    expect(text).toContain('is not on the API origin');
    expect(text).toContain('--upstream-oauth-token-url');
  });

  it('refuses --upstream-oauth-* together with --header-env Authorization', async () => {
    const text = await runServe('/oauth/token', ['--header-env', 'Authorization=CLIENT_SECRET']);
    expect(text).toContain('cannot be combined with --header-env Authorization');
  });
});
