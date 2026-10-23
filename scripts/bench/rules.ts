// The regression rules of the CI gate, one per reported metric. The
// reasoning behind comparing against the PR base is in stats.ts.

import type { CliMetrics, FixtureMetrics } from './stats.ts';

export type TimedRule = {
  kind: 'timed';
  // Fail only if head/base exceeds this ratio for both median and min...
  maxRatio: number;
  // ...and the median grew by more than this many units
  minDelta: number;
};

export type ExactRule = {
  kind: 'exact';
  // Fail if head/baseline exceeds this ratio (reported only against the base)
  maxRatio: number;
};

export type CountRule = {
  kind: 'count';
  // Fail if the count grows (errors); otherwise informational
  failOnIncrease: boolean;
};

// Reported against the base with its ratio, never failing the gate: a
// change past `maxRatio` is shown as `changed`
export type InfoRule = {
  kind: 'info';
  maxRatio: number;
};

export type Rule = TimedRule | ExactRule | CountRule | InfoRule;

export const FIXTURE_RULES: Record<keyof Omit<FixtureMetrics, 'error'>, Rule> = {
  startupMs: { kind: 'timed', maxRatio: 1.25, minDelta: 25 },
  warmStartupMs: { kind: 'timed', maxRatio: 1.25, minDelta: 25 },
  toolsListMs: { kind: 'timed', maxRatio: 1.25, minDelta: 10 },
  sequentialCallMs: { kind: 'timed', maxRatio: 1.25, minDelta: 5 },
  parallelCallMs: { kind: 'timed', maxRatio: 1.25, minDelta: 25 },
  // Peak RSS of one build alternated by ~70 MB between runs (GC timing), so
  // it is informational; retention is gated on the post-GC live heap below
  rssMB: { kind: 'info', maxRatio: 1.15 },
  warmRssMB: { kind: 'info', maxRatio: 1.15 },
  liveHeapMB: { kind: 'timed', maxRatio: 1.15, minDelta: 2 },
  warmLiveHeapMB: { kind: 'timed', maxRatio: 1.15, minDelta: 2 },
  // 5%: a duplicated description on the flat-500 fixture already adds 12%
  toolsListBytes: { kind: 'exact', maxRatio: 1.05 },
  toolCount: { kind: 'count', failOnIncrease: false },
  omittedCount: { kind: 'count', failOnIncrease: false },
  parallelErrors: { kind: 'count', failOnIncrease: true },
  upstreamConnections: { kind: 'count', failOnIncrease: false },
};

export const CLI_RULES: Record<keyof CliMetrics, Rule> = {
  versionMs: { kind: 'timed', maxRatio: 1.25, minDelta: 15 },
  toolsMs: { kind: 'timed', maxRatio: 1.25, minDelta: 25 },
};
