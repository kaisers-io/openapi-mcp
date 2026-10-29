// Summarizes result lines from run.ts: one row per agent, model and variant,
// then one row per task. Token counts are what the provider reported.
//
//   node scripts/evals/summary.ts results.jsonl [--by-task]

import { readFile } from 'node:fs/promises';
import { buildData } from './fake-api.ts';
import { HARD_TASKS, TASKS } from './tasks.ts';

interface Row {
  agent: string;
  model: string;
  variant: string;
  task: string;
  lang: string;
  correct: boolean;
  writes: number;
  ms: number;
  toolCalls: string[];
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  costUsd?: number;
  error?: string;
  answer: string;
}

const [file, flag] = process.argv.slice(2);
const text = await readFile(file!, 'utf8');
const rows = text
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Row);

// Checks the answers again with the current checks, so a fixed check applies
// to earlier results too. The write task depends on the API's final state,
// which only the run itself saw.
const data = buildData();
for (const row of rows) {
  const task = [...TASKS, ...HARD_TASKS].find((candidate) => candidate.id === row.task);
  if (task && row.task !== 'write-unclear') {
    row.correct = task.check(row.answer, {
      data,
      tickets: data.tickets,
    } as unknown as Parameters<typeof task.check>[1]).correct;
  }
}

const median = (values: number[]) => {
  const sorted = values.toSorted((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const tokens = (row: Row) => row.usage.input + row.usage.cacheRead + row.usage.cacheWrite;

const table = (key: (row: Row) => string) => {
  const groups = Map.groupBy(rows, key);
  const out = [...groups]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, group]) => {
      const summary: Record<string, unknown> = {
        group: name,
        runs: group.length,
        correct: `${group.filter((row) => row.correct).length}/${group.length}`,
        errors: group.filter((row) => row.error).length,
        'extra writes': group.reduce(
          (sum, row) => sum + Math.max(row.writes - (row.task === 'write-unclear' ? 1 : 0), 0),
          0,
        ),
        'calls (median)': median(group.map((row) => row.toolCalls.length)),
        'input tokens (median)': median(group.map((row) => tokens(row))),
        'output tokens (median)': median(group.map((row) => row.usage.output)),
        'seconds (median)': Math.round(median(group.map((row) => row.ms)) / 100) / 10,
      };
      if (group.some((row) => row.costUsd !== undefined)) {
        summary['cost USD (sum)'] =
          Math.round(group.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) * 1000) / 1000;
      }
      return summary;
    });
  console.table(out);
};

table((row) => `${row.agent} ${row.model} ${row.variant}`);
if (flag === '--by-task') {
  table((row) => `${row.agent} ${row.model} ${row.task} ${row.variant}`);
}
const wrong = rows.filter((row) => !row.correct);
for (const row of wrong) {
  console.log(
    `WRONG ${row.agent} ${row.variant} ${row.task} ${row.lang}: ${row.error ?? JSON.stringify(row.answer).slice(0, 200)}`,
  );
}
