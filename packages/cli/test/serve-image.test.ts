import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_TEST_TIMEOUT_MS, SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #14: an upstream image returned inline, saved as a file, or refused
// as today. The real CLI over stdio against a local upstream. An invented
// shop API whose items have a picture.

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/items/{case}/image': {
      get: {
        operationId: 'getItemImage',
        parameters: [{ name: 'case', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'the picture', content: { 'image/png': {} } } },
      },
    },
  },
};

// A PNG header for a 4x3 image: what the server reads to recognise it
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);

type Reply = {
  isError: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
};

describe('serve — image responses (issue #14)', () => {
  let home: string;
  let specPath: string;
  let api: Server;
  let baseUrl: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp-image-'));
    specPath = join(home, 'shop.json');
    writeFileSync(specPath, JSON.stringify(SPEC));
    api = createServer((req, res) => {
      const svg = (req.url ?? '').includes('/svg/');
      res.writeHead(200, { 'content-type': svg ? 'image/svg+xml' : 'image/png' });
      res.end(svg ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : PNG);
    });
    await new Promise<void>((resolve) => {
      api.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      api.closeAllConnections();
      api.close(() => resolve());
    });
    rmSync(home, { recursive: true, force: true });
  });

  const call = async (extraArgs: readonly string[], cases: readonly string[]): Promise<Reply[]> => {
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'serve',
        '--trust-spec-updates',
        '--spec',
        specPath,
        '--base-url',
        baseUrl,
        ...extraArgs,
      ],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    const replies = new Map<number, Reply>();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((entry) => entry !== '')) {
        const message = JSON.parse(line) as { id?: number; result?: Reply };
        if (message.id !== undefined && message.result !== undefined) {
          replies.set(message.id, message.result);
        }
      }
    });
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    try {
      for (const [index, name] of cases.entries()) {
        const params = { name: 'getItemImage', arguments: { case: name }, _meta: meta };
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params })}\n`,
        );
      }
      const started = Date.now();
      while (replies.size < cases.length && Date.now() - started < SUBPROCESS_WAIT_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      return cases.map(
        (_name, index) =>
          replies.get(index + 1) ?? {
            isError: true,
            content: [{ type: 'text', text: 'no reply' }],
          },
      );
    } finally {
      await stopChild(child);
    }
  };

  it(
    'refuses an image as before without --image-responses',
    async () => {
      const [reply] = await call([], ['png']);
      expect(reply?.isError).toBe(true);
      expect(reply?.content[0]?.text).toContain('used an unsupported media type "image/png"');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'returns the image inline, and refuses an SVG',
    async () => {
      const [png, svg] = await call(['--image-responses', 'inline'], ['png', 'svg']);
      expect(png).not.toHaveProperty('structuredContent');
      expect(png).toMatchObject({
        isError: false,
        content: [
          { type: 'text', text: `image image/png, 4x3, ${String(PNG.byteLength)} bytes` },
          { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
        ],
      });
      expect(svg?.isError).toBe(true);
      expect(svg?.content[0]?.text).toContain('is not a PNG, JPEG, GIF or WebP image');
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'saves the image under the home folder and returns its path',
    async () => {
      const [reply] = await call(['--image-responses', 'file'], ['png']);
      expect(reply?.isError).toBe(false);
      expect(reply?.content).toHaveLength(1);
      const text = reply?.content[0]?.text ?? '';
      const path = /saved to (?<path>.+)$/u.exec(text)?.groups?.['path'] ?? '';
      expect(path).toContain(join('.kaisers-io', 'openapi-mcp', 'images'));
      expect(readFileSync(path)).toStrictEqual(PNG);
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
