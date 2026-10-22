// Turns raw per-process samples into the report's per-metric summaries

import type { SessionSample } from './session.ts';
import { summarize } from './stats.ts';
import type { CliResult, FixtureMetrics } from './stats.ts';

export type FixtureSamples = {
  cold: SessionSample[];
  warm: SessionSample[];
  omittedCount?: number;
  error?: string;
};

export type CliSamples = {
  versionMs: number[];
  toolsMs: number[];
  fixtures: Map<string, FixtureSamples>;
};

const pick = (from: readonly SessionSample[], key: keyof SessionSample): number[] =>
  from.map((sample) => sample[key]).filter((value): value is number => value !== undefined);

// `{ [as]: summary }`, or nothing when no sample carries the metric (e.g. RSS
// off Linux, call metrics for a fixture without a call)
const summaryEntry = (
  as: keyof FixtureMetrics,
  from: readonly SessionSample[],
  key: keyof SessionSample,
): Partial<FixtureMetrics> => {
  const values = pick(from, key);
  return values.length === 0 ? {} : { [as]: summarize(values) };
};

// Counts are deterministic per fixture; the worst sample is reported
const maxEntry = (
  as: keyof FixtureMetrics,
  from: readonly SessionSample[],
  key: keyof SessionSample,
): Partial<FixtureMetrics> => {
  const values = pick(from, key);
  return values.length === 0 ? {} : { [as]: Math.max(...values) };
};

const summarizeFixture = (samples: FixtureSamples): FixtureMetrics => {
  if (samples.error !== undefined) {
    return { error: samples.error };
  }
  return {
    ...summaryEntry('startupMs', samples.cold, 'startupMs'),
    ...summaryEntry('warmStartupMs', samples.warm, 'startupMs'),
    ...summaryEntry('toolsListMs', samples.cold, 'toolsListMs'),
    ...summaryEntry('rssMB', samples.cold, 'rssMB'),
    ...summaryEntry('warmRssMB', samples.warm, 'rssMB'),
    ...summaryEntry('sequentialCallMs', samples.warm, 'sequentialCallMs'),
    ...summaryEntry('parallelCallMs', samples.warm, 'parallelCallMs'),
    ...maxEntry('toolsListBytes', samples.cold, 'toolsListBytes'),
    ...maxEntry('toolCount', samples.cold, 'toolCount'),
    ...(samples.omittedCount === undefined ? {} : { omittedCount: samples.omittedCount }),
    ...maxEntry('parallelErrors', samples.warm, 'parallelErrors'),
    ...maxEntry('upstreamConnections', samples.warm, 'upstreamConnections'),
  };
};

export const summarizeCli = (samples: CliSamples): CliResult => ({
  cli: { versionMs: summarize(samples.versionMs), toolsMs: summarize(samples.toolsMs) },
  fixtures: Object.fromEntries(
    [...samples.fixtures].map(([name, fixtureSamples]) => [name, summarizeFixture(fixtureSamples)]),
  ),
});
