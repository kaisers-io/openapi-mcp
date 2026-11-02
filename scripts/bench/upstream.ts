import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Fixed artificial upstream latency, so call timings measure the server's own
// overhead on top of a known constant
export const UPSTREAM_LATENCY_MS = 20;

// Send the body in `chunks` pieces, `delayMs` apart: a slow producer
export type SlowBody = { chunks: number; delayMs: number };

export type Upstream = {
  url: string;
  setResponse: (body: unknown, slow?: SlowBody) => void;
  connections: () => number;
  close: () => Promise<void>;
};

// A local mock upstream: answers every request with the current fixture's
// canned JSON body after UPSTREAM_LATENCY_MS, and counts accepted TCP
// connections (connection reuse, issue kaisers-io/openapi-mcp-archive#51).
export const startUpstream = async (): Promise<Upstream> => {
  let body = Buffer.from('{}');
  let slowBody: SlowBody | undefined;
  let connections = 0;
  const server = createServer((req, res) => {
    req.resume();
    const sent = body;
    const slow = slowBody;
    setTimeout(() => {
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
    }, UPSTREAM_LATENCY_MS);
  });
  server.on('connection', () => {
    connections += 1;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    setResponse: (value, slow) => {
      body = Buffer.from(JSON.stringify(value));
      slowBody = slow;
    },
    connections: () => connections,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
};
