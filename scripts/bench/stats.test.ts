import { describe, expect, it } from 'vitest';
import { parseSpecText } from '../../packages/core/src/spec/parse.ts';
import { layeredSpec } from './fixtures.ts';
import { describedSpec, toYaml } from './yaml-fixture.ts';
import { compareResults, hasRegression, judge, summarize } from './stats.ts';
import type { CliResult, FixtureMetrics } from './stats.ts';

const result = (fixture: FixtureMetrics, versionMs = [100, 101, 99]): CliResult => ({
  cli: { versionMs: summarize(versionMs), toolsMs: summarize([300, 300, 300]) },
  fixtures: { spec: fixture },
});

describe('summarize', () => {
  it('takes the middle element of an odd sample and the mean of the middle pair of an even one', () => {
    expect(summarize([5, 1, 3]).median).toBe(3);
    expect(summarize([4, 1, 3, 2]).median).toBe(2.5);
    expect(summarize([4, 1, 3, 2])).toMatchObject({ min: 1, max: 4, samples: [4, 1, 3, 2] });
  });

  it('refuses an empty sample', () => {
    expect(() => summarize([])).toThrow('empty');
  });
});

describe('memory rules', () => {
  // The flat-500 failure on a docs-only pull request: the same build, one run
  // per GC mode
  const sameBuildRss = { reference: [199.2, 198.6, 199.5], head: [271.4, 267.8, 272.1] };

  it('reports peak RSS without failing the gate on it', () => {
    const findings = compareResults(
      result({ warmRssMB: summarize(sameBuildRss.head) }),
      result({ warmRssMB: summarize(sameBuildRss.reference) }),
      'base',
    );
    expect(findings.find((finding) => finding.metric === 'warmRssMB')?.verdict).toBe('changed');
    expect(hasRegression(findings)).toBe(false);
  });

  it('fails on retained memory: the live heap after a full GC', () => {
    const findings = compareResults(
      result({ warmLiveHeapMB: summarize([62.1, 62.3, 62.2]) }),
      result({ warmLiveHeapMB: summarize([47.7, 47.7, 47.8]) }),
      'base',
    );
    expect(findings.find((finding) => finding.metric === 'warmLiveHeapMB')?.verdict).toBe(
      'regressed',
    );
    expect(hasRegression(findings)).toBe(true);
  });
});

describe('judge — timed metrics', () => {
  const rule = { kind: 'timed', maxRatio: 1.25, minDelta: 25 } as const;

  it('flags an artificial startup regression (an added 200 ms sleep)', () => {
    const base = summarize([400, 410, 405, 420, 398]);
    const head = summarize([600, 610, 605, 620, 598]);
    expect(judge(rule, head, base).verdict).toBe('regressed');
  });

  it('ignores a single noisy sample: the minimum did not move', () => {
    const base = summarize([400, 410, 405, 420, 398]);
    const head = summarize([520, 530, 525, 401, 540]);
    expect(judge(rule, head, base).verdict).toBe('ok');
  });

  it('ignores a large ratio on a tiny absolute value (below the floor)', () => {
    expect(judge(rule, summarize([30, 30, 30]), summarize([10, 10, 10])).verdict).toBe('ok');
  });

  it('reports a symmetric improvement', () => {
    expect(judge(rule, summarize([200, 210, 205]), summarize([400, 410, 405])).verdict).toBe(
      'improved',
    );
  });
});

describe('judge — exact and count metrics', () => {
  it('fails tools/list bytes growing by more than 5% and reports smaller changes', () => {
    const rule = { kind: 'exact', maxRatio: 1.05 } as const;
    expect(judge(rule, 1100, 1000).verdict).toBe('regressed');
    expect(judge(rule, 1030, 1000).verdict).toBe('changed');
    expect(judge(rule, 1000, 1000).verdict).toBe('ok');
    expect(judge(rule, 900, 1000).verdict).toBe('improved');
  });

  it('fails a growing error count but only reports other count changes', () => {
    expect(judge({ kind: 'count', failOnIncrease: true }, 2, 0).verdict).toBe('regressed');
    expect(judge({ kind: 'count', failOnIncrease: true }, 0, 2).verdict).toBe('changed');
    expect(judge({ kind: 'count', failOnIncrease: false }, 600, 500).verdict).toBe('changed');
  });

  it('treats a metric present on only one side as missing, never as a pass', () => {
    const rule = { kind: 'count', failOnIncrease: true } as const;
    const absent: number | undefined = [3].find((value) => value > 3);
    expect(judge(rule, absent, 3).verdict).toBe('missing');
    expect(judge(rule, absent, absent).verdict).toBe('ok');
  });
});

describe('compareResults', () => {
  const healthy: FixtureMetrics = {
    startupMs: summarize([400, 400, 400]),
    toolsListBytes: 1000,
    toolCount: 10,
  };

  it('passes identical results', () => {
    const findings = compareResults(result(healthy), result(healthy), 'base');
    expect(hasRegression(findings)).toBe(false);
  });

  it('fails when a duplicated description inflates tools/list beyond the committed baseline', () => {
    // Measured: duplicating every description grows flat-500 from 386,263 to
    // 434,043 bytes (+12%)
    const inflated = result({ ...healthy, toolsListBytes: 1120 });
    const againstBaseline = compareResults(inflated, result(healthy), 'baseline');
    expect(againstBaseline.find((finding) => finding.metric === 'toolsListBytes')?.verdict).toBe(
      'outdated',
    );
    expect(hasRegression(againstBaseline)).toBe(true);
    // Against the base build the change is reported, not gated: an intended
    // change is accepted by updating baseline.json in the same pull request
    const againstBase = compareResults(inflated, result(healthy), 'base');
    expect(againstBase.find((finding) => finding.metric === 'toolsListBytes')?.verdict).toBe(
      'changed',
    );
  });

  it('fails on ANY tools/list byte change from the baseline, so small steps cannot drift past it', () => {
    // +4% three times stays under a 5% ratio each time; the gate must not
    // let any of them through without a baseline update
    for (const bytes of [1001, 1040, 999, 900]) {
      const findings = compareResults(
        result({ ...healthy, toolsListBytes: bytes }),
        result(healthy),
        'baseline',
      );
      expect(findings.find((finding) => finding.metric === 'toolsListBytes')?.verdict).toBe(
        'outdated',
      );
      expect(hasRegression(findings)).toBe(true);
    }
    // Updating baseline.json to the new value passes again
    const updated = result({ ...healthy, toolsListBytes: 1040 });
    expect(hasRegression(compareResults(updated, updated, 'baseline'))).toBe(false);
  });

  it('fails when a fixture that used to start now errors, and reports the reverse as improved', () => {
    const broken: FixtureMetrics = { error: 'spec exceeds the budget' };
    const brokenFindings = compareResults(result(broken), result(healthy), 'base');
    expect(hasRegression(brokenFindings)).toBe(true);
    const fixed = compareResults(result(healthy), result(broken), 'base');
    expect(hasRegression(fixed)).toBe(false);
    expect(fixed.find((finding) => finding.metric === 'starts')?.verdict).toBe('improved');
  });

  it('checks only machine-independent metrics against the committed baseline', () => {
    const slowerMachine = result(
      { ...healthy, startupMs: summarize([900, 900, 900]) },
      [500, 500, 500],
    );
    const findings = compareResults(slowerMachine, result(healthy), 'baseline');
    expect(findings.map((finding) => finding.metric)).toEqual(['toolsListBytes']);
    expect(hasRegression(findings)).toBe(false);
  });

  it('includes the CLI-level timings in a same-machine comparison', () => {
    const findings = compareResults(result(healthy, [200, 200, 200]), result(healthy), 'base');
    expect(findings.find((finding) => finding.metric === 'versionMs')?.verdict).toBe('regressed');
  });
});

describe('layeredSpec', () => {
  it('generates the documented operation count and acyclic layer references', () => {
    const spec = layeredSpec({ schemas: 10, refsPerSchema: 2, pathCount: 4, layers: 2 });
    const paths = spec['paths'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths)).toHaveLength(4);
    const { schemas } = spec['components'] as { schemas: Record<string, unknown> };
    expect(schemas['S0']).toMatchObject({
      properties: { rel0: { $ref: '#/components/schemas/S5' } },
    });
    // The last layer references nothing
    expect(Object.keys((schemas['S9'] as { properties: object }).properties)).toEqual([
      'id',
      'name',
      'count',
    ]);
  });

  it('is deterministic', () => {
    const opts = { schemas: 20, refsPerSchema: 3, pathCount: 5, layers: 4 };
    expect(JSON.stringify(layeredSpec(opts))).toBe(JSON.stringify(layeredSpec(opts)));
  });
});

describe('toYaml', () => {
  it('writes YAML that the spec parser reads back as the same value', () => {
    const spec = describedSpec(3);
    expect(parseSpecText(toYaml(spec))).toStrictEqual(spec);
    const awkward = {
      'a: b': ['- x', '#y', '', 0, 1.5, true, null, [], {}],
      200: { 'k"q': 'v\n', nested: [{ x: 1 }, [2]] },
    };
    expect(parseSpecText(toYaml(awkward))).toStrictEqual(awkward);
  });
});
