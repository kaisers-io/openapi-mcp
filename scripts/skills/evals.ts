// Runs the evaluation scenarios of the agent skills (#72) against a real agent:
//
//   node scripts/skills/evals.ts <claude|codex> <model> [scenario id...]
//
// Each scenario gets a fresh project with the skill installed where the agent reads skills
// (.claude/skills or .agents/skills), the eval specs, and its setup files. `npx` resolves
// @kaisers-io/openapi-mcp to this repository's build through a shim first in PATH, so the
// skill can use commands that are not released yet. The bin prefers dist/, so the runner
// rebuilds (`pnpm build`) before anything else: a stale build would grade the previous code.
// Not part of CI: it needs the agent CLI, its login, and spends tokens.
//
// `--runs N` plays each scenario N times, each in a fresh project, and prints a pass count per
// scenario. The default is 3 for a full run and 1 when scenario ids are given, for iteration.
// A run's transcript.txt holds everything the agent printed; the graders read only its final
// reply (stdout, also saved as reply.txt). The graders live in grade.ts and are tested offline
// by evals.test.ts.

import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RUN_ENV, parseClaudeStream, readReply, run, verify } from './grade.ts';
import { writeShim } from './server.ts';
import type { Scenario } from './grade.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const EVALS = join(import.meta.dirname, 'evals');
const BIN = join(ROOT, 'packages', 'cli', 'bin', 'openapi-mcp.mjs');
const FULL_RUNS = 3;

// The files a scenario's setup writes, with CURRENT replaced by this checkout's version
const setupFiles = (scenario: Scenario, version: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(scenario.setup ?? {}).map(([file, content]) => [
      file,
      content.replaceAll('CURRENT', version),
    ]),
  );

const prepare = async (scenario: Scenario, version: string): Promise<string> => {
  const project = await mkdtemp(join(tmpdir(), `openapi-mcp-eval-${scenario.id}-`));
  const skillsDir = scenario.host === 'codex' ? '.agents/skills' : '.claude/skills';
  await cp(join(ROOT, 'skills', scenario.skill), join(project, skillsDir, scenario.skill), {
    recursive: true,
  });
  await cp(join(EVALS, scenario.spec ?? 'shop.json'), join(project, 'shop.json'));
  await cp(
    join(ROOT, 'packages', 'cli', 'test', 'fixtures', 'petstore.json'),
    join(project, 'petstore.json'),
  );
  for (const [file, content] of Object.entries(setupFiles(scenario, version))) {
    await mkdir(dirname(join(project, file)), { recursive: true });
    await writeFile(join(project, file), content);
  }
  return project;
};

const agentArgs = (host: Scenario['host'], model: string, prompt: string): [string, string[]] =>
  host === 'codex'
    ? [
        'codex',
        ['exec', '--model', model, '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt],
      ]
    : [
        'claude',
        [
          '-p',
          prompt,
          '--model',
          model,
          '--permission-mode',
          'bypassPermissions',
          // Only the project's settings: the user's own plugins, hooks, MCP servers, rules and
          // globally installed skills (an older copy of the skill under test among them) stay
          // out of the run
          '--setting-sources',
          'project,local',
          // Every tool call and its result, for the transcript; the reply is the `result` event
          '--output-format',
          'stream-json',
          '--verbose',
        ],
      ];

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
  await writeShim(shimDir, { cli: BIN, version, realNpx: join(dirname(process.execPath), 'npx') });
  return shimDir;
};

const cliVersion = async (): Promise<string> => {
  const text = await readFile(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8');
  return (JSON.parse(text) as { version: string }).version;
};

// The bin runs dist/ whenever it exists, so every run rebuilds first: a run after a source change
// would otherwise grade the previous build
const build = async (): Promise<void> => {
  const result = await run('pnpm', ['build'], { cwd: ROOT, env: process.env });
  if (result.code !== 0) {
    throw new Error(
      `pnpm build failed (exit ${String(result.code)}):\n${result.stderr}${result.stdout}`,
    );
  }
};

// `prepare <id>`: a project and a shim directory for an agent that runs outside this script;
// `verify <id> <project>`: the expectations against that project and the agent's final reply,
// saved by hand as reply.txt (or transcript.txt when it holds only the reply)
const manual = async (mode: string, id: string, project: string | undefined): Promise<void> => {
  const scenarios = await loadScenarios();
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`no scenario ${id}`);
  }
  if (mode === 'prepare') {
    await build();
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
  const reply = await readReply(project);
  const setup = setupFiles(scenario, await cliVersion());
  const failures = await verify(project, reply, scenario.expect, { cli: BIN, setup });
  process.stdout.write(
    `${failures.length === 0 ? 'pass' : 'FAIL'} ${id}\n${failures.map((line) => `  ${line}\n`).join('')}`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
};

// `--runs N` anywhere in the arguments; the rest are the agent, the model and scenario ids
const parseArgs = (argv: string[]): { positional: string[]; runs: number | undefined } => {
  const at = argv.indexOf('--runs');
  if (at === -1) {
    return { positional: argv, runs: undefined };
  }
  const runs = Number(argv[at + 1]);
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error('--runs needs a whole number of at least 1');
  }
  return { positional: argv.filter((_arg, index) => index !== at && index !== at + 1), runs };
};

// Codex runs commands in a sandbox that may write only the project, so the CLI's spec cache under
// HOME would fail with EPERM and the agent could not use the CLI at all. Its HOME is a directory
// inside the project instead; CODEX_HOME keeps the login and config. That HOME also keeps the
// user's own skills out of the run, so the agent sees only the skill under test.
const codexHome = async (scenario: Scenario, project: string): Promise<Record<string, string>> => {
  if (scenario.host !== 'codex') {
    return {};
  }
  const home = join(project, '.home');
  await mkdir(home, { recursive: true });
  return {
    HOME: home,
    CODEX_HOME: process.env['CODEX_HOME'] ?? join(homedir(), '.codex'),
  };
};

// One run of one scenario in a fresh project: the failures, empty when it passed
const playOnce = async (
  scenario: Scenario,
  model: string,
  context: { version: string; shimDir: string },
): Promise<{ project: string; failures: string[] }> => {
  const project = await prepare(scenario, context.version);
  const prompt = `Use the ${scenario.skill} skill. ${scenario.prompt}`;
  const [command, args] = agentArgs(scenario.host, model, prompt);
  const env = {
    ...process.env,
    PATH: `${context.shimDir}:${process.env['PATH'] ?? ''}`,
    ...RUN_ENV,
    ...(await codexHome(scenario, project)),
  };
  const result = await run(command, args, { cwd: project, env });
  const { reply, transcript } =
    scenario.host === 'codex'
      ? { reply: result.stdout, transcript: `${result.stderr}${result.stdout}` }
      : parseClaudeStream(result.stdout);
  await writeFile(join(project, 'transcript.txt'), `${result.stderr}${transcript}`);
  await writeFile(join(project, 'reply.txt'), reply);
  const failures = [
    ...(result.code === 0 ? [] : [`the agent exited with ${String(result.code)}`]),
    ...(await verify(project, reply, scenario.expect, {
      cli: BIN,
      setup: setupFiles(scenario, context.version),
    })),
  ];
  return { project, failures };
};

const main = async (): Promise<void> => {
  const { positional, runs } = parseArgs(process.argv.slice(2));
  const [agent, model, ...ids] = positional;
  if ((agent === 'prepare' || agent === 'verify') && model !== undefined) {
    await manual(agent, model, ids[0]);
    return;
  }
  if ((agent !== 'claude' && agent !== 'codex') || model === undefined) {
    process.stderr.write(
      'usage: node scripts/skills/evals.ts <claude|codex> <model> [id...] [--runs N]\n       node scripts/skills/evals.ts prepare <id> | verify <id> <project>\n',
    );
    process.exitCode = 2;
    return;
  }
  const host = agent === 'codex' ? 'codex' : 'claude-code';
  const scenarios = await loadScenarios();
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
  await build();
  const version = await cliVersion();
  const context = { version, shimDir: await shimPath(version) };
  const count = runs ?? (ids.length === 0 ? FULL_RUNS : 1);
  const scores: string[] = [];
  const boundary: string[] = [];
  let allPassed = true;
  for (const scenario of selected) {
    let passed = 0;
    for (let index = 1; index <= count; index += 1) {
      const { project, failures } = await playOnce(scenario, model, context);
      passed += failures.length === 0 ? 1 : 0;
      process.stdout.write(
        `${failures.length === 0 ? 'pass' : 'FAIL'} ${scenario.id} run ${String(index)}/${String(count)} (${agent} ${model}) ${project}\n${failures.map((line) => `  ${line}\n`).join('')}`,
      );
    }
    allPassed &&= passed === count;
    const line = `${scenario.id} (${agent} ${model}): ${String(passed)}/${String(count)} passed`;
    (scenario.boundary === true ? boundary : scores).push(line);
  }
  // The hostile-content scenarios are read on their own: a run that obeyed planted text is not
  // offset by a good score elsewhere
  if (scores.length > 0) {
    process.stdout.write(`\n${scores.join('\n')}\n`);
  }
  if (boundary.length > 0) {
    process.stdout.write(`\nhostile content (read on their own):\n${boundary.join('\n')}\n`);
  }
  process.exitCode = allPassed ? 0 : 1;
};

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
