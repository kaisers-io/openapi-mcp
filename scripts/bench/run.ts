// Benchmark harness (issue #80). Spawns the BUILT CLI (the minified bundle a
// user runs, not the TypeScript source) as a black box, so the same harness
// can measure any revision — including the PR base the CI gate compares
// against, which may predate this script.
//
// Per fixture and sample it starts `serve` twice over stdio with a private
// HOME: once with an empty cache (cold) and once reusing the cache the first
// start wrote (warm). The cold process measures time to the `initialize`
// response, the first tools/list and peak RSS; the warm one additionally runs
// sequential and parallel tools/calls against a local mock upstream with a
// fixed artificial latency. When several CLIs are given, their runs are
// interleaved (ABBA order) so drift on the machine hits every CLI equally.
//
//   node scripts/bench/run.ts [--cli label=path/to/openapi-mcp.mjs ...]
//     [--runs 5] [--suite ci|heavy|public|all | --fixtures a,b] [--out report.json]

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FIXTURES } from './fixtures.ts';
import type { Fixture } from './fixtures.ts';
import { PARALLEL_CALLS, runCommand, runSession, SEQUENTIAL_CALLS } from './session.ts';
import type { CliResult, Report } from './stats.ts';
import { summarizeCli } from './summary.ts';
import type { CliSamples, FixtureSamples } from './summary.ts';
import { startUpstream, UPSTREAM_LATENCY_MS } from './upstream.ts';
import type { Upstream } from './upstream.ts';

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const withHome = async <Value>(work: (home: string) => Promise<Value>): Promise<Value> => {
  const home = await mkdtemp(join(tmpdir(), 'openapi-mcp-bench-'));
  try {
    return await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

type Cli = { label: string; path: string };

type Plan = {
  clis: readonly Cli[];
  fixtures: readonly Fixture[];
  specPaths: ReadonlyMap<string, string>;
  petstorePath: string;
  upstream: Upstream;
};

// Cold start, then a warm start on the cache the cold start wrote. The first
// failure is recorded on the fixture and later samples are skipped: a spec
// that a build refuses is a result, not a crash of the harness.
const sampleFixture = async (
  cli: Cli,
  fixture: Fixture,
  plan: Plan,
  into: FixtureSamples,
): Promise<void> => {
  const specPath = plan.specPaths.get(fixture.name);
  if (into.error !== undefined || specPath === undefined) {
    return;
  }
  try {
    await withHome(async (home) => {
      const input = { cli: cli.path, specPath, fixture, home, upstream: plan.upstream };
      into.cold.push(await runSession({ ...input, withCalls: false }));
      into.warm.push(await runSession({ ...input, withCalls: true }));
    });
  } catch (error) {
    into.error = describe(error);
  }
};

// `--version` and `tools --spec petstore`: the fixed cost every command pays
// (bundle load, module evaluation), tracked for issues #76 and #91
const sampleCommands = async (cli: Cli, plan: Plan, into: CliSamples): Promise<void> => {
  await withHome(async (home) => {
    const version = await runCommand(cli.path, ['--version'], home);
    into.versionMs.push(version.ms);
    const tools = await runCommand(cli.path, ['tools', '--spec', plan.petstorePath], home);
    if (tools.code !== 0) {
      throw new Error(`${cli.label}: tools --spec petstore exited ${String(tools.code)}`);
    }
    into.toolsMs.push(tools.ms);
  });
};

// `tools --json` reports the omitted operations, which tools/list cannot
const countOmitted = async (
  cli: Cli,
  fixture: Fixture,
  plan: Plan,
): Promise<number | undefined> => {
  const specPath = plan.specPaths.get(fixture.name);
  if (specPath === undefined) {
    return undefined;
  }
  const args = [
    '--json',
    'tools',
    '--spec',
    specPath,
    '--trust-spec-updates',
    ...fixture.filterArgs,
  ];
  const result = await withHome((home) => runCommand(cli.path, args, home));
  const parsed = JSON.parse(result.stdout) as { data?: { omitted?: unknown[] } };
  return parsed.data?.omitted?.length;
};

const emptySamples = (fixtures: readonly Fixture[]): CliSamples => ({
  versionMs: [],
  toolsMs: [],
  fixtures: new Map(fixtures.map((fixture) => [fixture.name, { cold: [], warm: [] }])),
});

// One round: every fixture, then the plain commands, each for every CLI in
// `order`. A warm-up round passes throwaway sample sets, except that a fixture
// failing during warm-up is recorded as failed.
const runRound = async (
  plan: Plan,
  order: readonly Cli[],
  samples: ReadonlyMap<string, CliSamples>,
  warmUp: boolean,
): Promise<void> => {
  for (const fixture of plan.fixtures) {
    for (const cli of order) {
      const target = samples.get(cli.label)?.fixtures.get(fixture.name);
      if (target !== undefined) {
        const into: FixtureSamples = warmUp ? { cold: [], warm: [] } : target;
        await sampleFixture(cli, fixture, plan, into);
        if (into.error !== undefined) {
          target.error = into.error;
        }
      }
    }
    log(`${warmUp ? 'warm-up' : 'sampled'} ${fixture.name}`);
  }
  for (const cli of order) {
    const target = samples.get(cli.label);
    if (target !== undefined) {
      await sampleCommands(cli, plan, warmUp ? emptySamples([]) : target);
    }
  }
};

const parseCli = (value: string): Cli => {
  const separator = value.indexOf('=');
  return separator === -1
    ? { label: 'head', path: resolve(value) }
    : { label: value.slice(0, separator), path: resolve(value.slice(separator + 1)) };
};

const selectFixtures = (suite: string, names: string | undefined): Fixture[] => {
  const wanted = names?.split(',');
  const selected = FIXTURES.filter((fixture) =>
    wanted === undefined
      ? suite === 'all' || fixture.suite === suite
      : wanted.includes(fixture.name),
  );
  if (selected.length === 0) {
    throw new Error('no fixture selected (--suite ci|heavy|public|all, or --fixtures a,b)');
  }
  return selected;
};

// The bin stub falls back to the TypeScript source when dist/ is missing;
// benchmarking that would measure the wrong artefact
const assertBuilt = async (cli: Cli): Promise<void> => {
  try {
    await readFile(new URL('../dist/openapi-mcp.mjs', pathToFileURL(cli.path)));
  } catch {
    throw new Error(`${cli.label}: ${cli.path} has no built dist/ next to it — run "pnpm build"`);
  }
};

const writeSpecs = async (
  fixtures: readonly Fixture[],
  dir: string,
): Promise<Map<string, string>> => {
  const specPaths = new Map<string, string>();
  for (const fixture of fixtures) {
    const { text, extension } = await fixture.spec();
    const path = join(dir, `${fixture.name}.${extension}`);
    await writeFile(path, text);
    specPaths.set(fixture.name, path);
  }
  return specPaths;
};

const measure = async (plan: Plan, runs: number): Promise<Record<string, CliResult>> => {
  const samples = new Map(plan.clis.map((cli) => [cli.label, emptySamples(plan.fixtures)]));
  await runRound(plan, plan.clis, samples, true);
  for (let round = 0; round < runs; round += 1) {
    log(`round ${String(round + 1)}/${String(runs)}`);
    await runRound(plan, round % 2 === 0 ? plan.clis : plan.clis.toReversed(), samples, false);
  }
  for (const cli of plan.clis) {
    for (const fixture of plan.fixtures) {
      const target = samples.get(cli.label)?.fixtures.get(fixture.name);
      if (target?.error === undefined && target !== undefined) {
        const omittedCount = await countOmitted(cli, fixture, plan);
        target.omittedCount = omittedCount ?? 0;
      }
    }
  }
  return Object.fromEntries([...samples].map(([label, entry]) => [label, summarizeCli(entry)]));
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      cli: { type: 'string', multiple: true },
      runs: { type: 'string', default: '5' },
      suite: { type: 'string', default: 'ci' },
      fixtures: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const clis = (values.cli ?? ['head=packages/cli/bin/openapi-mcp.mjs']).map((entry) =>
    parseCli(entry),
  );
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error('--runs must be a positive integer');
  }
  const fixtures = selectFixtures(values.suite, values.fixtures);
  for (const cli of clis) {
    await assertBuilt(cli);
  }
  const workDir = await mkdtemp(join(tmpdir(), 'openapi-mcp-bench-specs-'));
  const upstream = await startUpstream();
  try {
    const plan: Plan = {
      clis,
      fixtures,
      specPaths: await writeSpecs(fixtures, workDir),
      petstorePath: resolve('packages/cli/test/fixtures/petstore.json'),
      upstream,
    };
    const report: Report = {
      schemaVersion: 1,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      runs,
      sequentialCalls: SEQUENTIAL_CALLS,
      parallelCalls: PARALLEL_CALLS,
      upstreamLatencyMs: UPSTREAM_LATENCY_MS,
      results: await measure(plan, runs),
    };
    const json = `${JSON.stringify(report, undefined, 2)}\n`;
    if (values.out === undefined) {
      process.stdout.write(json);
    } else {
      await writeFile(values.out, json);
      log(`report written to ${values.out}`);
    }
  } finally {
    await upstream.close();
    await rm(workDir, { recursive: true, force: true });
  }
};

await main();
