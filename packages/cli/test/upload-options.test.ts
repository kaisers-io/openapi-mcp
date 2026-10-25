import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveUploadOptions, uploadDirOf, UPLOAD_MAX_AGE_MS } from '../src/upload-options.ts';

// --uploads (#29): always the default folder, the same on every platform

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
  const inputOf = (home: string, enabled = true, now = Date.now()) => ({
    enabled,
    homeDir: home,
    source: SOURCE,
    cwd: home,
    maxBytes: 1000,
    now,
  });

  it('is off without the flag', async () => {
    const input = inputOf(homeOf(), false);
    await expect(resolveUploadOptions(input)).resolves.toBeUndefined();
  });

  it('refuses a non-loopback --http-host', async () => {
    const input = { ...inputOf(homeOf()), httpHost: '0.0.0.0' };
    await expect(resolveUploadOptions(input)).rejects.toThrow(
      '--uploads cannot be used with a non-loopback --http-host',
    );
  });

  it('uses one folder per API under the home folder', async () => {
    const home = homeOf();
    const uploads = await resolveUploadOptions(inputOf(home));
    expect(uploads?.folder.path).toBe(realpathSync.native(uploadDirOf(home, SOURCE)));
    expect(uploadDirOf(home, SOURCE, 'prod')).not.toBe(uploadDirOf(home, SOURCE));
    expect(uploadDirOf(home, 'https://other.example.test/openapi.json')).not.toBe(
      uploadDirOf(home, SOURCE),
    );
  });

  it('removes files older than 24 hours at startup, and keeps newer ones', async () => {
    const home = homeOf();
    await resolveUploadOptions(inputOf(home));
    const dir = uploadDirOf(home, SOURCE);
    writeFileSync(join(dir, 'photo.png'), 'x');
    const kept = await resolveUploadOptions(inputOf(home, true, Date.now() + 60_000));
    expect(kept?.deleted).toBe(0);
    const later = Date.now() + UPLOAD_MAX_AGE_MS + 60_000;
    const swept = await resolveUploadOptions(inputOf(home, true, later));
    expect(swept?.deleted).toBe(1);
    expect(readdirSync(dir)).toStrictEqual([]);
  });
});
