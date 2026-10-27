import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';
import { declareChoices } from '../src/option-meta.ts';

type OptionData = {
  long: string;
  repeatable: boolean;
  negate: boolean;
  default?: unknown;
  bareValue?: unknown;
  choices?: string[];
  perApi?: string;
  argument?: { name: string; optional: boolean };
};
type CommandData = {
  name: string;
  version?: string;
  options: OptionData[];
  commands: CommandData[];
};

const helpData = async (...path: string[]): Promise<CommandData> => {
  const lines: string[] = [];
  const code = await run(testContext({ lines }), [
    'node',
    'openapi-mcp',
    '--json',
    'help',
    ...path,
  ]);
  expect(code).toBe(EXIT.OK);
  const envelope = JSON.parse(lines.join('\n')) as { ok: boolean; data: CommandData };
  expect(envelope.ok).toBe(true);
  return envelope.data;
};

const longsOf = (command: CommandData): string[] => command.options.map((option) => option.long);

const commandAt = (root: CommandData, ...path: string[]): CommandData =>
  path.reduce((current, name) => {
    const next = current.commands.find((child) => child.name === name);
    if (next === undefined) {
      throw new Error(`no command ${name}`);
    }
    return next;
  }, root);

const optionOf = (command: CommandData, long: string): OptionData => {
  const option = command.options.find((candidate) => candidate.long === long);
  if (option === undefined) {
    throw new Error(`no option ${long}`);
  }
  return option;
};

// Written out by hand, not derived from the serializer, so an option the
// command tree and the serializer both miss still fails here (issue #75)
const SPEC_OPTIONS = [
  '--spec',
  '--allow',
  '--deny',
  '--strict-filters',
  '--spec-header-env',
  '--timeout',
  '--ttl',
  '--cache-key',
  '--trust-spec-updates',
  '--allow-private-network',
  '--default-response-is-error',
  '--nullable-response-fields',
  '--omit-output-schema',
];
const EXPECTED: Record<string, string[]> = {
  '': ['--version', '--json', '--verbose'],
  doctor: [],
  tools: SPEC_OPTIONS,
  cache: [],
  'cache list': [],
  'cache clear': ['--spec', '--id', '--cache-key', '--all'],
  'cache refresh': [
    '--spec',
    '--cache-key',
    '--spec-header-env',
    '--timeout',
    '--trust-spec-updates',
    '--allow-private-network',
  ],
  'cache promote': ['--spec', '--cache-key', '--hash'],
  'cache unlock': ['--spec', '--id', '--cache-key', '--force'],
  serve: [
    ...SPEC_OPTIONS,
    '--base-url',
    '--header-env',
    '--header',
    '--max-response-bytes',
    '--allow-insecure-http',
    '--max-concurrency',
    '--rate-limit',
    '--request-timeout',
    '--retries',
    '--no-trace-propagation',
    '--upstream-oauth-client-id-env',
    '--upstream-oauth-client-secret-env',
    '--upstream-oauth-scheme',
    '--upstream-oauth-scope',
    '--upstream-oauth-token-url',
    '--upstream-oauth-client-auth',
    '--api',
    '--enable',
    '--http',
    '--port',
    '--http-token-env',
    '--http-auth',
    '--http-host',
    '--oauth-issuer',
    '--oauth-audience',
    '--oauth-required-scope',
    '--log',
    '--response-projection',
    '--allow-offsite-redirects',
    '--tools-page-size',
    '--tool-mode',
    '--image-responses',
    '--uploads',
    '--image-dir-max-bytes',
    '--output-schema',
    '--no-output-schema-descriptions',
  ],
  help: [],
};

describe('help', () => {
  it('lists every command and option of the CLI with --json', async () => {
    const root = await helpData();
    expect(root.version).toMatch(/^\d+\.\d+\.\d+/u);
    const seen: Record<string, string[]> = {};
    const walk = (command: CommandData, path: string): void => {
      seen[path] = longsOf(command);
      for (const child of command.commands) {
        walk(child, path === '' ? child.name : `${path} ${child.name}`);
      }
    };
    walk(root, '');
    expect(seen).toEqual(EXPECTED);
  });

  it('reports what commander does not: repetition, per-API use, bare values and checked choices', async () => {
    const serve = commandAt(await helpData(), 'serve');
    expect(optionOf(serve, '--allow')).toMatchObject({ repeatable: true, perApi: 'prefix' });
    expect(optionOf(serve, '--api')).toMatchObject({ repeatable: true });
    expect(optionOf(serve, '--oauth-required-scope')).toMatchObject({ repeatable: true });
    expect(optionOf(serve, '--deny').perApi).toBe('prefix-or-all');
    expect(optionOf(serve, '--base-url')).toMatchObject({ repeatable: false, perApi: 'prefix' });
    expect(optionOf(serve, '--trust-spec-updates').perApi).toBe('enable');
    expect(optionOf(serve, '--tool-mode')).toMatchObject({
      default: 'per-operation',
      choices: ['per-operation', 'discover', 'auto'],
    });
    expect(optionOf(serve, '--tool-mode').perApi).toBeUndefined();
    expect(optionOf(serve, '--nullable-response-fields')).toMatchObject({
      argument: { name: 'scope', optional: true },
      bareValue: 'all',
      choices: ['all', 'optional'],
    });
    expect(optionOf(serve, '--upstream-oauth-client-auth').choices).toEqual([
      'client_secret_basic',
      'client_secret_post',
    ]);
    expect(optionOf(serve, '--no-output-schema-descriptions')).toMatchObject({
      negate: true,
      default: true,
    });
    // Without --api there is no per-API use
    const tools = commandAt(await helpData(), 'tools');
    expect(optionOf(tools, '--allow').perApi).toBeUndefined();
  });

  it('describes one command when named', async () => {
    const unlock = await helpData('cache', 'unlock');
    expect(unlock.name).toBe('unlock');
    expect(unlock.version).toBeUndefined();
    expect(longsOf(unlock)).toEqual(EXPECTED['cache unlock']);
  });

  it('prints the help text of a command without --json', async () => {
    const lines: string[] = [];
    const code = await run(testContext({ lines }), ['node', 'openapi-mcp', 'help', 'tools']);
    expect(code).toBe(EXIT.OK);
    expect(lines.join('\n')).toContain('Usage: openapi-mcp tools');
  });

  it('refuses an unknown command', async () => {
    const lines: string[] = [];
    const code = await run(testContext({ lines }), [
      'node',
      'openapi-mcp',
      '--json',
      'help',
      'nope',
    ]);
    expect(code).toBe(EXIT.USAGE);
    const { error } = JSON.parse(lines.join('\n')) as { error: { message: string } };
    expect(error.message).toBe('unknown command "nope"');
  });
});

describe('declareChoices', () => {
  it('fails for an option the command does not define', () => {
    expect(() => {
      declareChoices({ options: [] }, '--nope', ['a']);
    }).toThrow('no option --nope to declare choices for');
  });
});
