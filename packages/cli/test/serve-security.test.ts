import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// In-process: serve's startup warnings name an exposed operation whose
// `security` requirement no configured header satisfies. Same busy-port
// technique as serve-egress.test.ts — the warnings are emitted before the
// HTTP bind, and the bind's EADDRINUSE ends the run deterministically
// instead of blocking on a shutdown signal.
const SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Keyed', version: '1.0.0' },
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
  },
  security: [{ key: [] }],
  paths: {
    '/things': {
      get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
    },
  },
});

const HTTP_TOKEN = 'A'.repeat(43);

describe('serve — unsatisfied security requirement warnings (in-process)', () => {
  let blocker: Server | undefined;

  afterEach(async () => {
    const server = blocker;
    blocker = undefined;
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  });

  const runServe = async (extraArgs: readonly string[]): Promise<string> => {
    const server = createServer();
    blocker = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const errLines: string[] = [];
    const ctx = testContext({
      errLines,
      env: { HTTP_TOKEN, API_KEY: 'example-token-not-a-secret' },
      readFileText: () => Promise.resolve(SPEC),
      fileSizeBytes: () => Promise.resolve(SPEC.length),
    });
    const code = await run(ctx, [
      'node',
      'openapi-mcp',
      'serve',
      '--spec',
      'keyed.json',
      '--base-url',
      'http://127.0.0.1:9',
      ...extraArgs,
      '--http',
      '--port',
      String(port),
      '--http-token-env',
      'HTTP_TOKEN',
    ]);
    expect(code).toBe(EXIT.UNEXPECTED);
    return errLines.join('\n');
  };

  it('warns, naming the missing header flag, when nothing satisfies the requirement', async () => {
    const text = await runServe([]);
    expect(text).toContain(
      '1 exposed operation (e.g. GET /things) require credentials no configured header satisfies',
    );
    expect(text).toContain('pass --header-env X-API-Key=<ENV>');
  });

  it('stays quiet once the expected header is configured', async () => {
    const text = await runServe(['--header-env', 'X-API-Key=API_KEY']);
    expect(text).not.toContain('no configured header satisfies');
  });
});
