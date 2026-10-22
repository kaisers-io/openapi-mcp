import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isValidBearerToken } from '../src/index.ts';

// Drift check between the HTTP-token documentation and the real validator: every token
// generator the docs tell users to run is executed here and its output fed to
// `isValidBearerToken`, so an example that the validator would reject cannot ship.

const DOCS = ['README.md', 'docs/configuration.md', 'docs/security.md'] as const;
const SAMPLES = 10;

const readDoc = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

// Generators are documented as `export TOKEN=$(<command>)` lines inside bash blocks (indented
// when the block sits in a list item).
const generatorsIn = (doc: string): string[] =>
  [...doc.matchAll(/^[ \t]*export TOKEN=\$\((?<command>.+)\)$/gmu)].map(
    (match) => match.groups?.['command'] ?? '',
  );

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

// Runs one documented command the way `$(...)` would: stdout with trailing newlines removed.
// Only the command shapes the docs use are runnable; anything else fails loudly so a new
// generator cannot be documented without being exercised here.
const runGenerator = (command: string): string => {
  const node = /^node -p "(?<script>[^"]+)"$/u.exec(command);
  const result =
    node === null
      ? spawnSync(command.split(' ')[0] ?? '', command.split(' ').slice(1), { encoding: 'utf8' })
      : spawnSync(process.execPath, ['-p', node.groups?.['script'] ?? ''], { encoding: 'utf8' });
  // The command and stderr ride along in the subject so a failure shows why it failed.
  expect({ command, status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  return result.stdout.replace(/\n+$/u, '');
};

describe('HTTP token documentation matches the validator', () => {
  const generators = [...new Set(DOCS.flatMap((path) => generatorsIn(readDoc(path))))];

  it.each(DOCS)('%s shows at least one token generator', (path) => {
    expect(generatorsIn(readDoc(path)).length).toBeGreaterThan(0);
  });

  it('documents only generators this test knows how to run', () => {
    for (const command of generators) {
      expect(command).toMatch(/^(?:openssl rand -base64 32|node -p "[^"]+")$/u);
    }
  });

  it.each(generators.filter((command) => command.startsWith('node ')))(
    'every token from `%s` passes the validator',
    (command) => {
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        expect(isValidBearerToken(runGenerator(command))).toBe(true);
      }
    },
  );

  it.skipIf(!hasOpenssl).each(generators.filter((command) => command.startsWith('openssl ')))(
    'every token from `%s` passes the validator',
    (command) => {
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        expect(isValidBearerToken(runGenerator(command))).toBe(true);
      }
    },
  );

  it('states the exact accepted encodings and decoded length in docs/security.md', () => {
    const security = readDoc('docs/security.md');
    expect(security).toContain('exactly 32 bytes (256 bits)');
    expect(security).toContain('44 characters of padded standard Base64');
    expect(security).toContain('43 characters of unpadded Base64URL');
    // The old minimum-length wording admitted tokens the validator rejects.
    expect(security).not.toMatch(/at least 32/u);
  });

  it.each(DOCS)(
    '%s requires random generation rather than implying the format guarantees entropy',
    (path) => {
      expect(readDoc(path)).toMatch(/cryptographically secure random/u);
    },
  );
});
