import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

// The host examples pin an exact version (never `latest`, see README "Upgrading"), and a user
// copies that pin verbatim. A pin that lags the published version points them at an older
// release: one without the features the same README documents (native Windows support, for one).
// Every pin therefore follows `version` in packages/cli/package.json, which a release bumps.
const repoPath = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const DOCS = [
  'README.md',
  'packages/cli/README.md',
  ...readdirSync(repoPath('docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];

const pinsIn = (text: string): string[] =>
  [...text.matchAll(/@kaisers-io\/openapi-mcp@(?<version>[^\s"'`,)\]]+)/gu)].map(
    (match) => match.groups?.['version'] ?? '',
  );

describe('README version pins follow the package version', () => {
  it('finds the pinned host examples (so the check below cannot pass vacuously)', () => {
    for (const readme of ['README.md', 'packages/cli/README.md']) {
      const text = readFileSync(repoPath(readme), 'utf8');
      expect(pinsIn(text).length).toBeGreaterThan(0);
    }
  });

  it.each(DOCS)('pins exactly packages/cli/package.json `version` in %s', (path) => {
    for (const pinned of pinsIn(readFileSync(repoPath(path), 'utf8'))) {
      expect({ path, pinned }).toStrictEqual({ path, pinned: pkg.version });
    }
  });
});
