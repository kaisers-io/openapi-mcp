// Runs one prompt through an agent CLI (Claude Code or Codex) with only the
// MCP server under test, and reads the answer, the tool calls and the token
// usage from the CLI's JSON event stream.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const CLI = path.resolve(import.meta.dirname, '../../packages/cli/bin/openapi-mcp.mjs');
const SERVE_LOG = path.resolve(import.meta.dirname, 'serve-log.ts');

// The server command: serve-log.ts writes its call records next to the run
const serverArgs = (cwd: string, serveArgs: string[]) => [
  SERVE_LOG,
  path.join(cwd, 'calls.log'),
  CLI,
  'serve',
  ...serveArgs,
];

// The API requests the server sent in a run, by operation: every call record
// with an upstream status, also the calls inside an execute_code program
const apiRequestsOf = async (cwd: string): Promise<string[]> => {
  let text = '';
  try {
    text = await readFile(path.join(cwd, 'calls.log'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const record = JSON.parse(line) as { event?: string; tool?: string; status?: number };
      return record.event === 'tool_call' && record.status !== undefined
        ? [String(record.tool)]
        : [];
    } catch {
      return [];
    }
  });
};

export interface AgentOptions {
  model: string | undefined;
  maxTurns: string;
  // Environment variables the MCP server needs (a real API's token), by name.
  // Claude Code passes its own environment to the server; Codex only these.
  env: string[];
}
interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export interface AgentResult {
  answer: string;
  toolCalls: string[];
  // The API requests the server sent (serve-log.ts)
  apiRequests: string[];
  turns?: number | undefined;
  usage: Usage;
  costUsd?: number | undefined;
  error?: string;
}
// The fields read from the event streams of both CLIs
interface AgentEvent {
  type?: string;
  message?: { content?: { type?: string; name?: string }[] };
  item?: { type?: string; text?: string; tool?: string };
  usage?: Record<string, number | undefined>;
  result?: unknown;
  num_turns?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  subtype?: string;
}

const run = async (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);
  const [code] = (await once(child, 'close')) as [number | null];
  clearTimeout(timer);
  return { stdout, stderr, code };
};

const lines = (text: string) =>
  text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as AgentEvent];
    } catch {
      return [];
    }
  });

export const claude = async (
  prompt: string,
  serveArgs: string[],
  cwd: string,
  options: AgentOptions,
): Promise<AgentResult> => {
  const config = path.join(cwd, 'mcp.json');
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: { api: { command: process.execPath, args: serverArgs(cwd, serveArgs) } },
    }),
  );
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    config,
    '--strict-mcp-config',
    // Read and Grep only: Claude Code stores a large tool result in a file
    // and tells the model to read it from there
    '--tools',
    'Read,Grep',
    '--allowedTools',
    'mcp__api',
    'Read',
    'Grep',
    '--setting-sources',
    '',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--no-session-persistence',
    '--max-turns',
    options.maxTurns,
    ...(options.model ? ['--model', options.model] : []),
  ];
  // A large spec (GitHub's is 14 MB) takes a few seconds to load cold
  const { stdout, stderr } = await run('claude', args, cwd, 10 * 60_000, {
    ...process.env,
    MCP_TIMEOUT: '120000',
  });
  const events = lines(stdout);
  const toolCalls = events
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((content) => content.type === 'tool_use')
    .map((content) => String(content.name).replace(/^mcp__api__/u, ''));
  const result = events.findLast((event) => event.type === 'result');
  const reported = result?.usage ?? {};
  return {
    answer: String(result?.result ?? ''),
    toolCalls,
    apiRequests: await apiRequestsOf(cwd),
    turns: result?.num_turns,
    usage: {
      input: reported['input_tokens'] ?? 0,
      cacheRead: reported['cache_read_input_tokens'] ?? 0,
      cacheWrite: reported['cache_creation_input_tokens'] ?? 0,
      output: reported['output_tokens'] ?? 0,
    },
    costUsd: result?.total_cost_usd,
    ...(result && !result.is_error ? {} : { error: String(result?.subtype ?? stderr.slice(-500)) }),
  };
};

const toml = (value: unknown) => JSON.stringify(value);

export const codex = async (
  prompt: string,
  serveArgs: string[],
  cwd: string,
  options: AgentOptions,
): Promise<AgentResult> => {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    // Only the MCP server under test: no connectors from the account (a
    // built-in GitHub app answered GitHub tasks), plugins, web search,
    // browser, computer use or sub-agents
    ...[
      'apps',
      'plugins',
      'browser_use',
      'computer_use',
      'in_app_browser',
      'multi_agent',
      'image_generation',
    ].flatMap((feature) => ['--disable', feature]),
    '-c',
    'web_search="disabled"',
    '-c',
    `mcp_servers.api.command=${toml(process.execPath)}`,
    '-c',
    `mcp_servers.api.args=${toml(serverArgs(cwd, serveArgs))}`,
    '-c',
    'approval_policy="never"',
    '-c',
    'mcp_servers.api.default_tools_approval_mode="approve"',
    // A large spec (GitHub's is 14 MB) takes a few seconds to load cold
    '-c',
    'mcp_servers.api.startup_timeout_sec=120',
    '-c',
    `mcp_servers.api.env_vars=${toml(options.env)}`,
    ...(options.model ? ['--model', options.model] : []),
    prompt,
  ];
  // A fresh CODEX_HOME with only the login, so no user skills, rules or
  // instructions reach the model
  const home = path.join(cwd, 'codex-home');
  await mkdir(home);
  const userHome = process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex');
  await symlink(path.join(userHome, 'auth.json'), path.join(home, 'auth.json'));
  const { stdout, stderr } = await run('codex', args, cwd, 10 * 60_000, {
    ...process.env,
    CODEX_HOME: home,
    HOME: cwd,
  });
  const events = lines(stdout);
  const items = events
    .filter((event) => event.type === 'item.completed')
    .map((event) => event.item!);
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const turn of events.filter((event) => event.type === 'turn.completed')) {
    usage.input += (turn.usage?.['input_tokens'] ?? 0) - (turn.usage?.['cached_input_tokens'] ?? 0);
    usage.cacheRead += turn.usage?.['cached_input_tokens'] ?? 0;
    usage.output += turn.usage?.['output_tokens'] ?? 0;
  }
  const failed = events.find((event) => event.type === 'turn.failed' || event.type === 'error');
  let error: string | undefined;
  if (failed) {
    error = JSON.stringify(failed).slice(0, 500);
  } else if (!stdout) {
    error = stderr.slice(-500);
  }
  return {
    answer: items
      .filter((item) => item.type === 'agent_message')
      .map((item) => String(item.text))
      .join('\n'),
    toolCalls: items
      .filter((item) => item.type === 'mcp_tool_call')
      .map((item) => String(item.tool)),
    apiRequests: await apiRequestsOf(cwd),
    usage,
    ...(error === undefined ? {} : { error }),
  };
};
