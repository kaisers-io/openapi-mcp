// Keeps the agent skills under skills/ complete and consistent (#72).
//
//   node scripts/skills/skills.ts sync    copy the shared references into each skill and
//                                         write references/options.md from --json help
//   node scripts/skills/skills.ts check   fail when a skill breaks a rule below, or when
//                                         sync would change a file
//
// Each skill is installed on its own (`npx skills add ... --skill <name>`), so every file it
// reads must be inside its own directory: shared references are copies, not links.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ALLOWED_KEYS, checkText, frontmatterOf, NAME, REFERENCE } from './rules.ts';
import type { Lookup } from './rules.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SKILLS = join(ROOT, 'skills');
const SHARED = join(SKILLS, '_shared', 'references');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'index.ts');

interface Skill {
  name: string;
  dir: string;
}

// Every file the checks read, loaded once: the skills, the repository docs they link, and
// the CLI's own description of its options
const files = new Map<string, string>();
let skillList: Skill[] = [];
let help: HelpCommand | undefined;

const read = (path: string): string => {
  const text = files.get(path);
  if (text === undefined) {
    throw new Error(`${path} was not loaded`);
  }
  return text;
};

const exists = (path: string): boolean => files.has(path);

// The loaded files directly in `dir`, by name (native separators, so Windows too)
const listDir = (dir: string): string[] =>
  [...files.keys()]
    .filter((path) => dirname(path) === dir)
    .map((path) => basename(path))
    .toSorted();

const skills = (): Skill[] => skillList;

const lookup: Lookup = { root: ROOT, exists, read };

const runCli = async (args: readonly string[]): Promise<string> => {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  const [code] = (await once(child, 'close')) as [number];
  if (code !== 0) {
    throw new Error(`openapi-mcp ${args.join(' ')} exited with ${String(code)}`);
  }
  return output;
};

const load = async (): Promise<void> => {
  const entries = await readdir(SKILLS, { recursive: true, withFileTypes: true });
  const docs = await readdir(join(ROOT, 'docs'));
  const paths = [
    ...entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)),
    join(ROOT, 'README.md'),
    join(ROOT, 'CHANGELOG.md'),
    join(ROOT, 'packages', 'cli', 'package.json'),
    join(ROOT, 'scripts', 'inspector', 'package.json'),
    ...docs.filter((name) => name.endsWith('.md')).map((name) => join(ROOT, 'docs', name)),
  ];
  await Promise.all(
    paths.map(async (path) => {
      files.set(path, await readFile(path, 'utf8'));
    }),
  );
  skillList = entries
    .filter(
      (entry) => entry.isDirectory() && entry.parentPath === SKILLS && !entry.name.startsWith('_'),
    )
    .map((entry) => ({ name: entry.name, dir: join(SKILLS, entry.name) }))
    .toSorted((first, second) => first.name.localeCompare(second.name));
  const output = await runCli(['--json', 'help']);
  ({ data: help } = JSON.parse(output) as { data: HelpCommand });
};

const cliVersion = (): string =>
  (JSON.parse(read(join(ROOT, 'packages', 'cli', 'package.json'))) as { version: string }).version;

interface HelpOption {
  flags: string;
  long: string;
  description: string;
  default?: unknown;
  bareValue?: unknown;
  repeatable: boolean;
  choices?: string[];
  perApi?: string;
}
interface HelpCommand {
  name: string;
  options: HelpOption[];
  commands: HelpCommand[];
}

const cell = (text: string): string => text.replaceAll('|', String.raw`\|`);

const optionsTable = (command: HelpCommand): string[] => [
  '| Flag | Default | Values | Repeatable | With --api | Meaning |',
  '|---|---|---|---|---|---|',
  ...command.options.map((option) => {
    const fallback =
      option.default === undefined || (Array.isArray(option.default) && option.default.length === 0)
        ? ''
        : `\`${JSON.stringify(option.default)}\``;
    const bare = option.bareValue === undefined ? '' : ` (alone: \`${String(option.bareValue)}\`)`;
    return `| \`${cell(option.flags)}\` | ${fallback}${bare} | ${cell((option.choices ?? []).join(', '))} | ${option.repeatable ? 'yes' : ''} | ${option.perApi ?? ''} | ${cell(option.description)} |`;
  }),
];

// The options reference, generated from the CLI the repository builds
const optionsReference = (): string => {
  const serve = help?.commands.find((command) => command.name === 'serve');
  if (serve === undefined) {
    throw new Error('--json help lists no serve command');
  }
  return [
    '# Options',
    '',
    'Every option of `serve` and `check` in the version `metadata.version` names, generated from',
    '`openapi-mcp --json help`. `tools` takes the spec and filter options among them. Run',
    '`CLI --json help` for the version in use. "With --api": `prefix` takes `<api>=` before the',
    'value, `prefix-or-all` applies to every API without one, `enable` is set with',
    '`--enable <api>=<switch>`.',
    '',
    '## Contents',
    '',
    '- [serve and check](#serve-and-check)',
    '',
    '## serve and check',
    '',
    ...optionsTable(serve),
    '',
  ].join('\n');
};

const sourcesReference = (): string =>
  [
    '# Sources',
    '',
    'The files of this skill were checked against the openapi-mcp version that',
    '`metadata.version` in SKILL.md names, and the repository docs of that version. The options file is generated from',
    '`openapi-mcp --json help`; the host and credential files cite the vendor page for each',
    'fact. When `CLI --json help` of the version in use differs from the options file, read',
    'the docs at that version.',
    '',
  ].join('\n');

// Every file sync writes, per skill
const expectedFiles = (skill: Skill): Map<string, string> => {
  const expected = new Map<string, string>();
  for (const name of listDir(SHARED)) {
    expected.set(join(skill.dir, 'references', name), read(join(SHARED, name)));
  }
  expected.set(join(skill.dir, 'references', 'options.md'), optionsReference());
  expected.set(join(skill.dir, 'references', 'sources.md'), sourcesReference());
  return expected;
};

const sync = async (): Promise<void> => {
  await Promise.all(
    skills().flatMap((skill) =>
      [...expectedFiles(skill)].map(async ([path, content]) => writeFile(path, content)),
    ),
  );
};

// The MCP Inspector version the skills tell agents to run is the one CI tests with
const INSPECTOR_PIN = /@modelcontextprotocol\/inspector@(?<version>[^\s`'"]+)/gu;

const inspectorVersion = (): string => {
  const manifest = JSON.parse(read(join(ROOT, 'scripts', 'inspector', 'package.json'))) as {
    devDependencies: Record<string, string>;
  };
  return manifest.devDependencies['@modelcontextprotocol/inspector'] ?? '';
};

const checkInspectorPins = (path: string, text: string, problems: string[]): void => {
  for (const match of text.matchAll(INSPECTOR_PIN)) {
    const version = match.groups?.['version'];
    if (version !== inspectorVersion()) {
      problems.push(
        `${path}: runs @modelcontextprotocol/inspector@${String(version)}, but scripts/inspector pins ${inspectorVersion()}`,
      );
    }
  }
};

const checkSkill = (skill: Skill, problems: string[]): void => {
  const skillPath = join(skill.dir, 'SKILL.md');
  const text = read(skillPath);
  const { data, body } = frontmatterOf(text);
  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) {
      problems.push(
        `${skillPath}: frontmatter key "${key}" is not in the Agent Skills specification`,
      );
    }
  }
  const { name, description, compatibility, metadata } = data;
  if (name !== skill.name || !NAME.test(skill.name) || skill.name.length > 64) {
    problems.push(`${skillPath}: name must equal the directory name and match ${String(NAME)}`);
  }
  if (typeof description !== 'string' || description.length === 0 || description.length > 1024) {
    problems.push(`${skillPath}: description must have 1 to 1,024 characters`);
  }
  if (typeof compatibility === 'string' && compatibility.length > 500) {
    problems.push(`${skillPath}: compatibility must have at most 500 characters`);
  }
  if (typeof metadata !== 'object' || metadata['version'] !== cliVersion()) {
    problems.push(`${skillPath}: metadata.version must equal the CLI version ${cliVersion()}`);
  }
  if (text.split('\n').length > 500) {
    problems.push(`${skillPath}: more than 500 lines`);
  }
  if (!exists(join(skill.dir, 'agents', 'openai.yaml'))) {
    problems.push(`${skill.dir}: agents/openai.yaml is missing`);
  }
  checkText(lookup, skillPath, body, problems);
  const linked = new Set(body.match(REFERENCE));
  const references = listDir(join(skill.dir, 'references')).map((file) => `references/${file}`);
  for (const file of references) {
    if (!linked.has(file)) {
      problems.push(`${skillPath}: does not link ${file}`);
    }
  }
  for (const file of linked) {
    if (!references.includes(file)) {
      problems.push(`${skillPath}: links ${file}, which does not exist`);
    }
  }
  for (const file of references) {
    const path = join(skill.dir, file);
    const reference = read(path);
    checkText(lookup, path, reference, problems);
    checkInspectorPins(path, reference, problems);
    const others = (reference.match(REFERENCE) ?? []).filter((link) => link !== file);
    if (others.length > 0 || /\]\((?!https?:)[^)]*\.md/u.test(reference)) {
      problems.push(`${path}: links another reference file; link it from SKILL.md instead`);
    }
    if (reference.split('\n').length > 100 && !reference.includes('## Contents')) {
      problems.push(`${path}: over 100 lines without a "## Contents" section`);
    }
  }
  for (const [path, content] of expectedFiles(skill)) {
    if (!exists(path) || read(path) !== content) {
      problems.push(`${path}: out of date; run node scripts/skills/skills.ts sync`);
    }
  }
};

const check = (): void => {
  const problems: string[] = [];
  for (const skill of skills()) {
    checkSkill(skill, problems);
  }
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `skills: ${skills()
      .map((skill) => basename(skill.dir))
      .join(', ')} ok\n`,
  );
};

const [mode] = process.argv.slice(2);
if (mode === 'sync') {
  await load();
  await sync();
} else if (mode === 'check') {
  await load();
  check();
} else {
  process.stderr.write('usage: node scripts/skills/skills.ts sync|check\n');
  process.exitCode = 2;
}
