import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIGHT_SUBPROCESS_FILES, SUBPROCESS_E2E_FILES } from './subprocess-budget.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packagesDir = join(repoRoot, 'packages');
const CHILD_PROCESS_IMPORT = /from\s+['"](?:node:)?child_process['"]/u;

const testFilesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
};

// Guards the manual file list in subprocess-budget.ts (issue #96): a test file
// that spawns processes but is missing from SUBPROCESS_E2E_FILES would run in
// a unit project under the 5 s default timeout and alongside the unit workers,
// which is exactly the setup that made the subprocess suites flaky.
describe('subprocess test budget', () => {
  it('assigns every test file that imports node:child_process to a list', async () => {
    const packageNames = await readdir(packagesDir);
    const perPackage = await Promise.all(
      packageNames.map((name) => testFilesUnder(join(packagesDir, name, 'test'))),
    );
    const files = perPackage.flat();
    const e2e = new Set(SUBPROCESS_E2E_FILES.map((file) => `packages/cli/${file}`));
    const matches = await Promise.all(
      files.map(async (file) =>
        CHILD_PROCESS_IMPORT.test(await readFile(file, 'utf8'))
          ? relative(repoRoot, file).replaceAll('\\', '/')
          : undefined,
      ),
    );
    const spawning = matches.filter((file) => file !== undefined);
    const unassigned = spawning.filter(
      (file) => !e2e.has(file) && !Object.hasOwn(LIGHT_SUBPROCESS_FILES, file),
    );
    expect(
      unassigned,
      'add these files to SUBPROCESS_E2E_FILES (or, with a reason, LIGHT_SUBPROCESS_FILES) in packages/cli/test/subprocess-budget.ts',
    ).toStrictEqual([]);
  });

  it('lists only files that exist and import node:child_process', async () => {
    const listed = [
      ...SUBPROCESS_E2E_FILES.map((file) => join(repoRoot, 'packages/cli', file)),
      ...Object.keys(LIGHT_SUBPROCESS_FILES).map((file) => join(repoRoot, file)),
    ];
    const checked = await Promise.all(
      listed.map(async (file) => {
        const source = await readFile(file, 'utf8').catch(() => '');
        return CHILD_PROCESS_IMPORT.test(source) ? undefined : relative(repoRoot, file);
      }),
    );
    const stale = checked.filter((file) => file !== undefined);
    expect(stale).toStrictEqual([]);
  });
});
