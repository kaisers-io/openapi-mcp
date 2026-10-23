// Pure statistics and the regression rules of the CI gate. Kept free of I/O so
// the rules are unit-tested (stats.test.ts) independently of the harness.
//
// Why the gate compares against the PR base built in the SAME job rather than
// against absolute numbers committed to the repository: shared CI runners
// differ in CPU model and neighbour load from one job to the next, so an
// absolute startup time recorded on one machine says little about another.
// Running both builds interleaved on one machine cancels most of that noise
// (duet / A-B benchmarking), and the remaining per-sample jitter is absorbed by
// requiring BOTH the median and the minimum to regress by more than the
// relative threshold AND by more than an absolute floor.
//
// Machine-independent metrics (tools/list bytes) have no noise, so they are
// gated against the committed baseline.json only, and EXACTLY: any difference
// fails (`outdated`) until the pull request updates baseline.json (the
// explicit, reviewable step). A ratio threshold would let many small steps
// drift past it unaccepted. Against the base build they are only reported.

import { CLI_RULES, FIXTURE_RULES } from './rules.ts';
import type { CountRule, ExactRule, Rule, TimedRule } from './rules.ts';

export type Summary = {
  median: number;
  min: number;
  max: number;
  samples: readonly number[];
};

export const summarize = (samples: readonly number[]): Summary => {
  if (samples.length === 0) {
    throw new Error('cannot summarize an empty sample set');
  }
  // Two decimals keep the committed report readable; sub-0.01 ms is noise
  const rounded = samples.map((sample) => Math.round(sample * 100) / 100);
  const sorted = rounded.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return {
    median,
    min: sorted[0] as number,
    max: sorted.at(-1) as number,
    samples: rounded,
  };
};

export type FixtureMetrics = {
  // Spawn until the `initialize` response, empty cache
  startupMs?: Summary;
  // Same, second start with the cache the first start wrote
  warmStartupMs?: Summary;
  // First tools/list request until its response (cold process)
  toolsListMs?: Summary;
  // Peak resident set size (VmHWM) of the cold / warm process, Linux only.
  // Reported, not gated: it depends on GC timing (see heap-probe.ts)
  rssMB?: Summary;
  warmRssMB?: Summary;
  // Heap in use after a full GC once the session is done, cold / warm
  // process (heap-probe.ts): what the server keeps alive. Gated.
  liveHeapMB?: Summary;
  warmLiveHeapMB?: Summary;
  // Median of the sequential tools/call round trips of one sample
  sequentialCallMs?: Summary;
  // Wall time of one batch of parallel tools/calls
  parallelCallMs?: Summary;
  toolsListBytes?: number;
  toolCount?: number;
  omittedCount?: number;
  parallelErrors?: number;
  upstreamConnections?: number;
  error?: string;
};

export type CliMetrics = {
  versionMs?: Summary;
  toolsMs?: Summary;
};

export type CliResult = {
  cli: CliMetrics;
  fixtures: Record<string, FixtureMetrics>;
};

export type Report = {
  schemaVersion: 1;
  node: string;
  platform: string;
  arch: string;
  cpu: string;
  runs: number;
  sequentialCalls: number;
  parallelCalls: number;
  upstreamLatencyMs: number;
  results: Record<string, CliResult>;
};

// `outdated`: an exact metric differs from the committed baseline (see header)
export type Verdict = 'ok' | 'regressed' | 'improved' | 'changed' | 'missing' | 'outdated';

export type Finding = {
  scope: string;
  metric: string;
  head: string;
  reference: string;
  ratio: number | undefined;
  verdict: Verdict;
  against: 'base' | 'baseline';
};

const isSummary = (value: unknown): value is Summary =>
  typeof value === 'object' && value !== null && 'median' in value;

const formatValue = (value: Summary | number | undefined): string => {
  if (value === undefined) {
    return '—';
  }
  if (isSummary(value)) {
    return `${value.median.toFixed(1)} (min ${value.min.toFixed(1)})`;
  }
  return String(value);
};

const timedVerdict = (head: Summary, base: Summary, rule: TimedRule): Verdict => {
  const medianRatio = head.median / base.median;
  const minRatio = head.min / base.min;
  if (
    medianRatio > rule.maxRatio &&
    minRatio > rule.maxRatio &&
    head.median - base.median > rule.minDelta
  ) {
    return 'regressed';
  }
  if (
    medianRatio < 1 / rule.maxRatio &&
    minRatio < 1 / rule.maxRatio &&
    base.median - head.median > rule.minDelta
  ) {
    return 'improved';
  }
  return 'ok';
};

const exactVerdict = (head: number, base: number, rule: ExactRule): Verdict => {
  if (head > base * rule.maxRatio) {
    return 'regressed';
  }
  if (head < base / rule.maxRatio) {
    return 'improved';
  }
  return head === base ? 'ok' : 'changed';
};

const countVerdict = (head: number, base: number, rule: CountRule): Verdict => {
  if (head === base) {
    return 'ok';
  }
  return rule.failOnIncrease && head > base ? 'regressed' : 'changed';
};

export const judge = (
  rule: Rule,
  head: Summary | number | undefined,
  reference: Summary | number | undefined,
): { verdict: Verdict; ratio: number | undefined } => {
  if (head === undefined || reference === undefined) {
    return { verdict: head === reference ? 'ok' : 'missing', ratio: undefined };
  }
  if (rule.kind === 'info' && isSummary(head) && isSummary(reference)) {
    const ratio = head.median / reference.median;
    const beyond = ratio > rule.maxRatio || ratio < 1 / rule.maxRatio;
    return { verdict: beyond ? 'changed' : 'ok', ratio };
  }
  if (rule.kind === 'timed' && isSummary(head) && isSummary(reference)) {
    return {
      verdict: timedVerdict(head, reference, rule),
      ratio: head.median / reference.median,
    };
  }
  if (typeof head === 'number' && typeof reference === 'number') {
    const ratio = reference === 0 ? undefined : head / reference;
    if (rule.kind === 'exact') {
      return { verdict: exactVerdict(head, reference, rule), ratio };
    }
    if (rule.kind === 'count') {
      return { verdict: countVerdict(head, reference, rule), ratio };
    }
  }
  return { verdict: 'missing', ratio: undefined };
};

const compareRecords = <Metrics extends object>(
  scope: string,
  rules: Record<string, Rule>,
  head: Metrics,
  reference: Metrics,
  against: Finding['against'],
): Finding[] =>
  Object.entries(rules)
    .filter(([, rule]) => against === 'base' || rule.kind === 'exact')
    .map(([metric, rule]) => {
      const headValue = (head as Record<string, Summary | number | undefined>)[metric];
      const referenceValue = (reference as Record<string, Summary | number | undefined>)[metric];
      const judged = judge(rule, headValue, referenceValue);
      const { ratio } = judged;
      // Exact metrics gate only against the baseline, on any difference (header)
      const exactAgainstBaseline =
        rule.kind === 'exact' && against === 'baseline' && judged.verdict !== 'ok'
          ? 'outdated'
          : judged.verdict;
      const verdict =
        rule.kind === 'exact' && against === 'base' && judged.verdict === 'regressed'
          ? 'changed'
          : exactAgainstBaseline;
      return {
        scope,
        metric,
        head: formatValue(headValue),
        reference: formatValue(referenceValue),
        ratio,
        verdict,
        against,
      };
    });

// A fixture that starts on the reference but fails on head is a regression in
// its own right (a spec that used to be served no longer is); the reverse is
// reported as an improvement.
const errorFinding = (
  scope: string,
  head: FixtureMetrics,
  reference: FixtureMetrics,
  against: Finding['against'],
): Finding[] => {
  if ((head.error === undefined) === (reference.error === undefined)) {
    return [];
  }
  return [
    {
      scope,
      metric: 'starts',
      head: head.error === undefined ? 'yes' : `no: ${head.error}`,
      reference: reference.error === undefined ? 'yes' : `no: ${reference.error}`,
      ratio: undefined,
      verdict: head.error === undefined ? 'improved' : 'regressed',
      against,
    },
  ];
};

export const compareResults = (
  head: CliResult,
  reference: CliResult,
  against: Finding['against'],
): Finding[] => [
  ...(against === 'base' ? compareRecords('cli', CLI_RULES, head.cli, reference.cli, against) : []),
  ...Object.entries(head.fixtures).flatMap(([name, headFixture]) => {
    const referenceFixture = reference.fixtures[name];
    if (referenceFixture === undefined) {
      return [];
    }
    const findings = errorFinding(name, headFixture, referenceFixture, against);
    findings.push(...compareRecords(name, FIXTURE_RULES, headFixture, referenceFixture, against));
    return findings;
  }),
];

export const hasRegression = (findings: readonly Finding[]): boolean =>
  findings.some((finding) => finding.verdict === 'regressed' || finding.verdict === 'outdated');
