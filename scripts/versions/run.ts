// Keeps the released version identical everywhere this repository states it, and makes a version
// bump one command:
//
//   pnpm versions --check          report every disagreement, exit 1 if any
//   pnpm versions --set <version>  write <version> to every site and release the changelog
//
// (`pnpm versions` is `node scripts/versions/run.ts`.) The sites, in sites.ts:
//
//   packages/cli/package.json  .version: the source of truth, what npm publishes and `--version` prints
//   README.md, packages/cli/README.md, docs/*.md
//                              every `@kaisers-io/openapi-mcp@<version>` pin
//   docs/configuration.md      `"cliVersion"` in the `--json doctor` example, which prints
//                              packages/cli/package.json's version verbatim
//   CHANGELOG.md               `## [Unreleased]`, which `--set` turns into `## [<version>] - <date>`
//                              (Keep a Changelog form) under a fresh, empty `## [Unreleased]`
//   packages/cli/CHANGELOG.md  the copy the npm tarball ships: byte-identical to CHANGELOG.md, and
//                              released by `--set` together with it
//   skills/*/SKILL.md          `metadata.version`, the CLI version each agent skill was checked
//                              against (skill-sites.ts)
//
// Why the pins must follow the version: the host examples pin an exact version, never `latest`,
// because the server runs with the user's API credentials and an unpinned `npx` runs whatever was
// published last (README "Upgrading"). Users copy the pin verbatim, so a pin that lags the release
// installs an older version than the one the same README documents.
//
// `--set` takes only a version newer than the current one (SemVer precedence), and writes nothing
// unless every site can be rewritten.
//
// Every site is knowable on a pull request, so `--check` runs in CI on every PR (ci.yml `versions`)
// and again in release.yml before publishing. Plain Node with no dependencies (TypeScript through
// Node's type stripping, like scripts/bench), so both run it before `pnpm install`. Every problem is
// reported in one run: an unreadable file, malformed JSON or a missing site becomes one `::error::`
// line, never a stack trace, and never stops the other sites from being checked.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT,
  SEMVER,
  SOURCE_OF_TRUTH,
  describeValue,
  errorMessage,
  expectedFrom,
  problem,
  problems,
  readSites,
} from './sites.ts';
import type { Site } from './sites.ts';

const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;
const ARGV_START = 2;

const reportProblems = (): void => {
  for (const message of problems) {
    console.error(`::error::${message}`);
  }
  process.exitCode = EXIT_PROBLEMS;
};

const check = async (): Promise<void> => {
  const sites = await readSites();
  const expected = expectedFrom(sites);
  const values = sites.flatMap((site) => site.values);
  if (expected !== undefined) {
    for (const { label, value } of values) {
      if (value !== expected) {
        problem(`${label} says ${describeValue(value)}, but ${SOURCE_OF_TRUTH} is ${expected}`);
      }
    }
  }
  if (problems.length > 0) {
    reportProblems();
    return;
  }
  console.log(
    `version ${expected} is consistent across ${values.length} sites (source ${SOURCE_OF_TRUTH})`,
  );
};

type Edit = { file: string; text: string; change: string };

// Sequential, not `Promise.all`: several files cannot be written atomically, so the next best thing
// is damage that is bounded and nameable. A failure stops the loop and names what already carries
// the new version, so whoever is mid-release knows exactly what to revert.
const writeEdits = async (edits: Edit[], version: string): Promise<void> => {
  for (const [index, { change, file, text }] of edits.entries()) {
    try {
      await writeFile(join(ROOT, file), text);
    } catch (error) {
      const done = edits.slice(0, index).map((edit) => edit.file);
      problem(`${file} could not be written: ${errorMessage(error)}`);
      problem(
        `the tree is half-bumped: ${done.join(', ') || 'nothing'} already at ${version}, ${file} possibly partly written, every file after it untouched — revert those before retrying`,
      );
      return;
    }
    console.log(`${file}: ${change}`);
  }
  console.log(`every version site now declares ${version}; review the result with git diff`);
};

type Parsed = { core: number[]; prerelease: string[] };

const parse = (version: string): Parsed => {
  const [withoutBuild = ''] = version.split('+');
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? [] : withoutBuild.slice(dash + 1).split('.');
  return { core: core.split('.').map(Number), prerelease };
};

const NUMERIC = /^\d+$/u;

// SemVer 2.0.0 §11.4: numeric identifiers compare numerically and rank below alphanumeric ones,
// which compare in ASCII order.
const compareIdentifiers = (left: string, right: string): number => {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/**
 * SemVer 2.0.0 precedence (semver.org §11), negative when `left` is older. The cores compare
 * numerically, a release outranks its own prereleases, prereleases compare identifier by
 * identifier (a longer list wins when one is a prefix of the other), and build metadata is ignored.
 */
const comparePrecedence = (left: string, right: string): number => {
  const older = parse(left);
  const newer = parse(right);
  for (const [index, part] of older.core.entries()) {
    const difference = part - (newer.core[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  if (older.prerelease.length === 0 || newer.prerelease.length === 0) {
    return newer.prerelease.length - older.prerelease.length;
  }
  for (const [index, identifier] of older.prerelease.entries()) {
    const other = newer.prerelease[index];
    if (other === undefined) {
      return 1;
    }
    const difference = compareIdentifiers(identifier, other);
    if (difference !== 0) {
      return difference;
    }
  }
  return older.prerelease.length - newer.prerelease.length;
};

// Re-releasing the current version, or going back, would move every Unreleased entry under a
// heading for a version npm already has (or ranks lower), and `npm publish` refuses that only after
// the bump is merged and tagged.
const refuseIfNotNewer = (sites: Site[], version: string): void => {
  const current = expectedFrom(sites);
  if (current === undefined) {
    return;
  }
  if (!SEMVER.test(current)) {
    problem(
      `${SOURCE_OF_TRUTH} .version ${describeValue(current)} is not a valid semantic version`,
    );
  } else if (comparePrecedence(version, current) <= 0) {
    problem(
      `${version} is not newer than ${current}, the version in ${SOURCE_OF_TRUTH} — --set takes the next version`,
    );
  }
};

const set = async (version: string): Promise<void> => {
  if (!SEMVER.test(version)) {
    console.error(`::error::"${version}" is not a valid semantic version (expected e.g. 1.2.3)`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  const sites = await readSites();
  if (problems.length === 0) {
    refuseIfNotNewer(sites, version);
  }
  // Every file is rewritten in memory, and every problem with it reported, before the first byte is
  // written, so one unrewritable file refuses the bump instead of half-applying it. A read problem
  // stops here: rewriting a broken file only piles follow-on errors onto the real one.
  const edits: Edit[] = [];
  for (const site of problems.length === 0 ? sites : []) {
    const text = site.rewrite(version);
    if (text !== undefined) {
      edits.push({ file: site.file, text, change: site.describeChange(version) });
    }
  }
  if (problems.length > 0) {
    problem('nothing was written — every version site must be updatable before any of them is');
    reportProblems();
    return;
  }
  await writeEdits(edits, version);
  if (problems.length > 0) {
    reportProblems();
  }
};

const main = async (): Promise<void> => {
  const [mode, ...rest] = process.argv.slice(ARGV_START);
  const [version, ...extra] = rest;
  if (mode === '--check' && rest.length === 0) {
    await check();
  } else if (mode === '--set' && version !== undefined && extra.length === 0) {
    await set(version);
  } else {
    console.error('usage: pnpm versions --check | --set <version>');
    process.exitCode = EXIT_USAGE;
  }
};

// Last-resort net: anything unforeseen still ends in an `::error::` line, never a stack trace.
try {
  await main();
} catch (error) {
  console.error(`::error::scripts/versions/run.ts failed unexpectedly: ${errorMessage(error)}`);
  process.exitCode = EXIT_PROBLEMS;
}
