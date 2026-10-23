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
//
// Why the pins must follow the version: the host examples pin an exact version, never `latest`,
// because the server runs with the user's API credentials and an unpinned `npx` runs whatever was
// published last (README "Upgrading"). Users copy the pin verbatim, so a pin that lags the release
// installs an older version than the one the same README documents.
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

const set = async (version: string): Promise<void> => {
  if (!SEMVER.test(version)) {
    console.error(`::error::"${version}" is not a valid semantic version (expected e.g. 1.2.3)`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  const sites = await readSites();
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
