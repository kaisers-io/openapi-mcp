import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

// The npm tarball ships packages/cli/CHANGELOG.md, because npm only packs files inside the
// package directory. The repository's CHANGELOG.md is the one contributors edit, so the
// packaged copy must stay byte-identical to it: a pull request that edits only the root copy
// would otherwise publish a stale changelog. release.yml checks the same with `cmp` before
// packing; this catches the drift on the pull request that introduces it.
const repoPath = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url));

describe('packaged changelog', () => {
  it('is listed in the published files', () => {
    expect(pkg.files).toContain('CHANGELOG.md');
  });

  it('is byte-identical to the repository CHANGELOG.md', () => {
    const root = readFileSync(repoPath('CHANGELOG.md'));
    const packaged = readFileSync(repoPath('packages/cli/CHANGELOG.md'));
    // As text first, so a mismatch prints a readable diff; then as bytes, which is what `cmp` checks
    expect(packaged.toString('utf8')).toBe(root.toString('utf8'));
    expect(Buffer.compare(packaged, root)).toBe(0);
  });
});
