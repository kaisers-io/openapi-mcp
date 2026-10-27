// Runs the evaluation scenarios of the agent skills (#72) against a real agent:
//
//   node scripts/skills/evals.ts <claude|codex> <model> [scenario id...]
//
// Each scenario gets a fresh project with the skill installed where the agent reads skills
// (.claude/skills or .agents/skills), the eval specs, and its setup files. `npx` resolves
// @kaisers-io/openapi-mcp to this repository's build through a shim first in PATH, so the
// skill can use commands that are not released yet. Not part of CI: it needs the agent CLI,
// its login, and spends tokens.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const EVALS = join(import.meta.dirname, 'evals');
const BIN = join(ROOT, 'packages', 'cli', 'bin', 'openapi-mcp.mjs');
// The credential every scenario's user has set
const RUN_ENV: Record<string, string> = { SHOP_API_TOKEN: 'Bearer example-token-not-a-secret' };

interface Expect {
  file?: string;
  contains?: string[];
  absent?: string[];
  exposed?: string[];
  transcript?: string[];
}
interface Scenario {
  id: string;
  skill: string;
  host: 'claude-code' | 'codex';
  prompt: string;
  setup?: Record<string, string>;
  expect: Expect;
}

const run = async (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; output: string }> => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const [code] = (await once(child, 'close')) as [number];
  return { code, output };
};

// `npx -y @kaisers-io/openapi-mcp@<this version> ...` runs this repository's CLI; anything else,
// an older version included, goes to the real npx
const writeShim = async (dir: string, realNpx: string, version: string): Promise<void> => {
  const shim = join(dir, 'npx');
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  case "$arg" in',
      `    @kaisers-io/openapi-mcp@${version})`,
      '      while [ "$1" != "$arg" ]; do shift; done; shift',
      `      exec "${process.execPath}" "${BIN}" "$@" ;;`,
      '  esac',
      'done',
      `exec "${realNpx}" "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(shim, 0o755);
};

const prepare = async (scenario: Scenario, version: string): Promise<string> => {
  const project = await mkdtemp(join(tmpdir(), `openapi-mcp-eval-${scenario.id}-`));
  const skillsDir = scenario.host === 'codex' ? '.agents/skills' : '.claude/skills';
  await cp(join(ROOT, 'skills', scenario.skill), join(project, skillsDir, scenario.skill), {
    recursive: true,
  });
  await cp(join(EVALS, 'shop.json'), join(project, 'shop.json'));
  await cp(
    join(ROOT, 'packages', 'cli', 'test', 'fixtures', 'petstore.json'),
    join(project, 'petstore.json'),
  );
  for (const [file, content] of Object.entries(scenario.setup ?? {})) {
    await mkdir(dirname(join(project, file)), { recursive: true });
    await writeFile(join(project, file), content.replaceAll('CURRENT', version));
  }
  return project;
};

const agentArgs = (host: Scenario['host'], model: string, prompt: string): [string, string[]] =>
  host === 'codex'
    ? [
        'codex',
        ['exec', '--model', model, '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt],
      ]
    : ['claude', ['-p', prompt, '--model', model, '--permission-mode', 'bypassPermissions']];

// The tools the written Claude Code entry exposes, from `check` with its own arguments
const exposedBy = async (project: string, configText: string): Promise<string[]> => {
  const config = JSON.parse(configText) as {
    mcpServers: Record<string, { args: string[]; env?: Record<string, string> }>;
  };
  const [entry] = Object.values(config.mcpServers);
  const args = entry?.args ?? [];
  // The entry's env as Claude Code expands it, from the run's own variables
  const expanded = Object.fromEntries(
    Object.entries(entry?.env ?? {}).map(([name, value]) => [
      name,
      value.replaceAll(
        /\$\{(?<variable>\w+)\}/gu,
        (_match, variable: string) => RUN_ENV[variable] ?? '',
      ),
    ]),
  );
  const serve = args.indexOf('serve');
  const { output } = await run(
    process.execPath,
    [BIN, '--json', 'check', ...args.slice(serve + 1)],
    {
      cwd: project,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: project,
        ...RUN_ENV,
        ...expanded,
      },
    },
  );
  const report = JSON.parse(output) as { data: { apis?: { exposed: string[] }[] } };
  return (report.data.apis ?? []).flatMap((api) => api.exposed).toSorted();
};

const verify = async (project: string, transcript: string, expect: Expect): Promise<string[]> => {
  const failures: string[] = [];
  const lower = transcript.toLowerCase();
  for (const text of expect.transcript ?? []) {
    if (!lower.includes(text.toLowerCase())) {
      failures.push(`transcript lacks "${text}"`);
    }
  }
  if (expect.file === undefined) {
    return failures;
  }
  let text: string;
  try {
    text = await readFile(join(project, expect.file), 'utf8');
  } catch {
    return [...failures, `${expect.file} was not written`];
  }
  for (const part of expect.contains ?? []) {
    if (!text.includes(part)) {
      failures.push(`${expect.file} lacks "${part}"`);
    }
  }
  for (const part of expect.absent ?? []) {
    if (text.includes(part)) {
      failures.push(`${expect.file} contains "${part}"`);
    }
  }
  if (expect.exposed !== undefined) {
    const exposed = await exposedBy(project, text);
    if (exposed.join(' ') !== expect.exposed.toSorted().join(' ')) {
      failures.push(`exposes ${exposed.join(' ')}`);
    }
  }
  return failures;
};

const loadScenarios = async (): Promise<Scenario[]> => {
  const data = JSON.parse(await readFile(join(EVALS, 'scenarios.json'), 'utf8')) as {
    scenarios: Scenario[];
  };
  return data.scenarios;
};

const shimPath = async (version: string): Promise<string> => {
  // The npx next to this Node, not the one PATH finds: a version manager's npx shim would
  // resolve npx through PATH again and reach this shim
  const shimDir = await mkdtemp(join(tmpdir(), 'openapi-mcp-eval-bin-'));
  await writeShim(shimDir, join(dirname(process.execPath), 'npx'), version);
  return shimDir;
};

const cliVersion = async (): Promise<string> => {
  const text = await readFile(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8');
  return (JSON.parse(text) as { version: string }).version;
};

// `prepare <id>`: a project and a shim directory for an agent that runs outside this script;
// `verify <id> <project>`: the expectations against that project and its transcript.txt
const manual = async (mode: string, id: string, project: string | undefined): Promise<void> => {
  const scenarios = await loadScenarios();
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`no scenario ${id}`);
  }
  if (mode === 'prepare') {
    const version = await cliVersion();
    const prepared = await prepare(scenario, version);
    const shim = await shimPath(version);
    const prompt = `Use the ${scenario.skill} skill. ${scenario.prompt}`;
    process.stdout.write(`${JSON.stringify({ project: prepared, shim, prompt })}\n`);
    return;
  }
  if (project === undefined) {
    throw new Error('verify needs the project directory');
  }
  const transcript = await readFile(join(project, 'transcript.txt'), 'utf8').catch(() => '');
  const failures = await verify(project, transcript, scenario.expect);
  process.stdout.write(
    `${failures.length === 0 ? 'pass' : 'FAIL'} ${id}\n${failures.map((line) => `  ${line}\n`).join('')}`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
};

const main = async (): Promise<void> => {
  const [agent, model, ...ids] = process.argv.slice(2);
  if ((agent === 'prepare' || agent === 'verify') && model !== undefined) {
    await manual(agent, model, ids[0]);
    return;
  }
  if ((agent !== 'claude' && agent !== 'codex') || model === undefined) {
    process.stderr.write(
      'usage: node scripts/skills/evals.ts <claude|codex> <model> [id...]\n       node scripts/skills/evals.ts prepare <id> | verify <id> <project>\n',
    );
    process.exitCode = 2;
    return;
  }
  const host = agent === 'codex' ? 'codex' : 'claude-code';
  const scenarios = await loadScenarios();
  const version = await cliVersion();
  const shimDir = await shimPath(version);
  const selected = scenarios.filter(
    (scenario) => scenario.host === host && (ids.length === 0 || ids.includes(scenario.id)),
  );
  // A misspelled or other-host scenario must not pass as an empty, green run
  const unknown = ids.filter((id) => !selected.some((scenario) => scenario.id === id));
  if (selected.length === 0 || unknown.length > 0) {
    process.stderr.write(
      `no ${host} scenario ${unknown.length > 0 ? unknown.join(', ') : 'selected'}\n`,
    );
    process.exitCode = 2;
    return;
  }
  let failed = 0;
  for (const scenario of selected) {
    const project = await prepare(scenario, version);
    const prompt = `Use the ${scenario.skill} skill. ${scenario.prompt}`;
    const [command, args] = agentArgs(scenario.host, model, prompt);
    const env = {
      ...process.env,
      PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
      ...RUN_ENV,
    };
    const result = await run(command, args, { cwd: project, env });
    await writeFile(join(project, 'transcript.txt'), result.output);
    const failures = [
      ...(result.code === 0 ? [] : [`the agent exited with ${String(result.code)}`]),
      ...(await verify(project, result.output, scenario.expect)),
    ];
    failed += failures.length === 0 ? 0 : 1;
    process.stdout.write(
      `${failures.length === 0 ? 'pass' : 'FAIL'} ${scenario.id} (${agent} ${model}) ${project}\n${failures.map((line) => `  ${line}\n`).join('')}`,
    );
  }
  process.exitCode = failed === 0 ? 0 : 1;
};

await main();
