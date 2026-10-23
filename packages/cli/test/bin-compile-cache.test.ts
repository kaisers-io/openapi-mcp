import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../bin/openapi-mcp.mjs', import.meta.url));

// Runs `--version` under umask 022 (the common default) with a fresh HOME:
// the compile-cache directory Node would otherwise create 0755 must not
// leave the app root world-listable
const runVersion = (home: string): number | null => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env['NODE_DISABLE_COMPILE_CACHE'];
  const result = spawnSync(
    'sh',
    ['-c', 'umask 022 && exec "$0" "$1" --version', process.execPath, bin],
    { env, encoding: 'utf8', timeout: 30_000 },
  );
  return result.status;
};

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe.skipIf(process.platform === 'win32')(
  'bin stub — V8 compile cache directory (issue kaisers-io/openapi-mcp-archive#76)',
  () => {
    const homes: string[] = [];
    const freshHome = (): string => {
      const home = mkdtempSync(join(tmpdir(), 'openapi-mcp-home-'));
      homes.push(home);
      return home;
    };
    afterEach(() => {
      for (const home of homes.splice(0)) {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('creates every app directory 0700 on the very first run, even for --version', () => {
      const home = freshHome();
      expect(runVersion(home)).toBe(0);
      const appDir = join(home, '.kaisers-io');
      expect(modeOf(appDir)).toBe(0o700);
      expect(modeOf(join(appDir, 'openapi-mcp'))).toBe(0o700);
      expect(modeOf(join(appDir, 'openapi-mcp', 'compile-cache'))).toBe(0o700);
    }, 60_000);

    it('leaves an existing ancestor alone and repairs only its own cache directory', () => {
      const home = freshHome();
      const appRoot = join(home, '.kaisers-io', 'openapi-mcp');
      mkdirSync(join(appRoot, 'compile-cache'), { recursive: true, mode: 0o755 });
      expect(runVersion(home)).toBe(0);
      expect(modeOf(join(home, '.kaisers-io'))).toBe(0o755);
      expect(modeOf(join(appRoot, 'compile-cache'))).toBe(0o700);
    }, 60_000);

    it('starts without a cache instead of following a planted symlink', () => {
      const home = freshHome();
      const elsewhere = freshHome();
      symlinkSync(elsewhere, join(home, '.kaisers-io'));
      expect(runVersion(home)).toBe(0);
      expect(readdirSync(elsewhere)).toEqual([]);
    }, 60_000);
  },
);
