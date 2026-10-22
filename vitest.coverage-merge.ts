// Merges one file's child-process coverage into the worker's coverage for the
// same file by canonical source identity (issue #86 review).
//
// The worker's map is converted from Vite's transform of the file through its
// source map; a child's from Node's type-stripped original. Both agree on
// where each function, statement and branch STARTS, but not on where it ends
// (the source map loses end columns). Istanbul's own merge keys entries by
// their full range, so it kept both copies: serve.ts reported 27 functions for
// its 17, and 23/27 = 85.18% passed an 85% floor that the real 14/17 = 82.35%
// fails. Here an entry is matched by its start position (and, for a branch,
// its type and arm count) and the counts are added; only an entry without a
// match on the worker side is added as a new one.
//
// Kept free of imports so it is unit-tested on its own
// (packages/cli/test/coverage-merge.test.ts).

interface Location {
  line: number;
  column: number | null;
}
interface Range {
  start: Location;
  end: Location;
}
interface FunctionMapping {
  name: string;
  decl: Range;
  loc: Range;
  line: number;
}
interface BranchMapping {
  loc: Range;
  type: string;
  locations: Range[];
  line: number;
}

// Istanbul's own field names (s, f, b) are kept, hence the id-length waivers
export interface FileCoverageData {
  path: string;
  statementMap: Record<string, Range>;
  fnMap: Record<string, FunctionMapping>;
  branchMap: Record<string, BranchMapping>;
  // oxlint-disable-next-line id-length -- istanbul's field name
  s: Record<string, number>;
  // oxlint-disable-next-line id-length -- istanbul's field name
  f: Record<string, number>;
  // oxlint-disable-next-line id-length -- istanbul's field name
  b: Record<string, number[]>;
  bT?: Record<string, number[]>;
  all?: boolean;
}

const startKey = (range: Range): string =>
  `${String(range.start.line)}:${String(range.start.column)}`;

const branchKey = (branch: BranchMapping): string =>
  `${startKey(branch.loc)}:${branch.type}:${String(branch.locations.length)}`;

const nextId = (map: Record<string, unknown>): number =>
  Object.keys(map).reduce((max, id) => Math.max(max, Number(id) + 1), 0);

const indexBy = <Entry>(
  map: Record<string, Entry>,
  key: (entry: Entry) => string,
): Map<string, string> => {
  const index = new Map<string, string>();
  for (const [id, entry] of Object.entries(map)) {
    // The first entry with a key wins: a duplicate already inside one map is
    // left as istanbul produced it
    if (!index.has(key(entry))) {
      index.set(key(entry), id);
    }
  }
  return index;
};

const addCounts = (target: number[], source: readonly number[]): number[] =>
  target.map((count, arm) => count + (source[arm] ?? 0));

// Mutates and returns `target`. `source` is not modified.
export const mergeFileCoverageByIdentity = (
  target: FileCoverageData,
  source: FileCoverageData,
): FileCoverageData => {
  const fnIndex = indexBy(target.fnMap, (fn) => startKey(fn.loc));
  let fnNext = nextId(target.fnMap);
  for (const [id, fn] of Object.entries(source.fnMap)) {
    const match = fnIndex.get(startKey(fn.loc));
    if (match === undefined) {
      const added = String(fnNext++);
      target.fnMap[added] = fn;
      target.f[added] = source.f[id] ?? 0;
      fnIndex.set(startKey(fn.loc), added);
    } else {
      target.f[match] = (target.f[match] ?? 0) + (source.f[id] ?? 0);
    }
  }

  const statementIndex = indexBy(target.statementMap, startKey);
  let statementNext = nextId(target.statementMap);
  for (const [id, statement] of Object.entries(source.statementMap)) {
    const match = statementIndex.get(startKey(statement));
    if (match === undefined) {
      const added = String(statementNext++);
      target.statementMap[added] = statement;
      target.s[added] = source.s[id] ?? 0;
      statementIndex.set(startKey(statement), added);
    } else {
      target.s[match] = (target.s[match] ?? 0) + (source.s[id] ?? 0);
    }
  }

  const branchIndex = indexBy(target.branchMap, branchKey);
  let branchNext = nextId(target.branchMap);
  for (const [id, branch] of Object.entries(source.branchMap)) {
    const arms = branch.locations.map(() => 0);
    const match = branchIndex.get(branchKey(branch));
    if (match === undefined) {
      const added = String(branchNext++);
      target.branchMap[added] = branch;
      target.b[added] = addCounts(arms, source.b[id] ?? []);
      if (target.bT !== undefined || source.bT !== undefined) {
        target.bT ??= {};
        target.bT[added] = addCounts(arms, source.bT?.[id] ?? []);
      }
      branchIndex.set(branchKey(branch), added);
    } else {
      target.b[match] = addCounts(target.b[match] ?? arms, source.b[id] ?? []);
      if (target.bT !== undefined || source.bT !== undefined) {
        target.bT ??= {};
        target.bT[match] = addCounts(target.bT[match] ?? arms, source.bT?.[id] ?? []);
      }
    }
  }
  // A real execution on either side makes the file no longer an `all` placeholder
  if (target.all === true && source.all !== true) {
    delete target.all;
  }
  return target;
};
