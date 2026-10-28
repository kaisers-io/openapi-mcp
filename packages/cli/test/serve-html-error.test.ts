import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withServe } from './filter-harness.ts';

// Issue #63 end to end: the real CLI over MCP stdio against an upstream that
// answers each path with a fixed error page. An HTML page reaches the agent
// as its title and visible text; every other body keeps today's excerpt; a
// configured secret never reaches the agent, also not rebuilt from entities.

const SECRET = 'example-token-not-a-secret';
const entities = [...SECRET].map((char) => `&#${String(char.codePointAt(0))};`).join('');
const css = '.c{color:red}'.repeat(400);
const plainBody = `plain failure ${'x'.repeat(3000)}`;
const jsonBody = JSON.stringify({ message: 'Validation failed', field: 'name' });

const PAGES: Readonly<Record<string, { status: number; type: string; body: string }>> = {
  '/nginx': {
    status: 502,
    type: 'text/html',
    body: '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n',
  },
  '/styled': {
    status: 500,
    type: 'text/html; charset=utf-8',
    body: `<!DOCTYPE html><html><head><title>Server Error</title><style>${css}</style><script>var a = "<b>x</b>";</script></head><body><h1>500</h1><p>Order service &amp; database unavailable</p></body></html>`,
  },
  '/xhtml': {
    status: 503,
    type: 'application/xhtml+xml',
    body: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Maintenance until 10:00</p></body></html>',
  },
  '/echo': {
    status: 500,
    type: 'text/html',
    body: `<html><head><style>${css}</style></head><body><p>bad key ${SECRET}</p></body></html>`,
  },
  '/encoded': {
    status: 500,
    type: 'text/html',
    body: `<html><body><p>bad key ${entities}</p></body></html>`,
  },
  '/plain': { status: 500, type: 'text/plain', body: plainBody },
  '/json': { status: 422, type: 'application/json', body: jsonBody },
};

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Errors', version: '1' },
  paths: Object.fromEntries(
    Object.keys(PAGES).map((path) => [
      path,
      { get: { operationId: path.slice(1), responses: { '200': { description: 'ok' } } } },
    ]),
  ),
};

const PREFIX = (status: number) => `upstream request failed with status ${String(status)}: `;

describe('serve — the excerpt of an upstream error page (issue #63)', () => {
  let home: string;
  let specPath: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp html-errors '));
    specPath = join(home, 'spec.json');
    writeFileSync(specPath, JSON.stringify(SPEC));
    server = createServer((req, res) => {
      const page = PAGES[req.url ?? ''];
      req.resume();
      res.writeHead(page?.status ?? 404, { 'content-type': page?.type ?? 'text/plain' });
      res.end(page?.body ?? '');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    process.env['HTML_ERROR_TEST_KEY'] = SECRET;
  });

  afterAll(async () => {
    delete process.env['HTML_ERROR_TEST_KEY'];
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    rmSync(home, { recursive: true, force: true });
  });

  it('shows text instead of markup, keeps other bodies, and never shows the secret', async () => {
    const options = [
      '--spec',
      specPath,
      '--base-url',
      url,
      '--allow-private-network',
      '--allow-insecure-http',
      '--header-env',
      'X-Api-Key=HTML_ERROR_TEST_KEY',
    ];
    const replies = await withServe(options, home, async (session) => {
      const texts: Record<string, string> = {};
      for (const name of Object.keys(PAGES).map((path) => path.slice(1))) {
        const reply = await session.callTool(name, {});
        expect({ name, reply }).toMatchObject({ name, reply: { kind: 'result', isError: true } });
        texts[name] = reply.kind === 'result' ? reply.text : '';
      }
      return texts;
    });
    expect(replies).toStrictEqual({
      nginx: `${PREFIX(502)}502 Bad Gateway nginx`,
      styled: `${PREFIX(500)}Server Error: 500 Order service & database unavailable`,
      xhtml: `${PREFIX(503)}Maintenance until 10:00`,
      echo: `${PREFIX(500)}bad key [redacted]`,
      // Decoding the entities rebuilds the secret, so no excerpt at all
      encoded: 'upstream request failed with status 500',
      plain: expect.stringMatching(/^upstream request failed with status 500: plain failure x+/u),
      json: `${PREFIX(422)}${jsonBody}`,
    });
    expect(replies['plain']).toHaveLength(PREFIX(500).length + 1024);
    expect(JSON.stringify(replies)).not.toContain(SECRET);
  });
});
