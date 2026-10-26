import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { CLI_ENTRY, stopChild } from './cli-subprocess.ts';
import { SUBPROCESS_WAIT_MS } from './subprocess-budget.ts';

// The harness of the filter end-to-end suites: a real `serve` process over
// MCP stdio, and a local upstream that records every request it receives.
// Nothing here ever counts as "refused" by itself: a reply that never comes,
// a process that exits or an upstream failure rejects, so a broken server can
// never make a refusal test pass.

export type UpstreamRequest = {
  method: string;
  url: string;
  // The request's Authorization header, for credential isolation checks
  authorization?: string;
};

// A redirect for a request path, or undefined for the default 200 `{}`
export type Redirects = Readonly<Record<string, string>>;

export type Upstream = {
  url: string;
  requests: UpstreamRequest[];
  close: () => Promise<void>;
};

export const startUpstream = async (redirects: Redirects = {}): Promise<Upstream> => {
  const requests: UpstreamRequest[] = [];
  const server = createServer((req, res) => {
    const { authorization } = req.headers;
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      ...(authorization === undefined ? {} : { authorization }),
    });
    req.resume();
    const location = redirects[req.url ?? ''];
    if (location !== undefined) {
      res.writeHead(302, { location });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    },
  };
};

// A one-shot CLI command (not `serve`): its stdout, or a rejection naming
// the exit code and stderr
export const runCli = async (args: readonly string[], home: string): Promise<string> => {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) {
    throw new Error(`openapi-mcp ${args.join(' ')} exited ${String(code)}: ${stderr.slice(-2000)}`);
  }
  return stdout;
};

type RpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export type ToolReply =
  | { kind: 'rpc-error'; code: number; message: string }
  | { kind: 'result'; isError: boolean; text: string; structured?: unknown };

export type McpSession = {
  request: (method: string, params?: Record<string, unknown>) => Promise<RpcMessage>;
  listTools: () => Promise<string[]>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolReply>;
  stderr: () => string;
  stop: () => Promise<void>;
};

const replyOf = (message: RpcMessage): ToolReply => {
  if (message.error !== undefined) {
    return { kind: 'rpc-error', code: message.error.code, message: message.error.message };
  }
  const result = message.result ?? {};
  const content = (result['content'] ?? []) as { text?: string }[];
  return {
    kind: 'result',
    isError: result['isError'] === true,
    text: content[0]?.text ?? '',
    ...(result['structuredContent'] === undefined
      ? {}
      : { structured: result['structuredContent'] }),
  };
};

type Pending = { resolve: (message: RpcMessage) => void; reject: (error: Error) => void };

// Starts `serve` and completes the MCP handshake; rejects if the process
// exits or does not answer `initialize` in time
export const startServe = async (args: readonly string[], home: string): Promise<McpSession> => {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    // With several APIs a switch names its API (--enable), so the caller sets it
    [CLI_ENTRY, 'serve', ...(args.includes('--api') ? [] : ['--trust-spec-updates']), ...args],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, shell: false },
  );
  const pending = new Map<number, Pending>();
  let failure: Error | undefined;
  let errText = '';
  const out = new StringDecoder('utf8');
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += out.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter((entry) => entry.trim() !== '')) {
      const message = JSON.parse(line) as RpcMessage;
      if (message.id !== undefined) {
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errText += chunk;
  });
  child.on('exit', (code, signal) => {
    failure = new Error(
      `serve exited (code ${String(code)}, signal ${String(signal)}): ${errText.slice(-2000)}`,
    );
    for (const entry of pending.values()) {
      entry.reject(failure);
    }
    pending.clear();
  });
  let nextId = 0;
  const request = async (method: string, params?: Record<string, unknown>): Promise<RpcMessage> => {
    if (failure !== undefined) {
      throw failure;
    }
    nextId += 1;
    const id = nextId;
    const { promise, resolve, reject } = Promise.withResolvers<RpcMessage>();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no reply to ${method} within ${String(SUBPROCESS_WAIT_MS)} ms`));
    }, SUBPROCESS_WAIT_MS);
    pending.set(id, { resolve, reject });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  };
  // A child that never answers is stopped too, not left running
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'filter-e2e', version: '1' },
    });
    if (initialized.error !== undefined) {
      throw new Error(`initialize failed: ${initialized.error.message}`);
    }
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    request,
    listTools: async () => {
      const reply = await request('tools/list', {});
      const tools = (reply.result?.['tools'] ?? []) as { name: string }[];
      return tools.map((tool) => tool.name);
    },
    callTool: async (name, toolArgs = {}) => {
      const reply = await request('tools/call', { name, arguments: toolArgs });
      return replyOf(reply);
    },
    stderr: () => errText,
    stop: () => stopChild(child),
  };
};

// Runs `fn` with a started session and always stops the process
export const withServe = async <T>(
  args: readonly string[],
  home: string,
  fn: (session: McpSession) => Promise<T>,
): Promise<T> => {
  const session = await startServe(args, home);
  try {
    return await fn(session);
  } finally {
    await session.stop();
  }
};
