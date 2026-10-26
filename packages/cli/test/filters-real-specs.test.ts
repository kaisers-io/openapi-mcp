import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSpecText } from '@kaisers-io/openapi-mcp-core';
import { publicSpec } from '../../../scripts/bench/public-specs.ts';
import { runCli, startUpstream, withServe } from './filter-harness.ts';
import type { McpSession, Upstream } from './filter-harness.ts';

// --allow and --deny against real, large specs (GitHub, Stripe, DigitalOcean),
// pinned by commit and sha256 (scripts/bench/public-specs.ts): the real CLI
// over MCP stdio, an upstream that records every request. Runs in its own CI
// job on Linux, macOS and Windows (`pnpm test:real-specs`).
//
// The expectation of each configuration is a predicate written here over the
// raw spec (method, path, operationId, tags), never computed with the filter
// code. Two checks follow from it:
// - security, strict: every operation the server exposes satisfies the
//   predicate, and every other one is refused by name with zero requests;
// - completeness: what the predicate expects but the server does not expose
//   are operations dropped for non-filter reasons (unsupported parameters),
//   and those are pinned here by count and hash, so a regression that drops
//   more cannot hide behind them.

type RawOperation = {
  key: string;
  method: string;
  path: string;
  operationId: string | undefined;
  tags: string[];
};

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'];

const pathItems = (document: Record<string, unknown>) =>
  Object.entries(document['paths'] as Record<string, Record<string, unknown>>);

// The oracle reads operations as written; a referenced path item would need
// resolution it does not do, so the suite asserts there is none
const referencedPathItems = (document: Record<string, unknown>): string[] =>
  pathItems(document)
    .filter(([, item]) => item['$ref'] !== undefined)
    .map(([path]) => path);

const rawOperations = (document: Record<string, unknown>): RawOperation[] =>
  pathItems(document).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method] !== undefined).map((method) => {
      const operation = item[method] as { operationId?: string; tags?: string[] };
      return {
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        tags: operation.tags ?? [],
      };
    }),
  );

const digest = (keys: readonly string[]): string =>
  createHash('sha256').update(keys.toSorted().join('\n')).digest('hex').slice(0, 16);

const hasTag = (operation: RawOperation, tag: string): boolean =>
  operation.tags.some((candidate) => candidate.toLowerCase() === tag);

type Config = {
  title: string;
  args: string[];
  mode: 'discover' | 'per-operation';
  expected: (operation: RawOperation) => boolean;
  // Expected but dropped while tools are built (not by the filters): pinned
  missing: { count: number; hash: string };
  // The configuration exposes no tool at all, so no control call is possible
  exposesNothing?: true;
};

type SpecCase = {
  name: 'github' | 'stripe' | 'digitalocean';
  // Operations the spec loader omits as unsupported: pinned
  omitted: { count: number; hash: string };
  configs: Config[];
};

const NONE = { count: 0, hash: digest([]) };
const READ = (operation: RawOperation) => operation.method === 'GET' || operation.method === 'HEAD';

const SPECS: SpecCase[] = [
  {
    name: 'github',
    omitted: { count: 1, hash: '5aef3dd15a0c397d' },
    configs: [
      { title: 'the read-only default', args: [], mode: 'discover', expected: READ, missing: NONE },
      {
        title: 'everything but deletes',
        args: ['--allow', 'path:/**', '--deny', 'method:delete'],
        mode: 'discover',
        expected: (operation) => operation.method !== 'DELETE',
        missing: { count: 11, hash: '80892c668bb0a7f0' },
      },
      {
        title: 'one tag without deletes, per operation',
        args: ['--allow', 'tag:REPOS', '--deny', 'method:delete'],
        mode: 'per-operation',
        expected: (operation) => hasTag(operation, 'repos') && operation.method !== 'DELETE',
        missing: { count: 2, hash: '2ccfa58d302c4905' },
      },
      {
        title: 'reads below one repository',
        args: ['--allow', 'route:GET /repos/{owner}/{repo}/**'],
        mode: 'discover',
        expected: (operation) =>
          operation.method === 'GET' && operation.path.startsWith('/repos/{owner}/{repo}/'),
        missing: NONE,
      },
      {
        title: 'an operationId glob across /, minus a word',
        args: ['--allow', 'operationId:issues/*', '--deny', 'operationId:*delete*'],
        mode: 'discover',
        expected: (operation) =>
          (operation.operationId ?? '').toLowerCase().startsWith('issues/') &&
          !(operation.operationId ?? '').toLowerCase().includes('delete'),
        missing: NONE,
      },
    ],
  },
  {
    name: 'stripe',
    omitted: { count: 2, hash: '0f2b05931d3c07e4' },
    configs: [
      {
        title: 'the read-only default',
        args: [],
        mode: 'discover',
        expected: READ,
        // Every Stripe read takes a deepObject `expand` this server does not
        // support yet, so the default exposes nothing; the security check
        // still holds, the control cannot run
        missing: { count: 272, hash: '624749f72025e483' },
        exposesNothing: true,
      },
      {
        title: 'deletes, except under customers',
        args: ['--allow', 'method:delete', '--deny', 'path:/v1/customers/**'],
        mode: 'discover',
        expected: (operation) =>
          operation.method === 'DELETE' && !operation.path.startsWith('/v1/customers/'),
        missing: { count: 2, hash: '6142e7b91bbd9440' },
      },
    ],
  },
  {
    name: 'digitalocean',
    omitted: NONE,
    configs: [
      {
        title: 'the read-only default',
        args: [],
        mode: 'per-operation',
        expected: READ,
        missing: NONE,
      },
      {
        title: 'one tag without deletes',
        args: ['--allow', 'tag:droplets', '--deny', 'method:DELETE'],
        mode: 'discover',
        expected: (operation) => hasTag(operation, 'droplets') && operation.method !== 'DELETE',
        missing: NONE,
      },
    ],
  },
];

const unknownText = (name: string) =>
  `unknown operation "${name}" — use search_operations to find an operation name`;

// A value for every required input of a simple schema, or undefined
const argumentsFor = (schema: Record<string, unknown>): Record<string, unknown> | undefined => {
  const properties = (schema['properties'] ?? {}) as Record<string, { type?: unknown }>;
  const required = (schema['required'] ?? []) as string[];
  const args: Record<string, unknown> = {};
  for (const name of required) {
    const { type } = properties[name] ?? {};
    if (type === 'string') {
      args[name] = 'x1';
    } else if (type === 'integer' || type === 'number') {
      args[name] = 1;
    } else {
      return undefined;
    }
  }
  return args;
};

// The path template as a pattern for the request the upstream receives
const templatePattern = (path: string): RegExp =>
  new RegExp(
    `^${path
      .split(/\{[^}]+\}/u)
      .map((part) => part.replaceAll(/[.*+?^$()|[\]\\]/gu, String.raw`\$&`))
      .join('[^/]+')}(?:\\?.*)?$`,
    'u',
  );

describe.each(SPECS)('filters against the real $name spec', ({ name, omitted, configs }) => {
  let home: string;
  let specPath: string;
  let upstream: Upstream;
  let operations: RawOperation[];
  let references: string[];
  let omittedKeys: string[];
  const nameOf = new Map<string, string>();
  const keyOf = new Map<string, string>();
  // Routes or names the mapping saw twice
  const duplicates: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), `openapi-mcp ${name} `));
    const { text, extension } = await publicSpec(name)();
    specPath = join(home, `spec.${extension}`);
    writeFileSync(specPath, text);
    const document = parseSpecText(text);
    operations = rawOperations(document);
    references = referencedPathItems(document);
    upstream = await startUpstream();
    // Tool names by route: a filter that exposes nothing lists every
    // operation under notExposed, with its tool name
    const stdout = await runCli(
      ['--json', 'tools', '--spec', specPath, '--allow', 'tag:__exposes-nothing__'],
      home,
    );
    const report = JSON.parse(stdout) as {
      data: {
        notExposed: { method: string; path: string; toolName?: string }[];
        omitted: { method: string; path: string }[];
      };
    };
    omittedKeys = report.data.omitted.map((entry) => `${entry.method} ${entry.path}`);
    for (const entry of report.data.notExposed) {
      const key = `${entry.method} ${entry.path}`;
      if (entry.toolName !== undefined) {
        if (nameOf.has(key) || keyOf.has(entry.toolName)) {
          duplicates.push(`${key} ${entry.toolName}`);
        }
        nameOf.set(key, entry.toolName);
        keyOf.set(entry.toolName, key);
      }
    }
  });

  afterAll(async () => {
    await upstream.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('names every operation of the spec once, and pins the ones it omits', () => {
    expect(references).toStrictEqual([]);
    expect(duplicates).toStrictEqual([]);
    expect({ count: omittedKeys.length, hash: digest(omittedKeys) }).toStrictEqual(omitted);
    // Every raw operation is either named or omitted, and nothing else is
    expect([...nameOf.keys(), ...omittedKeys].toSorted()).toStrictEqual(
      operations.map((operation) => operation.key).toSorted(),
    );
  });

  const serveArgs = (config: Config) => [
    '--spec',
    specPath,
    '--base-url',
    upstream.url,
    '--allow-private-network',
    '--allow-insecure-http',
    // Every operation is probed by name; the default limit would answer
    // "rate limit exceeded" instead
    '--rate-limit',
    '100000/1m',
    '--tool-mode',
    config.mode,
    ...config.args,
  ];

  // The exposed tool names, and their input schemas
  const exposedOf = async (
    session: McpSession,
    config: Config,
  ): Promise<Map<string, Record<string, unknown>>> => {
    const exposed = new Map<string, Record<string, unknown>>();
    if (config.mode === 'per-operation') {
      const reply = await session.request('tools/list', {});
      const tools = (reply.result?.['tools'] ?? []) as {
        name: string;
        inputSchema: Record<string, unknown>;
      }[];
      for (const tool of tools.filter((entry) => entry.name !== 'openapi_mcp_status')) {
        exposed.set(tool.name, tool.inputSchema);
      }
      return exposed;
    }
    for (const toolName of keyOf.keys()) {
      const reply = await session.callTool('describe_operation', { name: toolName });
      if (reply.kind === 'result' && !reply.isError) {
        const structured = reply.structured as { inputSchema: Record<string, unknown> };
        exposed.set(toolName, structured.inputSchema);
      } else {
        expect({ toolName, reply }).toMatchObject({
          toolName,
          reply: { isError: true, text: unknownText(toolName) },
        });
      }
    }
    return exposed;
  };

  const expectRefused = async (session: McpSession, config: Config, toolName: string) => {
    if (config.mode === 'per-operation') {
      const reply = await session.callTool(toolName, {});
      expect({ toolName, reply }).toStrictEqual({
        toolName,
        reply: { kind: 'rpc-error', code: -32_602, message: `unknown tool "${toolName}"` },
      });
    } else {
      const reply = await session.callTool('call_operation', { name: toolName, arguments: {} });
      expect({ toolName, reply }).toMatchObject({
        toolName,
        reply: { kind: 'result', isError: true, text: unknownText(toolName) },
      });
    }
  };

  it.each(configs)('$title ($mode)', async (config) => {
    upstream.requests.length = 0;
    await withServe(serveArgs(config), home, async (session) => {
      const exposed = await exposedOf(session, config);
      const expectedKeys = operations
        .filter((operation) => config.expected(operation) && nameOf.has(operation.key))
        .map((operation) => operation.key);
      // Security: nothing outside the expectation is exposed
      const outside = [...exposed.keys()].filter((toolName) => {
        const key = keyOf.get(toolName);
        return key === undefined || !expectedKeys.includes(key);
      });
      expect(outside).toStrictEqual([]);
      // Completeness: only the pinned, non-filter drops are missing
      const exposedKeys = new Set([...exposed.keys()].map((toolName) => keyOf.get(toolName)));
      const missing = expectedKeys.filter((key) => !exposedKeys.has(key));
      if (process.env['SHOW_MISSING'] === '1') {
        console.log(`${name} ${config.title}: ${String(missing.length)} ${digest(missing)}`);
      }
      // None is dropped silently: startup names each one with its reason
      const silent = missing.filter((key) => !session.stderr().includes(`omitted ${key} — `));
      expect(silent).toStrictEqual([]);
      expect({ count: missing.length, hash: digest(missing) }).toStrictEqual(config.missing);
      // Every other operation is refused by name, and nothing is sent
      for (const toolName of keyOf.keys()) {
        if (!exposed.has(toolName)) {
          await expectRefused(session, config, toolName);
        }
      }
      expect(upstream.requests).toStrictEqual([]);
      // The control: exposed operations with simple inputs reach the upstream
      // with their own method and path
      const callable = [...exposed]
        .map(([toolName, schema]) => ({ toolName, args: argumentsFor(schema) }))
        .filter((entry) => entry.args !== undefined)
        .toSorted((first, second) => first.toolName.localeCompare(second.toolName))
        .slice(0, 4);
      if (config.exposesNothing === true) {
        expect(exposed.size).toBe(0);
      } else {
        expect(callable.length).toBeGreaterThan(0);
      }
      for (const { toolName, args } of callable) {
        const before = upstream.requests.length;
        await (config.mode === 'per-operation'
          ? session.callTool(toolName, args)
          : session.callTool('call_operation', { name: toolName, arguments: args }));
        const [method, path] = (keyOf.get(toolName) ?? '').split(' ');
        const sent = upstream.requests.slice(before);
        const pattern = templatePattern(path ?? '');
        expect({ toolName, sent: sent.length > 0 }).toStrictEqual({ toolName, sent: true });
        const strays = sent.filter(
          (request) => request.method !== method || !pattern.test(request.url),
        );
        expect({ toolName, strays }).toStrictEqual({ toolName, strays: [] });
      }
    });
  });
});
