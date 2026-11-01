import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { describe, expect, it } from 'vitest';
import { loadIssuerKeys } from '../src/server/http/oauth-discovery.ts';

// Cleartext is accepted for a loopback issuer only, so the metadata and the
// keys of an http://localhost issuer must come from a loopback DNS answer
describe('loadIssuerKeys — http://localhost issuer', () => {
  it.each([['10.0.0.5'], ['192.168.0.9']])(
    'refuses to discover when localhost resolves to %s',
    async (answer) => {
      let hits = 0;
      const server = createServer((_req, res) => {
        hits += 1;
        res.end('{}');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const { port } = server.address() as AddressInfo;
        const issuer = new URL(`http://localhost:${port}`);
        await expect(
          loadIssuerKeys(
            issuer,
            { issuer: issuer.href, allowPrivateNetwork: true, timeoutMs: 2000 },
            {
              transport: {
                fetch: undiciFetch,
                resolve: () => Promise.resolve([answer]),
                timeoutSignal: (ms) => AbortSignal.timeout(ms),
              },
              now: () => 0,
            },
          ),
        ).rejects.toMatchObject({
          message: expect.stringContaining(
            `resolves to the non-loopback address ${answer}`,
          ) as string,
        });
        expect(hits).toBe(0);
      } finally {
        server.close();
      }
    },
  );
});
