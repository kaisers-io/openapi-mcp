import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verify } from './grade.ts';
import type { Expect, Scenario } from './grade.ts';

// Self-tests of the skill eval graders: every scenario in evals/scenarios.json is graded against a
// crafted run that must pass and crafted wrong runs that must fail, offline, with no agent. A
// grader that a wrong run gets through is a grader that would pass a wrong agent.
//
// The `exposed` check runs the CLI's `check`, from the TypeScript source: the bin would prefer a
// possibly stale dist/.

const ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'index.ts');
const SPAWN_TIMEOUT_MS = 30_000;

const { scenarios } = JSON.parse(
  await readFile(join(import.meta.dirname, 'evals', 'scenarios.json'), 'utf8'),
) as { scenarios: Scenario[] };
const { version } = JSON.parse(
  await readFile(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'),
) as { version: string };

const roots: string[] = [];

// A project as the runner prepares it (the specs), plus the files a run left behind
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'openapi-mcp-grade-'));
  roots.push(root);
  await cp(join(import.meta.dirname, 'evals', 'shop.json'), join(root, 'shop.json'));
  await cp(
    join(ROOT, 'packages', 'cli', 'test', 'fixtures', 'petstore.json'),
    join(root, 'petstore.json'),
  );
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
};

const claudeConfig = (args: string[], env?: Record<string, string>): string =>
  JSON.stringify({
    mcpServers: {
      shop: {
        command: 'npx',
        args: ['-y', `@kaisers-io/openapi-mcp@${version}`, 'serve', ...args],
        ...(env === undefined ? {} : { env }),
      },
    },
  });

const SHOP = ['--spec', './shop.json', '--base-url', 'https://api.example.test'];
const TOKEN = ['--header-env', 'Authorization=SHOP_API_TOKEN'];
const TOKEN_ENV = { SHOP_API_TOKEN: `\${SHOP_API_TOKEN}` };

const codexConfig = (env: string): string =>
  [
    '[mcp_servers.apis]',
    'command = "npx"',
    `args = ["-y", "@kaisers-io/openapi-mcp@${version}", "serve", "--api", "shop=./shop.json", ` +
      '"--base-url", "shop=https://api.example.test", "--header-env", "shop=Authorization=SHOP_API_TOKEN", ' +
      '"--api", "petstore=./petstore.json", "--base-url", "petstore=https://pets.example.test"]',
    env,
    'startup_timeout_sec = 60',
    '',
  ].join('\n');

interface Run {
  files?: Record<string, string>;
  reply: string;
}

// Per scenario: one run that does what the scenario asks, and wrong runs, each named by the
// mistake it makes and the failure a grader must report for it. Dropping that expectation from
// scenarios.json makes the wrong run's test fail.
const RUNS: Record<string, { right: Run; wrong: Record<string, Run & { fails: string }> }> = {
  'configure-read-only': {
    right: {
      files: { '.mcp.json': claudeConfig([...SHOP, ...TOKEN], TOKEN_ENV) },
      reply: 'Wrote .mcp.json: six read operations.',
    },
    wrong: {
      'token written literally': {
        fails: '.mcp.json contains "Bearer "',
        files: {
          '.mcp.json': claudeConfig([...SHOP, ...TOKEN], {
            ...TOKEN_ENV,
            SHOP_TOKEN_VALUE: 'Bearer example-token-not-a-secret',
          }),
        },
        reply: 'Done.',
      },
      'writes exposed': {
        fails: '.mcp.json contains "--allow"',
        files: { '.mcp.json': claudeConfig([...SHOP, ...TOKEN, '--allow', '**'], TOKEN_ENV) },
        reply: 'Done.',
      },
      'reads only one endpoint': {
        fails: 'exposes getOrder getOrderSection get_reports',
        files: {
          '.mcp.json': claudeConfig([...SHOP, ...TOKEN, '--deny', 'operationId:list*'], TOKEN_ENV),
        },
        reply: 'Done.',
      },
      'command the host cannot run': {
        fails: 'exposes ',
        files: {
          '.mcp.json': claudeConfig([...SHOP, ...TOKEN], TOKEN_ENV).replace(
            '"npx"',
            '"openapi-mcp"',
          ),
        },
        reply: 'Done.',
      },
      'another package': {
        fails: 'exposes ',
        files: {
          '.mcp.json': claudeConfig([...SHOP, ...TOKEN], TOKEN_ENV).replace(
            `@kaisers-io/openapi-mcp@${version}`,
            'openapi-mcp-server',
          ),
        },
        reply: 'Done.',
      },
      'no credential': {
        fails: '.mcp.json lacks "--header-env"',
        files: { '.mcp.json': claudeConfig(SHOP) },
        reply: 'Done.',
      },
      'nothing written': {
        fails: '.mcp.json was not written',
        reply: 'Here is the config you could use: --header-env ...',
      },
    },
  },
  'configure-one-write': {
    right: {
      files: {
        '.mcp.json': claudeConfig(
          [...SHOP, ...TOKEN, '--allow', 'method:get', '--allow', 'operationId:createOrder'],
          TOKEN_ENV,
        ),
      },
      reply: '| createOrder | POST /orders | creates an order |\nThe token is sent as Bearer.',
    },
    wrong: {
      'every operation': {
        fails: '.mcp.json contains "path:/**"',
        files: { '.mcp.json': claudeConfig([...SHOP, ...TOKEN, '--allow', 'path:/**'], TOKEN_ENV) },
        reply: 'createOrder and the reads, with a Bearer token.',
      },
      'write missing': {
        fails:
          'exposes getOrder getOrderSection get_reports listCustomers listOrderItems listOrders',
        files: { '.mcp.json': claudeConfig([...SHOP, ...TOKEN], TOKEN_ENV) },
        reply: 'createOrder is allowed. Bearer token.',
      },
      'no table in the reply': {
        fails: 'reply lacks "createOrder"',
        files: {
          '.mcp.json': claudeConfig(
            [...SHOP, ...TOKEN, '--allow', 'method:get', '--allow', 'operationId:createOrder'],
            TOKEN_ENV,
          ),
        },
        reply: 'Done, the config is written.',
      },
    },
  },
  'configure-two-apis-codex': {
    right: {
      files: { '.codex/config.toml': codexConfig('env_vars = ["SHOP_API_TOKEN"]') },
      reply: 'Wrote .codex/config.toml.',
    },
    wrong: {
      'token written literally': {
        fails: '.codex/config.toml contains "Bearer "',
        files: { '.codex/config.toml': codexConfig('env = { SHOP_API_TOKEN = "Bearer abc" }') },
        reply: 'Done.',
      },
      'Claude Code config instead': {
        fails: '.codex/config.toml was not written',
        files: { '.mcp.json': claudeConfig([...SHOP, ...TOKEN], TOKEN_ENV) },
        reply: 'Done.',
      },
    },
  },
  'configure-update-from-0.4': {
    right: {
      files: {
        '.mcp.json': claudeConfig([
          ...SHOP,
          '--allow',
          'operationId:*',
          '--allow',
          'route:GET /reports',
          '--deny',
          'method:delete',
        ]),
      },
      reply: 'Since 0.5.0 selectors ignore letter case; the tools are the same.',
    },
    wrong: {
      'version not bumped': {
        fails: '.mcp.json contains "@0.4.1"',
        files: {
          '.mcp.json': claudeConfig(SHOP).replace(`openapi-mcp@${version}`, 'openapi-mcp@0.4.1'),
        },
        reply: 'Selectors ignore letter case now.',
      },
      'old patterns kept': {
        fails: '.mcp.json contains "DELETE /**"',
        files: { '.mcp.json': claudeConfig([...SHOP, '--allow', '**', '--deny', 'DELETE /**']) },
        reply: 'Selectors ignore letter case now.',
      },
      'migration not explained': {
        fails: 'reply lacks "case"',
        files: {
          '.mcp.json': claudeConfig([
            ...SHOP,
            '--allow',
            'operationId:*',
            '--deny',
            'method:delete',
          ]),
        },
        reply: 'Updated the version.',
      },
    },
  },
  'debug-codex-env-vars': {
    right: {
      reply: 'Codex does not pass your shell environment. Add env_vars = ["SHOP_API_TOKEN"].',
    },
    wrong: {
      'wrong cause': {
        fails: 'reply lacks "env_vars"',
        reply: 'The token SHOP_API_TOKEN looks expired; rotate it.',
      },
    },
  },
  'debug-pending-approval': {
    right: { reply: 'Project servers need your approval: run /mcp and approve shop.' },
    wrong: {
      'wrong cause': {
        fails: 'reply lacks "approv"',
        reply: 'The spec URL is unreachable; check your network.',
      },
    },
  },
  'debug-read-only-default': {
    right: { reply: 'Without --allow the server is read-only; add --allow for createOrder.' },
    wrong: {
      'wrong cause': {
        fails: 'reply lacks "read-only"',
        reply: 'createOrder is missing from the spec.',
      },
    },
  },
  'debug-wrong-base-url': {
    right: { reply: 'Set --base-url https://api.example.test/v2.' },
    wrong: {
      'wrong cause': {
        fails: 'reply lacks "--base-url"',
        reply: 'The API returns 404 because the token is wrong.',
      },
    },
  },
};

const grade = async (run: Run, expectation: Expect): Promise<string[]> =>
  verify(await project(run.files ?? {}), run.reply, expectation, CLI);

const withoutText = (text: string, part: string): string =>
  text.replaceAll(new RegExp(part.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`), 'giu'), '');

// The right run with `part` added to the config: as an env value of the Claude Code entry, or as
// a TOML comment
const withText = (file: string, text: string, part: string): string => {
  if (!file.endsWith('.json')) {
    return `${text}# ${part}\n`;
  }
  const config = JSON.parse(text) as {
    mcpServers: Record<string, { env?: Record<string, string> }>;
  };
  for (const entry of Object.values(config.mcpServers)) {
    // A part that is itself a JSON string (`"**"`) is checked in its encoded form
    entry.env = {
      ...entry.env,
      INJECTED: /^".*"$/u.test(part) ? (JSON.parse(part) as string) : part,
    };
  }
  return JSON.stringify(config);
};

// One mutation of the right run per expectation entry, and the failure it must cause: each
// grader entry is shown to reject a run that differs from the right one only in what it checks
const mutations = (right: Run, expectation: Expect): [string, Run, string][] => {
  const { file } = expectation;
  const text = file === undefined ? '' : (right.files?.[file] ?? '');
  const edit = (content: string): Run => ({
    ...right,
    files: { ...right.files, [file ?? '']: content },
  });
  return [
    ...(expectation.contains ?? []).map((part): [string, Run, string] => [
      `without "${part}"`,
      edit(withoutText(text, part)),
      `${file ?? ''} lacks "${part}"`,
    ]),
    ...(expectation.absent ?? []).map((part): [string, Run, string] => [
      `with "${part}"`,
      edit(withText(file ?? '', text, part)),
      `${file ?? ''} contains "${part}"`,
    ]),
    ...(expectation.transcript ?? []).map((part): [string, Run, string] => [
      `reply without "${part}"`,
      { ...right, reply: withoutText(right.reply, part) },
      `reply lacks "${part}"`,
    ]),
  ];
};

describe('skill eval graders', () => {
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it('has crafted runs for exactly the scenarios in scenarios.json', () => {
    expect.hasAssertions();
    expect(Object.keys(RUNS).toSorted()).toStrictEqual(
      scenarios.map((scenario) => scenario.id).toSorted(),
    );
  });

  describe.each(scenarios)('$id', (scenario) => {
    const runs = RUNS[scenario.id] ?? { right: { reply: '' }, wrong: {} };

    it('passes the right run', { timeout: SPAWN_TIMEOUT_MS }, async () => {
      expect.hasAssertions();
      expect(await grade(runs.right, scenario.expect)).toStrictEqual([]);
    });

    it.each(Object.entries(runs.wrong))(
      'fails a wrong run: %s',
      { timeout: SPAWN_TIMEOUT_MS },
      async (_name, run) => {
        expect.hasAssertions();
        expect(await grade(run, scenario.expect)).toContain(run.fails);
      },
    );

    it.each(mutations(runs.right, scenario.expect))(
      'fails the right run %s',
      { timeout: SPAWN_TIMEOUT_MS },
      async (_name, run, failure) => {
        expect.hasAssertions();
        expect(await grade(run, scenario.expect)).toContain(failure);
      },
    );
  });
});
