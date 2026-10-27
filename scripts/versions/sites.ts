// The version sites that run.ts checks and rewrites: where each one is, how it is read, and how it
// is rewritten. See run.ts for the list and the reasons.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skillSites } from './skill-sites.ts';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not `cwd` or `git rev-parse`: it works from any directory and in a tree
// without `.git`. It is also the test suite's only hook (it copies this directory into a fixture
// tree), so no root override exists to be misused.
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const SOURCE_OF_TRUTH = 'packages/cli/package.json';
// Files that must pin at least once. Without this floor, deleting every pin, or a pin the pattern
// below stops recognising, would pass `--check` vacuously.
const PINNED_READMES = ['README.md', 'packages/cli/README.md'];
const DOCS_DIR = 'docs';
const DOCTOR_EXAMPLE = 'docs/configuration.md';
const CHANGELOG = 'CHANGELOG.md';
// What npm users see: npm packs only files inside the package directory, so the tarball ships this
// copy (`files` in packages/cli/package.json). It must stay byte-identical to CHANGELOG.md.
const PACKAGED_CHANGELOG = 'packages/cli/CHANGELOG.md';

// A JSON key at the start of a line. The anchor keeps this off a `version` substring in a
// description, and a JSON string cannot contain a raw newline, so a match is always a key.
const JSON_VERSION_LINE = /^(?<prefix>[ \t]*"version"[ \t]*:[ \t]*)"(?:[^"\\]|\\.)*"/gmu;
const CLI_VERSION_LINE = /^(?<prefix>[ \t]*"cliVersion"[ \t]*:[ \t]*)"(?<version>[^"\\]*)"/gmu;
// A pin in a JSON or TOML string, a shell command, backticked prose or an autolink (`<…>`). The
// value runs to the first character that ends it in any of those contexts, so `latest` or `^1.2.3`
// is captured whole and reported rather than skipped; a sentence's closing `.` or `:` is not part
// of it, while a prerelease's own dots are. `@kaisers-io/openapi-mcp-core@` does not match.
const PIN =
  /(?<prefix>@kaisers-io\/openapi-mcp@)(?<version>[^\s"'`,)\]<>;]+?)(?=[.:]?(?:[\s"'`,)\]<>;]|$))/gu;
const UNRELEASED = /^## \[Unreleased\][ \t]*$/gmu;
const NEXT_SECTION = /^## /mu;

// SemVer proper (semver.org's regex without its capture groups), not a laxer `\d+.\d+.\d+`: no
// leading zeros in a numeric component or a numeric prerelease identifier, so `01.2.3` is refused
// here rather than at `npm publish`.
export const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type Value = { label: string; value: unknown };
export type Site = {
  file: string;
  // The versions this file states, each labelled with where; empty for the changelog.
  values: Value[];
  // The full text with `version` applied, or undefined after recording why it cannot be.
  rewrite: (version: string) => string | undefined;
  // What `--set` prints for this file once it is written.
  describeChange: (version: string) => string;
};

/** Collected `::error::` lines. Nothing throws out of a read, a parse or a rewrite: it lands here. */
export const problems: string[] = [];
export const problem = (message: string): void => {
  problems.push(message);
};

export const describeValue = (value: unknown): string =>
  value === undefined ? '(no version field)' : JSON.stringify(value);
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length;
export const distinct = (values: Value[]): string =>
  [...new Set(values.map((entry) => String(entry.value)))].join(', ');

/** Readers return undefined after recording why, so one broken file never hides another. */
export const readText = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(join(ROOT, file), 'utf8');
  } catch (error) {
    problem(`${file} could not be read: ${errorMessage(error)}`);
    return undefined;
  }
};

const parseJsonObject = (file: string, text: string): Record<string, unknown> | undefined => {
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    problem(`${file} is not a JSON object`);
  } catch (error) {
    problem(`${file} is not valid JSON: ${errorMessage(error)}`);
  }
  return undefined;
};

// Surgical, not parse-and-serialise, which could reorder keys or restyle indentation: `git diff`
// after a bump must show only the version line. Anything but exactly one matching line is left
// alone, and the result is re-parsed before it is accepted.
const rewriteJson = (file: string, text: string, version: string): string | undefined => {
  const found = text.match(JSON_VERSION_LINE) ?? [];
  if (found.length !== 1) {
    problem(
      `${file} has ${found.length} quoted "version" line(s), expected exactly one — refusing to edit it, fix the file by hand`,
    );
    return undefined;
  }
  const updated = text.replaceAll(
    JSON_VERSION_LINE,
    (_line, prefix: string) => `${prefix}"${version}"`,
  );
  if (parseJsonObject(`${file} (after the edit)`, updated)?.['version'] === version) {
    return updated;
  }
  problem(`${file} would not carry version ${version} after the edit — left untouched`);
  return undefined;
};

const sourceSite = async (): Promise<Site | undefined> => {
  const text = await readText(SOURCE_OF_TRUTH);
  const data = text === undefined ? undefined : parseJsonObject(SOURCE_OF_TRUTH, text);
  if (text === undefined || data === undefined) {
    return undefined;
  }
  const values = [{ label: `${SOURCE_OF_TRUTH} .version`, value: data['version'] }];
  return {
    file: SOURCE_OF_TRUTH,
    values,
    rewrite: (version) => rewriteJson(SOURCE_OF_TRUTH, text, version),
    describeChange: (version) => `${distinct(values)} -> ${version}`,
  };
};

// A pin that is not an exact version is a problem, never rewritten: overwriting `latest` would
// hide the very mistake this script exists to catch.
const pinValues = (file: string, text: string): Value[] | undefined => {
  const values: Value[] = [];
  let usable = true;
  for (const pin of text.matchAll(PIN)) {
    const version = pin.groups?.['version'] ?? '';
    const where = `${file}:${lineOf(text, pin.index)}`;
    if (SEMVER.test(version)) {
      values.push({ label: `${where} @kaisers-io/openapi-mcp pin`, value: version });
    } else {
      problem(
        `${where} pins @kaisers-io/openapi-mcp@${version}, which is not an exact version — pin x.y.z, never a range or dist-tag`,
      );
      usable = false;
    }
  }
  if (usable && values.length === 0 && PINNED_READMES.includes(file)) {
    problem(
      `${file} has no @kaisers-io/openapi-mcp@<version> pin — the host examples must pin one`,
    );
    usable = false;
  }
  return usable ? values : undefined;
};

const doctorValue = (file: string, text: string): Value | undefined => {
  const [line, ...extra] = text.matchAll(CLI_VERSION_LINE);
  if (line !== undefined && extra.length === 0) {
    return {
      label: `${file}:${lineOf(text, line.index)} "cliVersion"`,
      value: line.groups?.['version'],
    };
  }
  problem(
    `${file} has ${extra.length + (line ? 1 : 0)} "cliVersion" line(s), expected exactly one (the --json doctor example)`,
  );
  return undefined;
};

/** A Markdown file's pins, plus the `--json doctor` example's `cliVersion` in docs/configuration.md. */
const docSite = (file: string, text: string): Site | undefined => {
  const pins = pinValues(file, text);
  const doctor = file === DOCTOR_EXAMPLE ? doctorValue(file, text) : undefined;
  if (pins === undefined || (file === DOCTOR_EXAMPLE && doctor === undefined)) {
    return undefined;
  }
  const values = doctor === undefined ? pins : [...pins, doctor];
  if (values.length === 0) {
    return undefined;
  }
  return {
    file,
    values,
    rewrite: (version) =>
      text
        .replaceAll(PIN, (_pin, prefix: string) => `${prefix}${version}`)
        .replaceAll(CLI_VERSION_LINE, (_line, prefix: string) => `${prefix}"${version}"`),
    describeChange: (version) => `${values.length} site(s), ${distinct(values)} -> ${version}`,
  };
};

// The required files plus every other `docs/*.md`. The doctor example is required by name, not
// left to discovery: deleted or renamed, it would otherwise drop its site without a word, and
// reading it is what reports it missing.
const docFiles = async (): Promise<string[]> => {
  const required = [...PINNED_READMES, DOCTOR_EXAMPLE];
  try {
    const names = await readdir(join(ROOT, DOCS_DIR));
    const docs = names.filter((name) => name.endsWith('.md')).map((name) => `${DOCS_DIR}/${name}`);
    return [...new Set([...required, ...docs.toSorted()])];
  } catch (error) {
    problem(`${DOCS_DIR}/ could not be listed: ${errorMessage(error)}`);
    return required;
  }
};

/** UTC, so the date does not depend on the machine's time zone. */
const releaseDate = (): string => new Date().toISOString().slice(0, 10);

// `## [Unreleased]` becomes `## [<version>] - <date>` under a fresh, empty `## [Unreleased]`; nothing
// else moves. Refused when the version already has a heading (a second `--set` would otherwise
// release the fresh, empty section again) or when the section has nothing to release.
const releaseChangelog = (text: string, version: string): string | undefined => {
  if (text.includes(`\n## [${version}] - `)) {
    problem(
      `${CHANGELOG} already has a "## [${version}] - " heading — was ${version} released already?`,
    );
    return undefined;
  }
  const [heading] = text.matchAll(UNRELEASED);
  if (heading === undefined) {
    return undefined; // Already reported by changelogSite.
  }
  const after = heading.index + heading[0].length;
  const rest = text.slice(after);
  if (rest.slice(0, NEXT_SECTION.exec(rest)?.index).trim() === '') {
    problem(
      `${CHANGELOG}'s "## [Unreleased]" section is empty — describe the release before bumping`,
    );
    return undefined;
  }
  return `${text.slice(0, heading.index)}## [Unreleased]\n\n## [${version}] - ${releaseDate()}${rest}`;
};

const describeRelease = (version: string): string =>
  `## [Unreleased] -> ## [${version}] - ${releaseDate()}`;

// `--check` requires the `## [Unreleased]` heading that `--set` will release, never a released
// heading: on a pull request the top section is `## [Unreleased]`. It also requires the packaged
// copy to equal CHANGELOG.md byte for byte, and `--set` writes the same release to both, so a
// bump cannot leave npm users with a changelog that lacks the release it ships in.
const changelogSites = async (): Promise<Site[]> => {
  const text = await readText(CHANGELOG);
  const packaged = await readText(PACKAGED_CHANGELOG);
  if (text === undefined) {
    return [];
  }
  const count = [...text.matchAll(UNRELEASED)].length;
  if (count !== 1) {
    problem(
      `${CHANGELOG} has ${count} "## [Unreleased]" heading(s), expected exactly one for --set to release`,
    );
  }
  if (packaged !== undefined && packaged !== text) {
    problem(
      `${PACKAGED_CHANGELOG} differs from ${CHANGELOG} — the npm package ships it, so it must be a byte-identical copy (cp ${CHANGELOG} ${PACKAGED_CHANGELOG})`,
    );
  }
  if (count !== 1 || packaged !== text) {
    return [];
  }
  // One release text for both files, computed once, so a refusal is reported once.
  const released = new Map<string, string | undefined>();
  const rewrite = (version: string): string | undefined => {
    if (!released.has(version)) {
      released.set(version, releaseChangelog(text, version));
    }
    return released.get(version);
  };
  return [
    { file: CHANGELOG, values: [], rewrite, describeChange: describeRelease },
    { file: PACKAGED_CHANGELOG, values: [], rewrite, describeChange: describeRelease },
  ];
};

/** Every readable site, in write order: the source of truth first, the two changelogs last. */
export const readSites = async (): Promise<Site[]> => {
  const sites = [await sourceSite()];
  for (const file of await docFiles()) {
    const text = await readText(file);
    sites.push(text === undefined ? undefined : docSite(file, text));
  }
  return [
    ...sites.filter((site) => site !== undefined),
    ...(await skillSites()),
    ...(await changelogSites()),
  ];
};

/** The value every other site must equal. Unusable means there is nothing to check against. */
export const expectedFrom = (sites: Site[]): string | undefined => {
  const version = sites.find((site) => site.file === SOURCE_OF_TRUTH)?.values[0]?.value;
  if (typeof version === 'string' && version.length > 0) {
    return version;
  }
  problem(
    `${SOURCE_OF_TRUTH} has no usable .version — found ${describeValue(version)}; without it there is nothing to check the other sites against`,
  );
  return undefined;
};
