// Runs the evaluation tasks (issues #23, #60) with a real agent CLI against
// the fake API and writes one JSON line per run. Every run uses a fresh API, a fresh empty
// working directory and only the MCP server under test. These runs call paid
// models, so nothing in CI starts this file.
//
//   node scripts/evals/run.ts --agent claude --variants per-operation,discover,discover-execute --reps 2 --out runs.jsonl
//   node scripts/evals/summary.ts runs.jsonl

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { claude, codex } from './agents.ts';
import { buildSpec, splitSpec, startFakeApi } from './fake-api.ts';
import { REAL_APIS } from './real-apis.ts';
import type { RealTask } from './real-apis.ts';
import { HARD_TASKS, TASKS } from './tasks.ts';

// The serve flags of each variant
export const VARIANTS: Record<string, string[]> = {
  'per-operation': ['--tool-mode', 'per-operation', '--no-execute'],
  'per-operation-execute': ['--tool-mode', 'per-operation'],
  discover: ['--tool-mode', 'discover', '--no-execute'],
  'discover-execute': ['--tool-mode', 'discover'],
};

const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'claude' },
    model: { type: 'string' },
    variants: { type: 'string', default: 'per-operation,discover' },
    tasks: { type: 'string' },
    langs: { type: 'string', default: 'en,de' },
    reps: { type: 'string', default: '1' },
    // `large`: about 260 operations and the harder tasks next to the others;
    // `multi`: the small API as two APIs behind one server, with the harder
    // tasks; `github`, `github-all`, `pokeapi`: real APIs (real-apis.ts)
    api: { type: 'string', default: 'small' },
    concurrency: { type: 'string', default: '3' },
    'max-turns': { type: 'string', default: '40' },
    out: { type: 'string', default: path.join(tmpdir(), 'openapi-mcp-evals.jsonl') },
  },
});

// Writes the spec (or the two specs) and returns the serve flags for them.
// Every variant exposes the reads and createTicket.
const apiArgs = async (cwd: string, url: string): Promise<string[]> => {
  if (values.api !== 'multi') {
    const spec = path.join(cwd, 'spec.json');
    await writeFile(
      spec,
      JSON.stringify(buildSpec(url, values.api === 'large' ? 'large' : 'small')),
    );
    return [
      '--spec',
      spec,
      '--allow-private-network',
      '--allow',
      'method:get',
      '--allow',
      'operationId:createTicket',
    ];
  }
  const specs = splitSpec(buildSpec(url), url);
  const args: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const file = path.join(cwd, `${name}.json`);
    await writeFile(file, JSON.stringify(spec));
    args.push(
      '--api',
      `${name}=${file}`,
      '--enable',
      `${name}=allow-private-network`,
      '--allow',
      `${name}=method:get`,
    );
  }
  return [...args, '--allow', 'crm=operationId:createTicket'];
};

const runTask = async (
  task: (typeof TASKS)[number],
  lang: 'en' | 'de',
  variant: string,
  rep: number,
) => {
  const api = await startFakeApi();
  const cwd = await mkdtemp(path.join(tmpdir(), 'openapi-mcp-eval-'));
  try {
    const serveArgs = [...(await apiArgs(cwd, api.url)), ...VARIANTS[variant]!];
    const started = performance.now();
    const result = await (values.agent === 'codex' ? codex : claude)(
      task.prompt[lang],
      serveArgs,
      cwd,
      { model: values.model, maxTurns: values['max-turns'], env: [] },
    );
    const ms = Math.round(performance.now() - started);
    // As for the real APIs: an answer counts only after an API request
    const checked = task.check(result.answer, api);
    const verdict =
      api.requests.length === 0
        ? { ...checked, correct: false, note: 'answered without an API request' }
        : checked;
    const writes = api.requests.filter((request) => request.method !== 'GET').length;
    return {
      api: values.api,
      agent: values.agent,
      model: values.model ?? 'default',
      variant,
      task: task.id,
      lang,
      rep,
      ms,
      ...verdict,
      writes,
      upstreamRequests: api.requests.length,
      ...result,
    };
  } finally {
    await api.close();
    await rm(cwd, { recursive: true, force: true });
  }
};

// A real API: the spec is downloaded and the answers are read once per
// invocation; nothing is written, so there is no write count
const real = REAL_APIS[values.api];
const realSetup = real
  ? await (async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'openapi-mcp-eval-spec-'));
      const truth = await real.truth();
      for (const [key, value] of Object.entries(truth)) {
        if (value === undefined) {
          throw new Error(`no single right answer for ${key} right now (a tie?)`);
        }
      }
      return { args: await real.args(dir), truth };
    })()
  : undefined;

// Well-known facts (a famous Pokémon's stats, a popular repository's
// license) can be answered from memory. An answer counts only when the
// server sent at least one API request in the run: a search, a describe or a
// program without api.call() is not one.
const checkReal = (task: RealTask, result: { answer: string; apiRequests: string[] }) => {
  const verdict = task.check(result.answer, realSetup!.truth);
  return result.apiRequests.length === 0
    ? { ...verdict, correct: false, note: 'answered without an API request' }
    : verdict;
};

const runRealTask = async (task: RealTask, lang: 'en' | 'de', variant: string, rep: number) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'openapi-mcp-eval-'));
  try {
    const started = performance.now();
    const result = await (values.agent === 'codex' ? codex : claude)(
      task.prompt[lang],
      [...realSetup!.args, ...VARIANTS[variant]!],
      cwd,
      { model: values.model, maxTurns: values['max-turns'], env: real!.env },
    );
    const ms = Math.round(performance.now() - started);
    return {
      api: values.api,
      agent: values.agent,
      model: values.model ?? 'default',
      variant,
      task: task.id,
      lang,
      rep,
      ms,
      ...checkReal(task, result),
      writes: 0,
      ...result,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

const variants = values.variants.split(',');
for (const variant of variants) {
  if (!VARIANTS[variant]) {
    throw new Error(`unknown variant ${variant}`);
  }
}
const fake = values.api === 'small' ? TASKS : [...TASKS, ...HARD_TASKS];
const all: {
  id: string;
  run: (lang: 'en' | 'de', variant: string, rep: number) => ReturnType<typeof runRealTask>;
}[] = real
  ? real.tasks.map((task) => ({
      id: task.id,
      run: (lang, variant, rep) => runRealTask(task, lang, variant, rep),
    }))
  : fake.map((task) => ({
      id: task.id,
      run: (lang, variant, rep) => runTask(task, lang, variant, rep),
    }));
const tasks = values.tasks ? all.filter((task) => values.tasks!.split(',').includes(task.id)) : all;
const jobs = Array.from({ length: Number(values.reps) }, (_unused, rep) =>
  tasks.flatMap((task) =>
    values.langs
      .split(',')
      .flatMap((lang) =>
        variants.map((variant) => () => task.run(lang as 'en' | 'de', variant, rep)),
      ),
  ),
).flat();

let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < jobs.length) {
      const record = await jobs[next++]!();
      await appendFile(values.out, `${JSON.stringify(record)}\n`);
      done += 1;
      const error = record.error ? ` error=${record.error}` : '';
      console.log(
        `${done}/${jobs.length} ${record.variant} ${record.task} ${record.lang} ${record.correct ? 'ok' : 'WRONG'} calls=${record.toolCalls.length} ${record.ms}ms${error}`,
      );
    }
  }),
);
