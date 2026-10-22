import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Fixed artificial upstream latency, so call timings measure the server's own
// overhead on top of a known constant
export const UPSTREAM_LATENCY_MS = 20;

export type Upstream = {
  url: string;
  setResponse: (body: unknown) => void;
  connections: () => number;
  close: () => Promise<void>;
};

// A local mock upstream: answers every request with the current fixture's
// canned JSON body after UPSTREAM_LATENCY_MS, and counts accepted TCP
// connections (connection reuse, issue #51).
export const startUpstream = async (): Promise<Upstream> => {
  let body = '{}';
  let connections = 0;
  const server = createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
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
    setResponse: (value) => {
      body = JSON.stringify(value);
    },
    connections: () => connections,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
};
