import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultUploadDir } from '../src/upload-options.ts';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_TEST_TIMEOUT_MS, SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// Issue #29: a binary field takes {"file": "<name>"}, and the server sends
// that file's bytes. The real CLI over stdio against a local upstream that
// records what it receives. An invented shop API.

const binary = { type: 'string', format: 'binary' };
const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/items/photo': {
      post: {
        operationId: 'uploadPhoto',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['photo'],
                properties: { photo: { type: 'string', contentMediaType: 'image/png' } },
              },
            },
          },
        },
        responses: { '204': { description: 'stored' } },
      },
    },
    '/items/image': {
      put: {
        operationId: 'putImage',
        requestBody: { required: true, content: { 'image/png': { schema: binary } } },
        responses: { '204': { description: 'stored' } },
      },
    },
  },
};

// A PNG header for a 4x3 image
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);

type Received = { url: string; type: string; body: Buffer };
type Reply = { isError: boolean; text: string };

describe('serve — uploads by file name (issue #29)', () => {
  let home: string;
  let specPath: string;
  let uploads: string;
  let api: Server;
  let baseUrl: string;
  const received: Received[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'openapi-mcp-upload-'));
    specPath = join(home, 'shop.json');
    writeFileSync(specPath, JSON.stringify(SPEC));
    // The default folder, so this runs on Windows too
    uploads = defaultUploadDir(home, specPath, home);
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
    writeFileSync(join(uploads, 'photo.png'), PNG);
    writeFileSync(join(uploads, 'notes.txt'), 'not an image');
    api = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          type: req.headers['content-type'] ?? '',
          body: Buffer.concat(chunks),
        });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      api.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      api.closeAllConnections();
      api.close(() => resolve());
    });
    rmSync(home, { recursive: true, force: true });
  });

  const call = async (
    extraArgs: readonly string[],
    calls: readonly { name: string; arguments: Record<string, unknown> }[],
  ): Promise<Reply[]> => {
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
        '--allow',
        'path:/**',
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
        const message = JSON.parse(line) as {
          id?: number;
          result?: { isError?: boolean; content?: { text?: string }[] };
        };
        if (message.id !== undefined) {
          replies.set(message.id, {
            isError: message.result?.isError === true,
            text: message.result?.content?.[0]?.text ?? '',
          });
        }
      }
    });
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    try {
      for (const [index, params] of calls.entries()) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { ...params, _meta: meta } })}\n`,
        );
      }
      const started = Date.now();
      while (replies.size < calls.length && Date.now() - started < SUBPROCESS_WAIT_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      return calls.map(
        (_call, index) => replies.get(index + 1) ?? { isError: true, text: 'no reply' },
      );
    } finally {
      await stopChild(child);
    }
  };

  it(
    'sends the named file as a multipart part and as a raw image body',
    async () => {
      const replies = await call(
        ['--upload-dir'],
        [
          { name: 'uploadPhoto', arguments: { photo: { file: 'photo.png' } } },
          { name: 'putImage', arguments: { body: { file: 'photo.png' } } },
        ],
      );
      expect(replies.map((reply) => reply.isError)).toStrictEqual([false, false]);
      // The two calls run concurrently
      const multipart = received.find((entry) => entry.url === '/items/photo');
      const raw = received.find((entry) => entry.url === '/items/image');
      expect(multipart?.type).toMatch(/^multipart\/form-data; boundary=/u);
      expect(multipart?.body.includes(PNG)).toBe(true);
      expect(raw).toMatchObject({ url: '/items/image', type: 'image/png' });
      expect(raw?.body).toStrictEqual(PNG);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a name outside the folder, and a file that is not the declared image, sending nothing',
    async () => {
      const replies = await call(
        ['--upload-dir'],
        [
          { name: 'putImage', arguments: { body: { file: 'notes.txt' } } },
          { name: 'putImage', arguments: { body: { file: 'missing.png' } } },
        ],
      );
      expect(replies[0]).toMatchObject({ isError: true });
      expect(replies[0]?.text).toContain('upload "notes.txt" is not the declared image/png');
      expect(replies[1]?.text).toContain('upload "missing.png" is not in the upload folder');
      expect(received).toHaveLength(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'takes no file name without --upload-dir',
    async () => {
      const [reply] = await call(
        [],
        [{ name: 'putImage', arguments: { body: { file: 'photo.png' } } }],
      );
      expect(reply?.isError).toBe(true);
      expect(received).toHaveLength(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
