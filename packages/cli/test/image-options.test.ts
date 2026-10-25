import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { imageDirOf, parseImageResponseMode, resolveImageResponses } from '../src/image-options.ts';

// --image-responses and --image-dir-max-bytes (#14)

describe('image options (#14)', () => {
  const homes: string[] = [];
  const homeOf = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'oamcp-image-options-'));
    homes.push(home);
    return home;
  };
  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const base = { dirMaxBytes: '100MB', source: 'https://api.example.test/openapi.json', cwd: '/' };

  it('accepts off, inline and file, and names the choices otherwise', () => {
    expect(parseImageResponseMode('file')).toBe('file');
    expect(() => parseImageResponseMode('base64')).toThrow(
      '--image-responses "base64" is not one of off, inline, file',
    );
  });

  it('is off by default and needs no folder then', async () => {
    await expect(
      resolveImageResponses({ ...base, mode: 'off', homeDir: undefined }),
    ).resolves.toBeUndefined();
    await expect(
      resolveImageResponses({ ...base, mode: 'inline', homeDir: undefined }),
    ).resolves.toStrictEqual({ mode: 'inline' });
  });

  it('refuses a folder cap below the size of one image', async () => {
    await expect(
      resolveImageResponses({ ...base, mode: 'file', homeDir: homeOf(), dirMaxBytes: '1MB' }),
    ).rejects.toThrow('--image-dir-max-bytes "1MB" is below');
  });

  it('refuses file mode on a non-loopback --http-host', async () => {
    await expect(
      resolveImageResponses({ ...base, mode: 'file', homeDir: homeOf(), httpHost: '0.0.0.0' }),
    ).rejects.toThrow('--image-responses file cannot be used with a non-loopback --http-host');
    await expect(
      resolveImageResponses({ ...base, mode: 'file', homeDir: homeOf(), httpHost: '127.0.0.1' }),
    ).resolves.toMatchObject({ mode: 'file' });
  });

  it('keeps one folder per API under the home folder, apart by source and cache key', async () => {
    const home = homeOf();
    const images = await resolveImageResponses({ ...base, mode: 'file', homeDir: home });
    const expected = imageDirOf(home, 'https://api.example.test/openapi.json');
    // The store reports the resolved path (macOS temp folders are links)
    expect(images?.mode === 'file' && images.store.dir).toBe(realpathSync(expected));
    expect(expected.startsWith(join(home, '.kaisers-io', 'openapi-mcp', 'images'))).toBe(true);
    expect(imageDirOf(home, 'https://api.example.test/openapi.json', 'prod')).not.toBe(expected);
    expect(imageDirOf(home, 'https://other.example.test/openapi.json')).not.toBe(expected);
  });
});
