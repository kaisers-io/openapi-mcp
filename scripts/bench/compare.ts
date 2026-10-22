// Regression gate over a report from run.ts (issue #80).
//
//   node scripts/bench/compare.ts <report.json> [--head head] [--base base]
//     [--baseline scripts/bench/baseline.json]
//
// - With --base: every metric of the head CLI is judged against the base CLI
//   measured in the SAME run (interleaved on the same machine), using the
//   rules in stats.ts. This is the gate CI applies to a pull request.
// - With --baseline: the machine-independent metrics (tools/list bytes) are
//   judged against the committed baseline, so changing them needs an explicit
//   baseline update in the same pull request.
//
// Prints a Markdown table (also appended to $GITHUB_STEP_SUMMARY when set) and
// exits 1 when any metric regressed.

import { appendFile, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { compareResults, hasRegression } from './stats.ts';
import type { CliResult, Finding, Report } from './stats.ts';

const VERDICT_LABEL: Record<Finding['verdict'], string> = {
  ok: 'ok',
  regressed: '**REGRESSED**',
  improved: 'improved',
  changed: 'changed',
  missing: 'missing',
  outdated: '**BASELINE OUTDATED**',
};

const renderTable = (title: string, findings: readonly Finding[]): string => {
  const rows = findings.map(
    (finding) =>
      `| ${finding.scope} | ${finding.metric} | ${finding.reference} | ${finding.head} | ${
        finding.ratio === undefined ? '—' : finding.ratio.toFixed(2)
      } | ${VERDICT_LABEL[finding.verdict]} |`,
  );
  return [
    `### ${title}`,
    '',
    '| scope | metric | reference | head | ratio | verdict |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};

const readReport = async (path: string): Promise<Report> =>
  JSON.parse(await readFile(path, 'utf8')) as Report;

const pickResult = (report: Report, label: string, path: string): CliResult => {
  const result = report.results[label];
  if (result === undefined) {
    throw new Error(`${path} has no results for "${label}"`);
  }
  return result;
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      head: { type: 'string', default: 'head' },
      base: { type: 'string' },
      baseline: { type: 'string' },
    },
  });
  const [reportPath] = positionals;
  if (reportPath === undefined) {
    throw new Error('usage: compare.ts <report.json> [--base label] [--baseline path]');
  }
  const report = await readReport(reportPath);
  const head = pickResult(report, values.head, reportPath);
  const sections: string[] = [];
  const findings: Finding[] = [];
  if (values.base !== undefined) {
    const againstBase = compareResults(head, pickResult(report, values.base, reportPath), 'base');
    findings.push(...againstBase);
    sections.push(
      renderTable(
        `${values.head} vs ${values.base} (same machine, ${String(report.runs)} interleaved runs; median, min in brackets)`,
        againstBase,
      ),
    );
  }
  if (values.baseline !== undefined) {
    const baseline = await readReport(values.baseline);
    const againstBaseline = compareResults(
      head,
      pickResult(baseline, 'head', values.baseline),
      'baseline',
    );
    findings.push(...againstBaseline);
    sections.push(
      renderTable(`${values.head} vs committed baseline (${values.baseline})`, againstBaseline),
    );
  }
  const regressed = hasRegression(findings);
  sections.push(
    regressed
      ? 'Result: **regression detected**. If it is intended, explain it in the pull request. For tools/list bytes, any change from the committed baseline fails until scripts/bench/baseline.json is updated in the same pull request (`pnpm bench:baseline`).'
      : 'Result: no regression beyond the thresholds.',
  );
  const markdown = `${sections.join('\n')}\n`;
  process.stdout.write(markdown);
  const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryPath !== undefined && summaryPath !== '') {
    await appendFile(summaryPath, markdown);
  }
  process.exitCode = regressed ? 1 : 0;
};

await main();
