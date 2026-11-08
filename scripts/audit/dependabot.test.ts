import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Keeps the libraries bundled into the CLI out of Dependabot's tooling group, so each bump of one
// gets its own pull request (.github/dependabot.yml explains why). The bundled set is every
// dependency of packages/core and every non-workspace devDependency of packages/cli: tsdown inlines
// all of them into dist/. A new runtime dependency that no exclude pattern matches would quietly
// join the tooling group, and this test fails instead.

const ROOT = join(import.meta.dirname, '../..');

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(ROOT, path), 'utf8')) as Record<string, unknown>;

const names = (value: unknown, skip: (version: string) => boolean = () => false): string[] =>
  Object.entries((value ?? {}) as Record<string, string>)
    .filter(([, version]) => !skip(version))
    .map(([name]) => name);

// Dependabot's patterns: `*` matches any run of characters, everything else matches itself.
const matches = (pattern: string, name: string): boolean => {
  const source = pattern
    .split('*')
    .map((part) => part.replaceAll(/[$()+.?[\\\]^{|}]/gu, String.raw`\$&`))
    .join('.*');
  return new RegExp(`^${source}$`, 'u').test(name);
};

const unexcluded = (dependencies: string[], excludes: string[]): string[] =>
  dependencies.filter((name) => !excludes.some((pattern) => matches(pattern, name)));

interface Update {
  'package-ecosystem': string;
  directory: string;
  groups?: Record<string, { patterns?: string[]; 'exclude-patterns'?: string[] }>;
}

const toolingGroup = async () => {
  const config = parse(await readFile(join(ROOT, '.github/dependabot.yml'), 'utf8')) as {
    updates: Update[];
  };
  const npm = config.updates.find(
    (update) => update['package-ecosystem'] === 'npm' && update.directory === '/',
  );
  return npm?.groups?.['dev-tooling'];
};

describe('Dependabot groups in .github/dependabot.yml', () => {
  it('keeps every bundled library out of the tooling group', async () => {
    expect.hasAssertions();
    const core = await readJson('packages/core/package.json');
    const cli = await readJson('packages/cli/package.json');
    const bundled = [
      ...names(core['dependencies']),
      ...names(cli['devDependencies'], (version) => version.startsWith('workspace:')),
    ];
    const group = await toolingGroup();
    expect(group?.patterns).toStrictEqual(['*']);
    expect(bundled).toContain('zod');
    expect(unexcluded(bundled, group?.['exclude-patterns'] ?? [])).toStrictEqual([]);
  });

  it('matches names the way Dependabot does', () => {
    expect.hasAssertions();
    const excludes = ['ajv-*', '@jitl/*', 'zod'];
    const candidates = [
      'ajv-formats',
      '@jitl/quickjs',
      'zod',
      'ajv',
      'zodiac',
      '@jitlx/a',
      'xajv-formats',
    ];
    expect(unexcluded(candidates, excludes)).toStrictEqual([
      'ajv',
      'zodiac',
      '@jitlx/a',
      'xajv-formats',
    ]);
  });
});
