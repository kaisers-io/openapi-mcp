// Interoperability with the reference client (issue #70): the official MCP Inspector CLI lists and
// calls the tools of the built `openapi-mcp`, in both protocol eras, against a local mock upstream.
// Our own suites speak raw JSON-RPC, which proves our behaviour but not that the reference client
// agrees with it.
//
//   pnpm build && npm ci --prefix scripts/inspector --ignore-scripts && node scripts/inspector/run.ts
//
// The Inspector is pinned in scripts/inspector/package-lock.json, outside the workspace lockfile:
// it brings about 130 packages (a web UI, a TUI, a keychain module) that nothing else here needs.
// It runs with a throwaway HOME, so it reads and writes no stored secrets or OAuth state, and the
// spec needs no credentials. The only network is 127.0.0.1.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSPECTOR = join(
  import.meta.dirname,
  'node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js',
);
const BIN = join(import.meta.dirname, '../../packages/cli/bin/openapi-mcp.mjs');

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Inspector', version: '1.0.0' },
  paths: {
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'integer' }, name: { type: 'string' } },
                  required: ['id', 'name'],
                },
              },
            },
          },
        },
      },
    },
  },
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
interface ToolResult {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: { status?: number; data?: unknown };
}
interface Output {
  result?: ToolResult & {
    tools?: { name: string; inputSchema?: { properties?: Record<string, { type?: string }> } }[];
  };
}

const failures: string[] = [];
const check = (ok: boolean, what: string, run: Run): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures.push(what);
    console.log(`  exit ${String(run.code)}\n  stdout: ${run.stdout}\n  stderr: ${run.stderr}`);
  }
};

const requests: string[] = [];
const upstream = createServer((request, response) => {
  requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
  const id = Number(request.url?.split('/').pop());
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ id, name: 'Rex' }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const { port } = upstream.address() as AddressInfo;

const home = await mkdtemp(join(tmpdir(), 'inspector-home-'));
const specPath = join(home, 'spec.json');
await writeFile(specPath, JSON.stringify(SPEC));

const inspector = async (era: string, args: string[], spec = specPath): Promise<Run> => {
  const argv = [
    INSPECTOR,
    '--cli',
    '--protocol-era',
    era,
    '--format',
    'json',
    '-q',
    process.execPath,
    BIN,
    'serve',
    '--spec',
    spec,
    '--base-url',
    `http://127.0.0.1:${String(port)}`,
    '--allow-private-network',
    ...args,
  ];
  // No inherited secrets: the server gets the throwaway HOME and PATH only
  const child = spawn(process.execPath, argv, {
    env: { HOME: home, PATH: process.env['PATH'] ?? '' },
    timeout: 60_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  return { code: code ?? 1, stdout, stderr };
};

const parse = (output: Run): Output => {
  try {
    return JSON.parse(output.stdout) as Output;
  } catch {
    return {};
  }
};
// --strict prints every schema portability problem as an `Issue:` line on stderr, and exits 6 on
// an error-severity one. All of them fail the check except a `type` array: Zod writes a nullable
// field as `type: [T, "null"]`, legal JSON Schema and the form the OpenAI and Gemini docs give for
// nullable fields. The `anyOf` the Inspector suggests is longer, and no spelling of nullability is
// portable to every client.
const ALLOWED_ISSUE = '`type` is an array';
const unexpectedIssues = (output: Run): string[] =>
  output.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Issue:') && !line.startsWith(`Issue: ${ALLOWED_ISSUE}`));

// Every spec fixture of the CLI tests, except the one the server refuses to start with
const FIXTURES = join(import.meta.dirname, '../../packages/cli/test/fixtures');
const entries = await readdir(FIXTURES);
const fixtures = entries.filter(
  (name) => /\.(?:json|yaml)$/u.test(name) && name !== 'hostile-path-key.json',
);

const call = (era: string, args: string) =>
  inspector(era, ['--method', 'tools/call', '--tool-name', 'getPet', '--tool-args-json', args]);

try {
  for (const era of ['legacy', 'modern']) {
    // --strict: exit 6 on an error-severity schema portability problem
    const list = await inspector(era, ['--method', 'tools/list', '--strict']);
    const tool = parse(list).result?.tools?.find((each) => each.name === 'getPet');
    check(
      list.code === 0 &&
        unexpectedIssues(list).length === 0 &&
        tool?.inputSchema?.properties?.['id']?.type === 'integer',
      `${era}: tools/list lists getPet`,
      list,
    );

    const before = requests.length;
    const ok = await call(era, '{"id":7}');
    const { result } = parse(ok);
    check(
      ok.code === 0 &&
        result?.isError === false &&
        result.structuredContent?.status === 200 &&
        JSON.stringify(result.structuredContent.data) === '{"id":7,"name":"Rex"}' &&
        requests.slice(before).join(',') === 'GET /pets/7',
      `${era}: tools/call getPet reaches the upstream and returns structuredContent`,
      ok,
    );

    // A tool error is a result with isError, which the Inspector reports with exit 5
    const invalid = await call(era, '{"id":"x"}');
    const error = parse(invalid).result;
    check(
      invalid.code === 5 &&
        error?.isError === true &&
        String(error.content?.[0]?.text).startsWith('invalid tool arguments') &&
        requests.length === before + 1,
      `${era}: tools/call with an invalid argument is a tool error and sends nothing`,
      invalid,
    );
  }

  // The schemas of every fixture, one tool per operation and the discover tools, carry no
  // portability problem beyond the allowed one
  for (const name of fixtures) {
    for (const mode of ['per-operation', 'discover']) {
      const args = ['--tool-mode', mode, '--method', 'tools/list', '--strict'];
      const list = await inspector('modern', args, join(FIXTURES, name));
      check(
        list.code === 0 &&
          unexpectedIssues(list).length === 0 &&
          (parse(list).result?.tools?.length ?? 0) > 0,
        `${name} (${mode}): tools/list --strict has no portability problem`,
        list,
      );
    }
  }
} finally {
  upstream.close();
  await rm(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`::error::the MCP Inspector disagrees with openapi-mcp: ${failures.join('; ')}`);
  process.exitCode = 1;
}
