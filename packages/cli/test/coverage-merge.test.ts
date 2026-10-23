import { describe, expect, it } from 'vitest';
import { mergeFileCoverageByIdentity } from '../../../vitest.coverage-merge.ts';
import type { FileCoverageData } from '../../../vitest.coverage-merge.ts';

// Shapes taken from the serve.ts entries the review found duplicated: the
// worker's conversion (through Vite's source map) and the child's (Node's
// type-stripped original) agree on every START but differ in END columns and
// in the function's `decl`
const at = (line: number, column: number | null) => ({ line, column });
const range = (start: [number, number], end: [number, number | null]) => ({
  start: at(...start),
  end: at(...end),
});

const worker = (): FileCoverageData => ({
  path: '/repo/serve.ts',
  fnMap: {
    '0': {
      name: '(anonymous_0)',
      decl: range([75, 13], [78, 31]),
      loc: range([78, 31], [97, null]),
      line: 75,
    },
    '1': {
      name: '(anonymous_1)',
      decl: range([52, 6], [52, 49]),
      loc: range([52, 49], [52, null]),
      line: 52,
    },
    '2': {
      name: '(anonymous_2)',
      decl: range([319, 36], [319, 52]),
      loc: range([319, 52], [319, 64]),
      line: 319,
    },
  },
  f: { '0': 0, '1': 0, '2': 0 },
  statementMap: {
    '0': range([46, 23], [46, null]),
    '1': range([52, 49], [52, null]),
  },
  s: { '0': 1, '1': 0 },
  branchMap: {
    '0': {
      loc: range([116, 7], [116, 62]),
      type: 'binary-expr',
      locations: [range([116, 7], [116, 30]), range([116, 35], [116, 62])],
      line: 116,
    },
  },
  b: { '0': [6, 5] },
});

const child = (): FileCoverageData => ({
  path: '/repo/serve.ts',
  fnMap: {
    '0': {
      name: '(anonymous_0)',
      decl: range([75, 43], [78, 31]),
      loc: range([78, 31], [97, 1]),
      line: 75,
    },
    // Only the child knows this one (e.g. never loaded in a worker)
    '1': {
      name: '(anonymous_1)',
      decl: range([400, 2], [400, 9]),
      loc: range([400, 9], [401, 1]),
      line: 400,
    },
  },
  f: { '0': 7, '1': 2 },
  statementMap: {
    '0': range([46, 23], [46, 27]),
    '1': range([52, 49], [52, 97]),
  },
  s: { '0': 13, '1': 0 },
  branchMap: {
    '0': {
      loc: range([116, 7], [116, 60]),
      type: 'binary-expr',
      locations: [range([116, 7], [116, 30]), range([116, 35], [116, 60])],
      line: 116,
    },
  },
  b: { '0': [13, 5] },
});

const pct = (counts: Record<string, number>): number => {
  const values = Object.values(counts);
  return values.filter((count) => count > 0).length / values.length;
};

describe('mergeFileCoverageByIdentity (issue kaisers-io/openapi-mcp-archive#86 review)', () => {
  it('counts a function that ran in a worker AND a child once, with the summed count', () => {
    const merged = mergeFileCoverageByIdentity(worker(), child());
    // 3 worker functions + 1 child-only, not 3 + 2
    expect(Object.keys(merged.fnMap)).toHaveLength(4);
    expect(merged.f).toEqual({ '0': 7, '1': 0, '2': 0, '3': 2 });
    // The gate sees the real ratio: 2 of 4 functions ran
    expect(pct(merged.f)).toBe(0.5);
  });

  it('matches statements and branches by start too, summing counts per arm', () => {
    const merged = mergeFileCoverageByIdentity(worker(), child());
    expect(Object.keys(merged.statementMap)).toHaveLength(2);
    expect(merged.s).toEqual({ '0': 14, '1': 0 });
    expect(Object.keys(merged.branchMap)).toHaveLength(1);
    expect(merged.b).toEqual({ '0': [19, 10] });
  });

  it('istanbul-style merge by full range would have doubled them (the bug this replaces)', () => {
    const byFullRange = new Set(
      [worker(), child()].flatMap((data) =>
        Object.values(data.fnMap).map((fn) => JSON.stringify(fn.loc)),
      ),
    );
    expect(byFullRange.size).toBe(5);
  });

  it('keeps a branch with a different arm count separate instead of mis-adding it', () => {
    const source = child();
    source.branchMap['0'] = {
      ...source.branchMap['0']!,
      locations: [...source.branchMap['0']!.locations, range([116, 61], [116, 62])],
    };
    source.b['0'] = [1, 1, 1];
    const merged = mergeFileCoverageByIdentity(worker(), source);
    expect(merged.b).toEqual({ '0': [6, 5], '1': [1, 1, 1] });
  });

  it('turns an `all` placeholder into real coverage once a child ran the file', () => {
    const placeholder = { ...worker(), all: true };
    expect(mergeFileCoverageByIdentity(placeholder, child()).all).toBeUndefined();
  });
});
