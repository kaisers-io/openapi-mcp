// Starts the MCP server a written host config describes, the way the host would, and lists its
// tools over stdio. The `exposed` grader uses it for Claude Code (.mcp.json) and Codex
// (.codex/config.toml) alike, so a config passes only when its command, arguments and environment
// actually start this checkout's openapi-mcp.
//
// `npx` resolves to a shim first in PATH that runs this checkout's CLI for
// `@kaisers-io/openapi-mcp@<this version>`. The runner's shim hands every other package to the real
// npx, for the agent; the graders' shim refuses it, so a config that starts another package or
// another version exposes nothing, and no grader run reaches the registry. POSIX only, like the
// runner: the shim is a shell script.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseToml } from 'smol-toml';

// The server's own tools, which every config exposes besides the operations
const OWN_TOOLS = new Set([
  'openapi_mcp_status',
  'execute_code',
  'search_operations',
  'describe_operation',
  'call_operation',
]);
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5000;

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// `npx -y @kaisers-io/openapi-mcp@<version> ...` runs `cli` with Node. Anything else goes to
// `realNpx`, or fails when there is none.
export const writeShim = async (
  dir: string,
  options: { cli: string; version: string; realNpx?: string },
): Promise<void> => {
  const shim = join(dir, 'npx');
  const fallback =
    options.realNpx === undefined
      ? 'echo "npx: only this checkout\'s openapi-mcp can start here" >&2; exit 127'
      : `exec "${options.realNpx}" "$@"`;
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  case "$arg" in',
      `    @kaisers-io/openapi-mcp@${options.version})`,
      '      while [ "$1" != "$arg" ]; do shift; done; shift',
      `      exec "${process.execPath}" "${options.cli}" "$@" ;;`,
      '  esac',
      'done',
      fallback,
      '',
    ].join('\n'),
  );
  await chmod(shim, 0o755);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const stringRecord = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};

// The first server of a written config, with the environment the host gives it. Claude Code passes
// its own environment and expands `${VAR}` in `env`; Codex passes only the variables `env_vars`
// names, plus its `env` table.
export const entryOf = (
  file: string,
  text: string,
  runEnv: Record<string, string>,
): ServerEntry | undefined => {
  if (file.endsWith('.toml')) {
    const config = parseToml(text) as Record<string, unknown>;
    const servers = isRecord(config['mcp_servers']) ? Object.values(config['mcp_servers']) : [];
    const server = servers.find((candidate) => isRecord(candidate));
    if (server === undefined || typeof server['command'] !== 'string') {
      return undefined;
    }
    const passed = strings(server['env_vars']).filter((name) => runEnv[name] !== undefined);
    return {
      command: server['command'],
      args: strings(server['args']),
      env: {
        ...Object.fromEntries(passed.map((name) => [name, runEnv[name] ?? ''])),
        ...stringRecord(server['env']),
      },
    };
  }
  const config = JSON.parse(text) as Record<string, unknown>;
  const servers = isRecord(config['mcpServers']) ? Object.values(config['mcpServers']) : [];
  const server = servers.find((candidate) => isRecord(candidate));
  if (server === undefined || typeof server['command'] !== 'string') {
    return undefined;
  }
  const expanded = Object.entries(stringRecord(server['env'])).map(([name, value]) => [
    name,
    value.replaceAll(
      /\$\{(?<variable>\w+)\}/gu,
      (_match, variable: string) => runEnv[variable] ?? '',
    ),
  ]);
  return {
    command: server['command'],
    args: strings(server['args']),
    env: { ...runEnv, ...Object.fromEntries(expanded) },
  };
};

const request = (id: number, method: string, params: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

// Kills the server and everything it started: a wrapper's child can keep stdout open after the
// wrapper itself is gone. The server runs in a process group of its own (`detached`), so the group
// receives the signal.
const killGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already
  }
};

// The operation tools the server lists after an MCP initialize over stdio, sorted. `timeoutMs`
// bounds the whole exchange; `stopMs` bounds the wait for a clean exit after SIGTERM, after which
// the group is killed. Neither a server that ignores SIGTERM nor a child that keeps the pipe open
// can hold the graders past these deadlines.
export const listTools = async (
  entry: ServerEntry,
  options: { cwd: string; home: string; shimDir: string; timeoutMs?: number; stopMs?: number },
): Promise<string[]> => {
  const child = spawn(entry.command, entry.args, {
    cwd: options.cwd,
    env: {
      PATH: `${options.shimDir}:${process.env['PATH'] ?? ''}`,
      HOME: options.home,
      ...entry.env,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });
  // A command that cannot start ends stdout at once, which the loop below reports
  child.on('error', () => {
    // Reported through the closed stdout
  });
  // A server that exits or closes stdin before it reads the requests makes the writes fail with
  // EPIPE; that, too, is reported through the closed stdout
  child.stdin.on('error', () => {
    // Reported through the closed stdout
  });
  const exited = (async (): Promise<void> => {
    try {
      await once(child, 'exit');
    } catch {
      // The command did not start; nothing to wait for
    }
  })();
  const lines = createInterface({ input: child.stdout });
  // Closing the interface ends the read loop below; killing the group alone would not, while a
  // child the kill missed still held the pipe
  const timer = setTimeout(() => {
    killGroup(child.pid, 'SIGKILL');
    lines.close();
  }, options.timeoutMs ?? START_TIMEOUT_MS);
  try {
    child.stdin.write(
      request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'openapi-mcp-skill-evals', version: '1' },
      }),
    );
    for await (const line of lines) {
      const message = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
      if (message.id === 1) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
        child.stdin.write(request(2, 'tools/list'));
      } else if (message.id === 2) {
        return (message.result?.tools ?? [])
          .map((tool) => tool.name)
          .filter((name) => !OWN_TOOLS.has(name))
          .toSorted();
      }
    }
    throw new Error('the server exited before it listed its tools');
  } finally {
    clearTimeout(timer);
    killGroup(child.pid, 'SIGTERM');
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        exited,
        delay(options.stopMs ?? STOP_TIMEOUT_MS, undefined, { ref: false }),
      ]);
    }
    killGroup(child.pid, 'SIGKILL');
    lines.close();
    child.stdout.destroy();
  }
};
