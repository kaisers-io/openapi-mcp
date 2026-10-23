import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The script resolves the repository root from its own location and takes no root argument, so
// each test copies scripts/versions/ into a throwaway tree and runs the copy as CI does, in a child
// `node` process. The real files are never read or written.
const SCRIPT_DIR = import.meta.dirname;
const SOURCE = 'packages/cli/package.json';
const README = 'README.md';
const CLI_README = 'packages/cli/README.md';
const CONFIGURATION = 'docs/configuration.md';
const SECURITY = 'docs/security.md';
const CHANGELOG = 'CHANGELOG.md';

const EXIT_OK = 0;
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;
// A read-only file is what makes a write fail midway; root ignores the mode bits.
const AS_ROOT = process.getuid?.() === 0;

const AT = '1.2.3';
const NEXT = '2.0.0';
const WRONG = '9.9.9';

// Fixtures shaped like the real files: the JSON keys start their own line (the surgical rewrites
// anchor to that), and the pins sit in the same contexts as in the READMEs: a JSON args array, a
// TOML args line, a shell command and backticked prose.
const pkg = (version: string): string =>
  `{\n  "name": "@kaisers-io/openapi-mcp",\n  "version": "${version}",\n  "type": "module"\n}\n`;
const readme = (version: string): string =>
  [
    '# openapi-mcp',
    '',
    '```json',
    `{ "args": ["-y", "@kaisers-io/openapi-mcp@${version}", "serve"] }`,
    '```',
    '',
    `npx -y @kaisers-io/openapi-mcp@${version} serve --spec ./spec.json`,
    '',
    `Pin an exact version (\`npx -y @kaisers-io/openapi-mcp@${version} ...\`), never \`latest\`.`,
    'Install globally with `npm i -g @kaisers-io/openapi-mcp`.',
    '',
  ].join('\n');
const cliReadme = (version: string): string =>
  `# openapi-mcp\n\nargs = [\n  "-y", "@kaisers-io/openapi-mcp@${version}", "serve",\n]\n`;
const configuration = (version: string): string =>
  `# Configuration\n\n\`\`\`json\n{\n  "data": {\n    "cliVersion": "${version}",\n    "nodeVersion": "24.12.0"\n  }\n}\n\`\`\`\n`;
const CHANGES =
  '# Changelog\n\nThe format is based on Keep a Changelog.\n\n## [Unreleased]\n\n### Changed\n\n- Something changed.\n';

const FILES: Record<string, (version: string) => string> = {
  [SOURCE]: pkg,
  [README]: readme,
  [CLI_README]: cliReadme,
  [CONFIGURATION]: configuration,
  [SECURITY]: () => '# Security\n\nNo pins here.\n',
  [CHANGELOG]: () => CHANGES,
};
const original = (file: string): string => FILES[file]?.(AT) ?? '';

const trees: string[] = [];
const removeTrees = async (): Promise<void> => {
  await Promise.all(trees.map(async (root) => rm(root, { force: true, recursive: true })));
};

/** A throwaway tree with a copy of the script. `overrides` replaces content; `undefined` omits a file. */
const makeTree = async (overrides: Record<string, string | undefined> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'openapi-mcp-versions-'));
  trees.push(root);
  await cp(join(SCRIPT_DIR, 'run.ts'), join(root, 'scripts/versions/run.ts'));
  await cp(join(SCRIPT_DIR, 'sites.ts'), join(root, 'scripts/versions/sites.ts'));
  // The real root package.json declares `"type": "module"`, which the script relies on.
  const files: Record<string, string | undefined> = { 'package.json': '{ "type": "module" }\n' };
  for (const file of Object.keys(FILES)) {
    files[file] = original(file);
  }
  for (const [path, content] of Object.entries({ ...files, ...overrides })) {
    if (content !== undefined) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }
  return root;
};

type Run = { code: number | null; err: string; errors: string[]; out: string };

const run = (root: string, ...args: string[]): Run => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/versions/run.ts'), ...args], {
    encoding: 'utf8',
  });
  const errors = result.stderr.split('\n').filter((line) => line.startsWith('::error::'));
  return { code: result.status, err: result.stderr, errors, out: result.stdout };
};

const RENAMED = 'docs/config.md';
const MISSING = '(missing)';

/** Every fixture file's content, plus the renamed doctor example; `(missing)` for an absent one. */
const readTree = async (root: string): Promise<Record<string, string>> => {
  const entries = await Promise.all(
    [...Object.keys(FILES), RENAMED].map(async (file) => {
      try {
        return [file, await readFile(join(root, file), 'utf8')];
      } catch {
        return [file, MISSING];
      }
    }),
  );
  return Object.fromEntries(entries) as Record<string, string>;
};

// The doctor example deleted, or renamed so that `docs/*.md` discovery still finds its pins.
const WITHOUT_DOCTOR_EXAMPLE: [string, Record<string, string | undefined>][] = [
  ['deleted', { [CONFIGURATION]: undefined }],
  ['renamed', { [CONFIGURATION]: undefined, [RENAMED]: configuration(AT) }],
];

const escape = (text: string): string => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/** Asserts that one `::error::` line contains every part, in order. */
const expectError = (result: Run, ...parts: string[]): void => {
  const pattern = new RegExp(parts.map((part) => escape(part)).join('.*'), 'u');
  expect(result.errors).toContainEqual(expect.stringMatching(pattern));
};

/** Overrides that put every version site of a fixture tree at `version`. */
const atVersion = (version: string): Record<string, string> =>
  Object.fromEntries(Object.entries(FILES).map(([file, render]) => [file, render(version)]));

// Pins in prose: at the end of a sentence, before a colon, and inside an autolink.
const prose = (version: string): string =>
  [
    `Pin @kaisers-io/openapi-mcp@${version}.`,
    `Pin @kaisers-io/openapi-mcp@${version}: it is exact.`,
    `See <https://www.npmjs.com/package/@kaisers-io/openapi-mcp@${version}>.`,
    'The core package @kaisers-io/openapi-mcp-core@0.1.0 is not a pin.',
    '',
  ].join('\n');

const withPin = (pin: string): string =>
  readme(AT).replace(`openapi-mcp@${AT} serve --spec`, `openapi-mcp@${pin} serve --spec`);

describe('versions --check', () => {
  afterAll(removeTrees);

  it('passes on a consistent tree whose changelog starts with Unreleased', async () => {
    const result = run(await makeTree(), '--check');
    expect(result).toMatchObject({ code: EXIT_OK });
    expect(result.out).toContain(
      'version 1.2.3 is consistent across 6 sites (source packages/cli/package.json)',
    );
  });

  // The load-bearing case: a wrong value at any site is caught and named with its line.
  it.each([
    [README, readme, 4],
    [CLI_README, cliReadme, 4],
    [CONFIGURATION, configuration, 6],
  ])('fails, naming %s:%i, when it alone drifts', async (file, render, line) => {
    const result = run(await makeTree({ [file]: render(WRONG) }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, `${file}:${line}`, WRONG, `${SOURCE} is ${AT}`);
  });

  it('reports every drifted pin in a file, not just the first', async () => {
    const result = run(await makeTree({ [README]: readme(WRONG) }), '--check');
    expect(result.errors).toHaveLength(3);
  });

  // The mirror image: a wrong source of truth makes every other site disagree.
  it('fails at every other site when the source of truth alone drifts', async () => {
    const result = run(await makeTree({ [SOURCE]: pkg(WRONG) }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expect(result.errors).toHaveLength(5);
    for (const file of [README, CLI_README, CONFIGURATION]) {
      expectError(result, file, AT, `${SOURCE} is ${WRONG}`);
    }
  });

  it('finds pins in any docs/*.md file, not just a fixed list', async () => {
    const result = run(await makeTree({ [SECURITY]: readme(WRONG) }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, `${SECURITY}:4`, WRONG);
  });

  // The server runs with the user's API credentials, so a pin must be exact: a dist-tag or a range
  // lets npx resolve whatever was published last.
  it.each(['latest', '^1.2.3', '1.2'])('refuses the inexact pin @%s', async (pin) => {
    const result = run(await makeTree({ [README]: withPin(pin) }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, `${README}:7`, pin, 'not an exact version');
  });

  // A sentence's closing `.` or `:`, and an autolink's `>`, end the pin rather than becoming part of
  // its version. A prerelease's own dots stay in it.
  it.each([AT, '1.0.0-rc.1'])('reads pins in prose at %s without false errors', async (version) => {
    const tree = { ...atVersion(version), [SECURITY]: prose(version) };
    const result = run(await makeTree(tree), '--check');
    expect(result).toMatchObject({ code: EXIT_OK });
    expect(result.out).toContain('across 9 sites');
  });

  it('still reports a drifted pin in prose, with its line', async () => {
    const result = run(await makeTree({ [SECURITY]: prose(WRONG) }), '--check');
    expect(result.errors).toHaveLength(3);
    expectError(result, `${SECURITY}:3`, `"${WRONG}"`, `${SOURCE} is ${AT}`);
  });

  // Without this, deleting every pin (or a pin the pattern stops recognising) would pass vacuously.
  it('fails when a README has no pin at all', async () => {
    const result = run(await makeTree({ [CLI_README]: '# openapi-mcp\n' }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, CLI_README, 'no @kaisers-io/openapi-mcp@<version> pin');
  });

  it('fails when docs/configuration.md lost its cliVersion example', async () => {
    const result = run(await makeTree({ [CONFIGURATION]: '# Configuration\n' }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, CONFIGURATION, '0 "cliVersion" line(s), expected exactly one');
  });

  // The doctor example is a required input, not just whatever `docs/*.md` happens to contain:
  // otherwise deleting or renaming it would drop its site from the check without a word.
  it.each(WITHOUT_DOCTOR_EXAMPLE)(
    'fails when docs/configuration.md is %s',
    async (_case, overrides) => {
      const result = run(await makeTree(overrides), '--check');
      expect(result.code).toBe(EXIT_PROBLEMS);
      expectError(result, `${CONFIGURATION} could not be read`);
    },
  );

  it('fails when the changelog has no Unreleased heading for --set to release', async () => {
    const released = '# Changelog\n\n## [1.2.3] - 2026-01-01\n\n- Old.\n';
    const result = run(await makeTree({ [CHANGELOG]: released }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, CHANGELOG, '0 "## [Unreleased]" heading(s), expected exactly one');
  });

  it('fails on malformed JSON without a stack trace', async () => {
    const result = run(await makeTree({ [SOURCE]: '{ "version": ' }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, `${SOURCE} is not valid JSON`);
    expect(result.err).not.toContain('    at ');
  });

  it('fails when the source of truth has no usable version', async () => {
    const unversioned = '{\n  "name": "@kaisers-io/openapi-mcp"\n}\n';
    const result = run(await makeTree({ [SOURCE]: unversioned }), '--check');
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, `${SOURCE} has no usable .version`);
  });

  // One run, every problem: at release time nobody should need a second run to find the next one.
  it('reports every problem in a single run', async () => {
    const result = run(
      await makeTree({
        [SOURCE]: 'not json at all',
        [CLI_README]: undefined,
        [CONFIGURATION]: '# Configuration\n',
        [CHANGELOG]: '# Changelog\n',
      }),
      '--check',
    );
    expect(result.code).toBe(EXIT_PROBLEMS);
    expectError(result, `${SOURCE} is not valid JSON`);
    expectError(result, `${CLI_README} could not be read`);
    expectError(result, CONFIGURATION, '"cliVersion"');
    expectError(result, CHANGELOG, '"## [Unreleased]"');
    expectError(result, `${SOURCE} has no usable .version`);
  });
});

/** Runs a `--set` that must be refused as a whole, and proves that no file was touched. */
const expectRefusedSet = async (
  overrides: Record<string, string | undefined>,
  reason: string,
  target = NEXT,
): Promise<void> => {
  const root = await makeTree(overrides);
  const before = await readTree(root);
  const result = run(root, '--set', target);
  expect(result).toMatchObject({ code: EXIT_PROBLEMS });
  expect(result.err).toContain(reason);
  expect(result.err).toContain('nothing was written');
  expect(await readTree(root)).toStrictEqual(before);
};

describe('versions --set', () => {
  afterAll(removeTrees);

  it('round-trips: --check passes afterwards, and only the version lines moved', async () => {
    const root = await makeTree();
    const days = [new Date().toISOString().slice(0, 10)];
    const bump = run(root, '--set', NEXT);
    days.push(new Date().toISOString().slice(0, 10));
    expect(bump).toMatchObject({ code: EXIT_OK });
    expect(bump.out).toContain('every version site now declares 2.0.0');
    expect(run(root, '--check').code).toBe(EXIT_OK);
    const after = await readTree(root);
    for (const file of [SOURCE, README, CLI_README, CONFIGURATION]) {
      expect(after[file]).not.toBe(original(file));
      // Undo the substitution: anything else that moved shows up as a mismatch here.
      expect(after[file]?.replaceAll(NEXT, AT)).toBe(original(file));
    }
    expect(after[SECURITY]).toBe(original(SECURITY));
    // A run that straddles midnight (UTC) may stamp either day.
    const released = (day: string): string =>
      CHANGES.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${NEXT}] - ${day}\n`);
    expect(days.map((day) => released(day))).toContain(after[CHANGELOG]);
  });

  it('keeps the changelog below the new heading byte for byte', async () => {
    const history = `${CHANGES}\n## [1.2.2] - 2026-01-01\n\n- Older.\n`;
    const root = await makeTree({ [CHANGELOG]: history });
    expect(run(root, '--set', NEXT).code).toBe(EXIT_OK);
    const released = await readFile(join(root, CHANGELOG), 'utf8');
    expect(released).toMatch(
      /^# Changelog\n\nThe format is based on Keep a Changelog\.\n\n## \[Unreleased\]\n\n## \[2\.0\.0\] - \d{4}-\d{2}-\d{2}\n\n/u,
    );
    const below = history.slice(history.indexOf('### Changed'));
    expect(released.endsWith(below)).toBe(true);
  });

  // SemVer proper, not `\d+.\d+.\d+`: leading zeros are invalid and npm would reject them at publish.
  it.each(['01.2.3', '1.02.3', '1.2.3-01', '1.2', 'v1.2.3', '1.2.3-', '', 'latest'])(
    'refuses %j and writes nothing',
    async (bad) => {
      const root = await makeTree();
      const before = await readTree(root);
      const result = run(root, '--set', bad);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.err).toContain('is not a valid semantic version');
      expect(await readTree(root)).toStrictEqual(before);
    },
  );

  it.each(['1.2.4', '1.3.0-rc.1', '2.0.0+build.5', '10.0.0'])('accepts %s', async (good) => {
    const root = await makeTree();
    expect(run(root, '--set', good).code).toBe(EXIT_OK);
    expect(run(root, '--check').code).toBe(EXIT_OK);
    expect(await readFile(join(root, CLI_README), 'utf8')).toContain(
      `"@kaisers-io/openapi-mcp@${good}"`,
    );
  });

  // Re-releasing the current version, or going back, would move every Unreleased entry under a
  // heading for a version npm already has (or will refuse), and `npm publish` reports that only
  // after the bump is merged and tagged. Order is SemVer precedence; build metadata is ignored.
  it.each([
    [AT, AT],
    [AT, '1.2.3+build.5'],
    [AT, '1.2.2'],
    [AT, '1.1.9'],
    [AT, '0.9.9'],
    [AT, '1.2.3-rc.1'],
    ['1.2.3-rc.2', '1.2.3-rc.1'],
    ['1.2.3-rc.10', '1.2.3-rc.9'],
    ['1.2.3-beta', '1.2.3-alpha'],
    ['1.2.3-alpha.1', '1.2.3-alpha'],
    ['1.2.3-alpha.beta', '1.2.3-alpha.1'],
  ])('refuses to go from %s to %s, which is not newer', async (current, target) => {
    await expectRefusedSet(atVersion(current), 'is not newer than', target);
  });

  it.each([
    ['1.2.3-rc.1', '1.2.3'],
    ['1.2.3-rc.1', '1.2.3-rc.2'],
    ['1.2.3-rc.9', '1.2.3-rc.10'],
    ['1.2.3-alpha', '1.2.3-alpha.1'],
    ['1.2.3-alpha.1', '1.2.3-alpha.beta'],
    ['1.2.3-alpha', '1.2.3-beta'],
    ['1.2.3', '1.2.4-rc.1'],
    ['1.9.9', '1.10.0'],
  ])('accepts going from %s to %s', async (current, target) => {
    const root = await makeTree(atVersion(current));
    expect(run(root, '--set', target)).toMatchObject({ code: EXIT_OK });
    expect(run(root, '--check').code).toBe(EXIT_OK);
  });

  // Two "version"-shaped lines in the source of truth (one nested) trip the surgical rewrite's line
  // count; every other site is fine and must stay untouched too.
  it('refuses the whole bump when one site is unrewritable', async () => {
    const nested = `{\n  "version": "${AT}",\n  "extra": {\n    "version": "${AT}"\n  }\n}\n`;
    await expectRefusedSet({ [SOURCE]: nested }, 'refusing to edit it');
  });

  // Running the bump twice would otherwise release the fresh, empty Unreleased as a second heading.
  it('refuses a version the changelog already has a heading for', async () => {
    const twice = '# Changelog\n\n## [Unreleased]\n\n- New.\n\n## [2.0.0] - 2026-01-01\n\n- Old.\n';
    await expectRefusedSet({ [CHANGELOG]: twice }, 'already has a "## [2.0.0] - " heading');
  });

  it('refuses to release an empty Unreleased section', async () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n- Old.\n';
    await expectRefusedSet({ [CHANGELOG]: empty }, '"## [Unreleased]" section is empty');
  });

  it('refuses a pin that is not an exact version rather than overwrite it', async () => {
    await expectRefusedSet({ [README]: withPin('latest') }, 'not an exact version');
  });

  it.each(WITHOUT_DOCTOR_EXAMPLE)(
    'refuses the bump when docs/configuration.md is %s',
    async (_case, overrides) => {
      await expectRefusedSet(overrides, `${CONFIGURATION} could not be read`);
    },
  );

  it('rewrites pins in prose and keeps the punctuation after them', async () => {
    const root = await makeTree({ [SECURITY]: prose(AT) });
    expect(run(root, '--set', NEXT)).toMatchObject({ code: EXIT_OK });
    expect(await readFile(join(root, SECURITY), 'utf8')).toBe(prose(NEXT));
  });

  // The source of truth is written first, so locking it recreates the case the write loop's
  // stop-on-first-failure exists for: no later file may be written, and the report must not claim
  // that nothing was.
  it.skipIf(AS_ROOT)('names the half-bumped tree when a write fails', async () => {
    const root = await makeTree();
    await chmod(join(root, SOURCE), 0o444);
    const result = run(root, '--set', NEXT);
    await chmod(join(root, SOURCE), 0o644);
    expect(result.code).toBe(EXIT_PROBLEMS);
    expect(result.err).toContain('packages/cli/package.json could not be written');
    expect(result.err).toContain('the tree is half-bumped: nothing already at 2.0.0');
    expect(result.err).not.toContain('nothing was written');
    const after = await readTree(root);
    for (const file of Object.keys(FILES)) {
      expect(after[file]).toBe(original(file));
    }
  });
});

describe('versions usage', () => {
  afterAll(removeTrees);

  it('treats an unrecognised invocation as a usage error', async () => {
    const root = await makeTree();
    for (const args of [[], ['--check', 'extra'], ['--set'], ['--set', NEXT, 'extra']]) {
      expect(run(root, ...args).code).toBe(EXIT_USAGE);
    }
  });
});
