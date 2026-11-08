// The graders of the skill evals (scripts/skills/evals.ts), with no agent in them, so
// scripts/skills/evals.test.ts can run every scenario's graders against crafted right and wrong
// runs in `pnpm check`.
//
// Each grader is deterministic: a substring that must or must not occur, or the tool list the
// written config exposes, computed by the CLI's own `check`. There is no judge model. The limit
// that comes with it: a reply check sees words, not meaning, so a reply that names the expected
// fix only to reject it still passes. That is why a failing run is read before it counts, and
// why a passing score is no substitute for reading a sample of replies.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The credential every scenario's user has set
export const RUN_ENV: Record<string, string> = {
  SHOP_API_TOKEN: 'Bearer example-token-not-a-secret',
};

export interface Expect {
  // A file the agent must write, relative to the project
  file?: string;
  // Substrings that file must contain
  contains?: string[];
  // Substrings that file must not contain, such as a token written literally
  absent?: string[];
  // The tools the Claude Code entry in `file` must expose, exactly
  exposed?: string[];
  // Substrings the agent's final reply must contain, ignoring letter case. The reply is what the
  // agent printed to stdout, not its intermediate steps: a word in a file the agent read, or in
  // its own plan, would pass a check on the whole log.
  transcript?: string[];
}

export interface Scenario {
  id: string;
  skill: string;
  host: 'claude-code' | 'codex';
  prompt: string;
  setup?: Record<string, string>;
  expect: Expect;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const run = async (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RunResult> => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
};

// The final reply of a run in `project`: reply.txt when it exists, even empty, so that an empty
// reply is never replaced by a transcript that holds the agent's intermediate steps;
// transcript.txt only for a run saved by hand without reply.txt
export const readReply = async (project: string): Promise<string> => {
  const hasReply = await access(join(project, 'reply.txt')).then(
    () => true,
    () => false,
  );
  const file = hasReply ? 'reply.txt' : 'transcript.txt';
  return readFile(join(project, file), 'utf8').catch(() => '');
};

// The tools the written Claude Code entry exposes, from `check` with its own arguments. `cli` is
// the module Node runs as openapi-mcp: the bin for a real run, the source in the self-tests.
const exposedBy = async (project: string, configText: string, cli: string): Promise<string[]> => {
  const config = JSON.parse(configText) as {
    mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const [entry] = Object.values(config.mcpServers);
  const args = entry?.args ?? [];
  const serve = args.indexOf('serve');
  // What the host runs: an entry it cannot start, or that starts another package, exposes
  // nothing, whatever its arguments say
  const ours = args
    .slice(0, Math.max(serve, 0))
    .some((arg) => arg.startsWith('@kaisers-io/openapi-mcp@'));
  if (entry?.command !== 'npx' || serve === -1 || !ours) {
    return [];
  }
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
  const { stdout } = await run(
    process.execPath,
    [cli, '--json', 'check', ...args.slice(serve + 1)],
    {
      cwd: project,
      env: { PATH: process.env['PATH'] ?? '', HOME: project, ...RUN_ENV, ...expanded },
    },
  );
  const report = JSON.parse(stdout) as { data: { apis?: { exposed: string[] }[] } };
  return (report.data.apis ?? []).flatMap((api) => api.exposed).toSorted();
};

const checkFile = async (
  project: string,
  expect: Expect & { file: string },
  cli: string,
): Promise<string[]> => {
  let text: string;
  try {
    text = await readFile(join(project, expect.file), 'utf8');
  } catch {
    return [`${expect.file} was not written`];
  }
  const failures = [
    ...(expect.contains ?? [])
      .filter((part) => !text.includes(part))
      .map((part) => `${expect.file} lacks "${part}"`),
    ...(expect.absent ?? [])
      .filter((part) => text.includes(part))
      .map((part) => `${expect.file} contains "${part}"`),
  ];
  if (expect.exposed !== undefined) {
    const exposed = await exposedBy(project, text, cli).catch(() => ['(check failed)']);
    if (exposed.join(' ') !== expect.exposed.toSorted().join(' ')) {
      failures.push(`exposes ${exposed.join(' ')}`);
    }
  }
  return failures;
};

// Every expectation that does not hold, as one line each; none means the run passed
export const verify = async (
  project: string,
  reply: string,
  expect: Expect,
  cli: string,
): Promise<string[]> => {
  const lower = reply.toLowerCase();
  const failures = (expect.transcript ?? [])
    .filter((text) => !lower.includes(text.toLowerCase()))
    .map((text) => `reply lacks "${text}"`);
  if (expect.file === undefined) {
    return failures;
  }
  return [...failures, ...(await checkFile(project, { ...expect, file: expect.file }, cli))];
};
