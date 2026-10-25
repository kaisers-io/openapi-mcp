import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createExecutor,
  createRedactor,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { NamedOperation } from '../src/index.ts';
import { openManagedFolder } from '../src/files/folder.ts';
import { resolveUploads } from '../src/server/execute/uploads.ts';
import { pngOf } from './helpers/images.ts';

// --uploads (#29): binary fields take a file name; the server reads it

const binary = { type: 'string', format: 'binary' };
const op = (toolName: string, path: string, content: Record<string, unknown>): NamedOperation => ({
  toolName,
  operation: {
    method: 'post',
    path,
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: { required: true, content },
    responses: { '204': { description: 'stored' } },
  },
});

const OPERATIONS = [
  op('uploadPhoto', '/items/photo', {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['photo'],
        properties: {
          photo: { type: 'string', contentMediaType: 'image/png' },
          caption: { type: 'string' },
        },
      },
    },
  }),
  op('uploadFile', '/items/file', { 'application/octet-stream': { schema: binary } }),
  op('putImage', '/items/image', { 'image/png': { schema: binary } }),
  op('createItem', '/items', {
    'application/json': {
      schema: { type: 'object', properties: { file: { type: 'string' } } },
    },
  }),
];

const toolsWith = (uploadDir?: string) =>
  buildTools(OPERATIONS, {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
    ...(uploadDir === undefined ? {} : { uploadDir }),
  });

describe('file uploads (#29)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('builds a tool for a raw image body, with or without --uploads', () => {
    expect(toolsWith().tools.map((tool) => tool.toolName)).toContain('putImage');
    const body = toolsWith().tools.find((tool) => tool.toolName === 'putImage');
    expect(body?.mapper.bodyContentType).toBe('image/png');
  });

  it('offers a file name only with --uploads, and names the folder', () => {
    const plain = toolsWith().tools.find((tool) => tool.toolName === 'uploadPhoto');
    expect(JSON.stringify(plain?.wireSchema)).not.toContain('"file"');
    const tool = toolsWith('/home/example/uploads').tools.find(
      (entry) => entry.toolName === 'uploadPhoto',
    );
    const properties = (tool?.wireSchema ?? {})['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const { photo } = properties;
    expect(JSON.stringify(photo)).toContain('"file"');
    expect(String(photo?.['description'])).toContain('/home/example/uploads');
    expect(tool?.mapper.fields['photo']).toMatchObject({ upload: true });
    expect(tool?.mapper.fields['caption']).not.toHaveProperty('upload');
  });

  it('validates a file reference by its name', () => {
    const tool = toolsWith('/uploads').tools.find((entry) => entry.toolName === 'uploadFile');
    expect(tool?.inputSchema.safeParse({ body: { file: 'photo.png' } }).success).toBe(true);
    expect(tool?.inputSchema.safeParse({ body: { file: '../secret' } }).success).toBe(false);
    expect(tool?.inputSchema.safeParse({ body: { file: 'a.png', extra: 1 } }).success).toBe(false);
    expect(tool?.inputSchema.safeParse({ body: 'AAEC' }).success).toBe(true);
  });

  describe('resolveUploads', () => {
    const setUp = async () => {
      const root = mkdtempSync(join(tmpdir(), 'oamcp-resolve-'));
      roots.push(root);
      const folder = await openManagedFolder(join(root, 'uploads'), 'upload folder');
      const { tools } = toolsWith(folder.path);
      const mapperOf = (name: string) => {
        const tool = tools.find((entry) => entry.toolName === name);
        if (tool === undefined) {
          throw new Error(name);
        }
        return tool.mapper;
      };
      return { folder, mapperOf };
    };

    it('replaces a file reference by the file bytes as base64', async () => {
      const { folder, mapperOf } = await setUp();
      const png = pngOf(2, 2);
      await writeFile(join(folder.path, 'photo.png'), png);
      const result = await resolveUploads(
        { photo: { file: 'photo.png' }, caption: 'red' },
        mapperOf('uploadPhoto'),
        { folder, maxBytes: 1000 },
      );
      expect(result).toStrictEqual({
        ok: { photo: Buffer.from(png).toString('base64'), caption: 'red' },
      });
    });

    it('refuses a file that is not the declared image type', async () => {
      const { folder, mapperOf } = await setUp();
      await writeFile(join(folder.path, 'notes.txt'), 'not an image');
      const multipart = await resolveUploads(
        { photo: { file: 'notes.txt' } },
        mapperOf('uploadPhoto'),
        {
          folder,
          maxBytes: 1000,
        },
      );
      expect(multipart).toStrictEqual({
        error: 'upload "notes.txt" is not the declared image/png',
      });
      const raw = await resolveUploads({ body: { file: 'notes.txt' } }, mapperOf('putImage'), {
        folder,
        maxBytes: 1000,
      });
      expect(raw).toStrictEqual({ error: 'upload "notes.txt" is not the declared image/png' });
    });

    it('sends any file as application/octet-stream', async () => {
      const { folder, mapperOf } = await setUp();
      await writeFile(join(folder.path, 'notes.txt'), 'plain text');
      const result = await resolveUploads({ body: { file: 'notes.txt' } }, mapperOf('uploadFile'), {
        folder,
        maxBytes: 1000,
      });
      expect(result).toStrictEqual({ ok: { body: Buffer.from('plain text').toString('base64') } });
    });

    it('passes a refusal on, and leaves base64 and other fields alone', async () => {
      const { folder, mapperOf } = await setUp();
      const missing = await resolveUploads(
        { body: { file: 'missing.bin' } },
        mapperOf('uploadFile'),
        {
          folder,
          maxBytes: 1000,
        },
      );
      expect(missing).toStrictEqual({ error: 'upload "missing.bin" is not in the upload folder' });
      const untouched = { file: 'photo.png' };
      expect(
        await resolveUploads(untouched, mapperOf('createItem'), { folder, maxBytes: 1000 }),
      ).toStrictEqual({ ok: untouched });
      expect(
        await resolveUploads({ body: 'AAEC' }, mapperOf('uploadFile'), { folder, maxBytes: 1000 }),
      ).toStrictEqual({ ok: { body: 'AAEC' } });
    });
  });

  // Review of #58: reading the file counts against the call's deadline, so a
  // slow disk cannot send a write after the call should have timed out
  it('sends nothing when reading the file used up the time budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oamcp-deadline-'));
    roots.push(root);
    const folder = await openManagedFolder(join(root, 'uploads'), 'upload folder');
    await writeFile(join(folder.path, 'file.bin'), 'bytes');
    const snapshot = buildSnapshot(
      buildTools(OPERATIONS, {
        reservedHeaders: SYSTEM_HEADERS,
        openapiVersion: '3.1',
        uploadDir: folder.path,
      }),
      {
        spec: { title: 't', specVersion: '1', omitted: [] },
        contentHash: 'h',
        displaySource: 's',
        deadPatterns: [],
      },
    );
    const tool = snapshot.toolsByName['uploadFile'];
    if (tool === undefined) {
      throw new Error('uploadFile');
    }
    let sent = 0;
    // 0 before the file is read, 3 s from then on: only the read takes time
    const readings = [0];
    const executor = createExecutor(
      {
        baseUrl: 'https://api.example.test',
        baseTrusted: true,
        allowPrivateNetwork: false,
        allowInsecureHttp: false,
        secretHeaders: [],
        staticHeaders: [],
        reservedHeaderNames: new Set(SYSTEM_HEADERS),
        redactor: createRedactor([]),
        timeoutMs: 2000,
        maxResponseBytes: 65_536,
        outboundBudgets: { maxUrlLength: 8192, maxHeaderBytes: 16_384, maxBodyBytes: 65_536 },
        maxConcurrent: 4,
        validators: new Map([['uploadFile', compileEnvelopeValidator(tool.wireTool.outputSchema)]]),
        uploads: { folder, maxBytes: 1000 },
      },
      {
        transport: {
          fetch: () => {
            sent += 1;
            return Promise.reject(new Error('must not be sent'));
          },
          resolve: () => Promise.reject(new Error('no DNS')),
          timeoutSignal: () => new AbortController().signal,
        },
        retry: {
          sleep: () => Promise.resolve(),
          random: () => 0,
          now: () => readings.shift() ?? 3000,
        },
        now: () => 0,
      },
    );
    const outcome = await executor(
      tool,
      { body: { file: 'file.bin' } },
      new AbortController().signal,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toContain('the call timed out before the request was sent');
    expect(outcome.meta?.['openapi-mcp/effect']).toBe('not_sent');
    expect(sent).toBe(0);
  });
});
