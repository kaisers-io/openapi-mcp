import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveUploadOptions, uploadDirOf, UPLOAD_MAX_AGE_MS } from '../src/upload-options.ts';

// --upload-dir (#29)

const SOURCE = 'https://api.example.test/openapi.json';

describe('upload options (#29)', () => {
  const homes: string[] = [];
  const homeOf = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'oamcp-upload-options-'));
    homes.push(home);
    return home;
  };
  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const inputOf = (home: string, uploadDir?: string | true, now = Date.now()) => ({
    uploadDir,
    homeDir: home,
    source: SOURCE,
    cwd: home,
    maxBytes: 1000,
    now,
  });

  it('is off without the flag', async () => {
    const input = inputOf(homeOf());
    await expect(resolveUploadOptions(input)).resolves.toBeUndefined();
  });

  it('refuses a non-loopback --http-host', async () => {
    const input = { ...inputOf(homeOf(), true), httpHost: '0.0.0.0' };
    await expect(resolveUploadOptions(input)).rejects.toThrow(
      '--upload-dir cannot be used with a non-loopback --http-host',
    );
  });

  it('uses one folder per API under the home folder, and removes files older than 24 hours there', async () => {
    const home = homeOf();
    const first = await resolveUploadOptions(inputOf(home, true));
    const dir = uploadDirOf(home, SOURCE);
    expect(first?.folder.path).toBe(realpathSync(dir));
    writeFileSync(join(dir, 'photo.png'), 'x');
    const kept = await resolveUploadOptions(inputOf(home, true, Date.now() + 60_000));
    expect(kept?.deleted).toBe(0);
    const swept = await resolveUploadOptions(
      inputOf(home, true, Date.now() + UPLOAD_MAX_AGE_MS + 60_000),
    );
    expect(swept?.deleted).toBe(1);
    expect(readdirSync(dir)).toStrictEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'never cleans a folder the operator chose, and resolves it from the working directory',
    async () => {
      const home = homeOf();
      mkdirSync(join(home, 'mine'), { mode: 0o700 });
      writeFileSync(join(home, 'mine', 'photo.png'), 'x');
      const uploads = await resolveUploadOptions(
        inputOf(home, 'mine', Date.now() + UPLOAD_MAX_AGE_MS * 10),
      );
      expect(uploads?.folder.path).toBe(realpathSync(join(home, 'mine')));
      expect(uploads?.deleted).toBe(0);
      expect(readdirSync(join(home, 'mine'))).toStrictEqual(['photo.png']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a chosen folder open to other users',
    async () => {
      const home = homeOf();
      mkdirSync(join(home, 'shared'));
      chmodSync(join(home, 'shared'), 0o755);
      await expect(resolveUploadOptions(inputOf(home, 'shared'))).rejects.toThrow(
        'is open to other users',
      );
    },
  );

  it('refuses a chosen folder on Windows, where its privacy cannot be checked', async () => {
    const input = { ...inputOf(homeOf(), 'mine'), platform: 'win32' as const };
    await expect(resolveUploadOptions(input)).rejects.toThrow(
      '--upload-dir <folder> is not supported on Windows',
    );
  });
});
