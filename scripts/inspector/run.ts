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
                  // `extra` has no type: listed as the union of every JSON type, not `{}`
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    extra: { description: 'Free-form' },
                  },
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

// No inherited secrets: every child gets the throwaway HOME and PATH only
const runNode = async (argv: string[]): Promise<Run> => {
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

// `server` is the command the Inspector starts: the built bin, or corrupt.ts in front of it
const inspector = (era: string, args: string[], spec = specPath, server = [BIN]): Promise<Run> =>
  runNode([
    INSPECTOR,
    '--cli',
    '--protocol-era',
    era,
    '--format',
    'json',
    '-q',
    process.execPath,
    ...server,
    'serve',
    '--spec',
    spec,
    '--base-url',
    `http://127.0.0.1:${String(port)}`,
    '--allow-private-network',
    ...args,
  ]);

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
const CORRUPT = join(import.meta.dirname, 'corrupt.ts');
const ALL = ['--allow', 'path:/**'];
const DISCOVER_TOOLS =
  'call_operation,describe_operation,execute_code,openapi_mcp_status,search_operations';

// The tools a client must see: one per operation as `openapi-mcp tools` reports them, plus the
// status tool and execute_code, or the discover tools. The Inspector drops a tool it cannot read
// and keeps the rest, so "no issue and some tools" would pass with the operation tools gone.
const expectedTools = async (spec: string, mode: string): Promise<string> => {
  if (mode === 'discover') {
    return DISCOVER_TOOLS;
  }
  const output = await runNode([BIN, '--json', 'tools', '--spec', spec, ...ALL]);
  const report = JSON.parse(output.stdout) as { data: { tools: { name: string }[] } };
  return [...report.data.tools.map((tool) => tool.name), 'openapi_mcp_status', 'execute_code']
    .toSorted()
    .join(',');
};
const listedTools = (output: Run): string =>
  (parse(output).result?.tools ?? [])
    .map((tool) => tool.name)
    .toSorted()
    .join(',');

let sawAllowedIssue = false;
const fixtureIsClean = async (
  name: string,
  mode: string,
  server = [BIN],
): Promise<Run & { clean: boolean; listed: string; expected: string }> => {
  const spec = join(FIXTURES, name);
  const args = ['--tool-mode', mode, ...ALL, '--method', 'tools/list', '--strict'];
  const list = await inspector('modern', args, spec, server);
  sawAllowedIssue ||= list.stderr.includes(`Issue: ${ALLOWED_ISSUE}`);
  const listed = listedTools(list);
  const expected = await expectedTools(spec, mode);
  const clean = list.code === 0 && unexpectedIssues(list).length === 0 && listed === expected;
  return { ...list, clean, listed, expected };
};

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

  // Every fixture lists all its tools (writes included), one per operation and in discover mode,
  // with no portability problem beyond the allowed one
  for (const name of fixtures) {
    for (const mode of ['per-operation', 'discover']) {
      const list = await fixtureIsClean(name, mode);
      check(
        list.clean,
        `${name} (${mode}): tools/list --strict lists every tool, no portability problem`,
        list,
      );
    }
  }
  // A changed --strict output format would hide every issue: the allowed one must still show
  check(sawAllowedIssue, 'a fixture still reports the allowed `type` array issue', {
    code: 0,
    stdout: '',
    stderr: '',
  });
  // The fixture check fails when one operation tool has a schema the client rejects. The list
  // itself must succeed and lack exactly the corrupted tool, so a wrapper or server that fails to
  // start cannot pass as a detection.
  const broken = await fixtureIsClean('petstore.json', 'per-operation', [CORRUPT, BIN]);
  const expected = broken.expected.split(',');
  const listed = broken.listed.split(',');
  check(
    !broken.clean &&
      broken.code === 0 &&
      listed.includes('openapi_mcp_status') &&
      listed.length === expected.length - 1 &&
      listed.every((tool) => expected.includes(tool)),
    'a tool with an unreadable schema fails the fixture check',
    broken,
  );
} finally {
  upstream.close();
  await rm(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`::error::the MCP Inspector disagrees with openapi-mcp: ${failures.join('; ')}`);
  process.exitCode = 1;
}
