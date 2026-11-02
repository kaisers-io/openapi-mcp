import { once } from 'node:events';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Fixed artificial upstream latency, so call timings measure the server's own
// overhead on top of a known constant
export const UPSTREAM_LATENCY_MS = 20;

// Send the body in `chunks` pieces, `delayMs` apart: a slow producer
export type SlowBody = { chunks: number; delayMs: number };

// The OAuth2 client credentials of the oauth fixture: obviously fake
export const BENCH_CLIENT_ID = 'bench-client';
export const BENCH_CLIENT_SECRET = 'example-secret-not-a-secret';
export const TOKEN_PATH = '/oauth/token';

export type Upstream = {
  url: string;
  setResponse: (body: unknown, slow?: SlowBody) => void;
  connections: () => number;
  // Holds every API answer from now on, until release (issue #22)
  hold: () => void;
  release: () => void;
  waiting: () => number;
  // The token endpoint at TOKEN_PATH: it answers after `tokenDelayMs`, and
  // once tokens are required, an API request without a valid one gets 401
  oauth: {
    requireTokens: (on: boolean) => void;
    setTokenDelay: (ms: number) => void;
    revokeAll: () => void;
    tokenRequests: () => number;
  };
  close: () => Promise<void>;
};

// A local mock upstream: answers every request with the current fixture's
// canned JSON body after UPSTREAM_LATENCY_MS, and counts accepted TCP
// connections (connection reuse, issue kaisers-io/openapi-mcp-archive#51).
export const startUpstream = async (): Promise<Upstream> => {
  let body = Buffer.from('{}');
  let slowBody: SlowBody | undefined;
  let connections = 0;
  let held = false;
  const waiting: (() => void)[] = [];
  let tokensRequired = false;
  let tokenDelayMs = 0;
  let tokenRequests = 0;
  const valid = new Set<string>();

  const send = (res: ServerResponse, sent: Buffer, slow: SlowBody | undefined): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (slow === undefined) {
      res.end(sent);
      return;
    }
    const size = Math.ceil(sent.length / slow.chunks);
    const write = (offset: number): void => {
      if (offset + size >= sent.length) {
        res.end(sent.subarray(offset));
        return;
      }
      res.write(sent.subarray(offset, offset + size));
      setTimeout(() => {
        write(offset + size);
      }, slow.delayMs);
    };
    write(0);
  };

  const server = createServer((req, res) => {
    req.resume();
    // Any request gets a token: this endpoint only times the lifecycle. The
    // client credentials and grant_type are checked by the e2e mock in
    // packages/cli/test/serve-oauth.test.ts.
    if (req.method === 'POST' && req.url === TOKEN_PATH) {
      tokenRequests += 1;
      const token = `bench-token-${String(tokenRequests)}-not-a-secret`;
      valid.add(token);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
      }, tokenDelayMs);
      return;
    }
    // Decided on arrival, answered once released
    const authorized =
      !tokensRequired || valid.has((req.headers.authorization ?? '').replace(/^Bearer /u, ''));
    const sent = body;
    const slow = slowBody;
    const answer = (): void => {
      setTimeout(() => {
        if (!authorized) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('invalid token');
          return;
        }
        send(res, sent, slow);
      }, UPSTREAM_LATENCY_MS);
    };
    if (held) {
      waiting.push(answer);
      return;
    }
    answer();
  });
  server.on('connection', () => {
    connections += 1;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const release = (): void => {
    held = false;
    for (const answer of waiting.splice(0)) {
      answer();
    }
  };
  return {
    url: `http://127.0.0.1:${String(port)}`,
    setResponse: (value, slow) => {
      body = Buffer.from(JSON.stringify(value));
      slowBody = slow;
    },
    connections: () => connections,
    hold: () => {
      held = true;
    },
    release,
    waiting: () => waiting.length,
    oauth: {
      requireTokens: (on) => {
        tokensRequired = on;
      },
      setTokenDelay: (ms) => {
        tokenDelayMs = ms;
      },
      revokeAll: () => {
        valid.clear();
      },
      tokenRequests: () => tokenRequests,
    },
    close: async () => {
      release();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
};
