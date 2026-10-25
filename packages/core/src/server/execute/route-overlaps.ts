import type { Token } from './path-readings.ts';
import { compileRoutes, methodsFor, withReadings } from './route-table.ts';
import type { Route, RouteEntry } from './route-table.ts';

// Exposed operations that the request authorization of issue #40 refuses for
// some or all argument values (issue #41). Templates are not ranked against
// each other, so a request that matches an exposed template and one that is
// not exposed is refused: an upstream that routes in declaration order
// (Starlette, FastAPI, Rails) could hand it to the excluded one. That stays,
// but the operator learns about it at startup instead of from failed calls.
//
// Two segments overlap when some text matches both, found on their tokens,
// not by trying sample values: a placeholder matches one or more characters.
// Letter case is ignored, as the route table also refuses a request that
// differs from an excluded operation only by case.

// `METHOD path` of the exposed operation, and of the one that is not exposed
// and whose path can match the same URL
export type RouteOverlap = { exposed: string; excluded: string };

export type RouteOverlapReport = {
  overlaps: readonly RouteOverlap[];
  // False when the work budget ran out before every pair was compared
  complete: boolean;
  // The routes as compiled within the budget, for the route table to reuse
  // (issue #47); absent when the budget ran out before compiling them
  routes?: readonly Route[];
};

// Overlap work per startup: search states, and every character compiled,
// read or compared, charged before the work is done. The GitHub API (1,241
// operations) needs under 500,000 with half of them exposed; a hostile spec
// ends the check early (in well under a second on one development
// machine), and the report says it is incomplete.
export const OVERLAP_WORK_BUDGET = 5_000_000;
// `items` caches each route's segments as items, folded or as written. It
// lives only as long as one check, because the routes outlive it (issue #47).
type Work = { remaining: number; items: Map<Route, Map<boolean, Item[][]>> };
const spend = (work: Work, steps: number): void => {
  work.remaining -= steps;
  if (work.remaining < 0) {
    throw new RangeError('overlap budget exceeded');
  }
};
type Item = { char: string } | 'one' | 'star';

// A placeholder is one character followed by any number of characters
const itemsOf = (tokens: readonly Token[], fold: boolean): Item[] =>
  tokens.flatMap((token): Item[] =>
    'param' in token
      ? ['one', 'star']
      : [...(fold ? token.literal.toLowerCase() : token.literal)].map((char) => ({ char })),
  );

const advance = (item: Item | undefined, at: number): number => (item === 'star' ? at : at + 1);

const compatible = (left: Item, right: Item): boolean =>
  typeof left === 'string' || typeof right === 'string' || left.char === right.char;

// Whether some text matches both segments: a search over pairs of positions,
// each visited once, so the work is bounded by the product of their lengths
const segmentsIntersect = (left: readonly Item[], right: readonly Item[], work: Work): boolean => {
  const width = right.length + 1;
  const seen = new Set<number>([0]);
  const pending = [0];
  const visit = (row: number, col: number): void => {
    if (!seen.has(row * width + col)) {
      seen.add(row * width + col);
      pending.push(row * width + col);
    }
  };
  for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
    spend(work, 1);
    const row = Math.floor(state / width);
    const col = state % width;
    if (row === left.length && col === right.length) {
      return true;
    }
    const [mine, theirs] = [left[row], right[col]];
    if (mine === 'star') {
      visit(row + 1, col);
    }
    if (theirs === 'star') {
      visit(row, col + 1);
    }
    // Both read the same character; two `star`s reading it change nothing
    if (
      mine !== undefined &&
      theirs !== undefined &&
      !(mine === 'star' && theirs === 'star') &&
      compatible(mine, theirs)
    ) {
      visit(advance(mine, row), advance(theirs, col));
    }
  }
  return false;
};

const itemsOfRoute = (route: Route, fold: boolean, work: Work): Item[][] => {
  const cached = work.items.get(route) ?? new Map<boolean, Item[][]>();
  work.items.set(route, cached);
  const known = cached.get(fold);
  if (known !== undefined) {
    return known;
  }
  const all = route.segments.flat();
  spend(
    work,
    all.reduce((sum, token) => sum + ('literal' in token ? token.literal.length : 2), 0),
  );
  const items = route.segments.map((tokens) => itemsOf(tokens, fold));
  cached.set(fold, items);
  return items;
};

const routesIntersect = (left: Route, right: Route, fold: boolean, work: Work): boolean => {
  const theirs = itemsOfRoute(right, fold, work);
  return itemsOfRoute(left, fold, work).every((items, index) =>
    segmentsIntersect(items, theirs[index] ?? [], work),
  );
};

// The one URL path two templates share, when at every position one of them
// is plain text and the other matches it as written; undefined when they
// share more, also a variant that differs only by case, which matching
// regardless of case refuses
const onlySharedPath = (exposed: Route, excluded: Route): string | undefined => {
  const parts: string[] = [];
  for (const [index, tokens] of exposed.segments.entries()) {
    const mine = plainText(tokens, false);
    const theirs = plainText(excluded.segments[index] ?? [], false);
    const caseless = theirs !== undefined && theirs.toLowerCase() === theirs.toUpperCase();
    if (mine !== undefined && (theirs === undefined || theirs === mine)) {
      parts.push(mine);
    } else if (mine === undefined && caseless) {
      parts.push(theirs);
    } else {
      return undefined;
    }
  }
  return parts.join('/');
};

// A concrete route's method and path, as compiled
const concreteKey = (method: string, route: Route): string =>
  `${method} ${route.segments.map((tokens) => plainText(tokens, false) ?? '').join('/')}`;

// Whether `excluded` can make a request for `exposed` refused, as the route
// table decides it. A concrete excluded path inside an exposed template is
// not reported: that URL is the other operation
// (`id: "export"` reaching `/items/export`), which is what the check is for.
// A concrete exposed path wins over a template that matches it exactly
// (OAS: concrete before templated), so only a match that differs by case
// counts there. A HEAD request is also resolved as GET, and another reading
// of the exposed path (`/orders//{id}` as `/orders/{id}`) is no route of
// its own: there a concrete path wins only through a concrete operation of
// that path.
const refuses = (
  exposed: Route,
  excluded: Route,
  concrete: ReadonlySet<string>,
  work: Work,
  reading: boolean,
): boolean => {
  const precedence = !reading && excluded.method === exposed.method;
  if (excluded.concrete && !exposed.concrete) {
    return false;
  }
  if (!routesIntersect(exposed, excluded, true, work)) {
    return false;
  }
  if (!exposed.concrete && !excluded.concrete) {
    // A URL a concrete operation owns resolves to that one instead
    const shared = onlySharedPath(exposed, excluded);
    return shared === undefined || !concrete.has(`${excluded.method} ${shared}`);
  }
  if (!exposed.concrete || excluded.concrete || !routesIntersect(exposed, excluded, false, work)) {
    return true;
  }
  return !precedence && !concrete.has(concreteKey(excluded.method, exposed));
};

// A segment that is plain text, in lower case, or undefined
const plainText = (tokens: readonly Token[], fold = true): string | undefined => {
  const [only] = tokens;
  if (tokens.length !== 1 || only === undefined || !('literal' in only)) {
    return undefined;
  }
  return fold ? only.literal.toLowerCase() : only.literal;
};

// Excluded routes by method and segment count, and under each position by
// its plain text (`*` for a placeholder), so a route is compared only with
// those that can share its first plain segment
const indexExcluded = (routes: readonly Route[]): Map<string, Route[]> => {
  const index = new Map<string, Route[]>();
  const add = (key: string, route: Route): void => {
    const list = index.get(key) ?? [];
    list.push(route);
    index.set(key, list);
  };
  // A path as written with a dot segment is reached only in its readings:
  // URL parsing resolves `..` before any request is sent
  const reachable = routes.filter((route) =>
    route.segments.every((tokens) => !['.', '..'].includes(plainText(tokens, false) ?? '')),
  );
  for (const route of reachable) {
    const shape = `${route.method} ${String(route.segments.length)}`;
    add(shape, route);
    for (const [at, tokens] of route.segments.entries()) {
      add(`${shape} ${String(at)} ${plainText(tokens) ?? '*'}`, route);
    }
  }
  return index;
};

// Any plain segment of the route bounds its candidates: an excluded route
// that can share a URL has the same text there, or a placeholder. The most
// selective one is used, so a common prefix such as `/v1` does not put every
// route in one bucket. Without a plain segment, every route of the shape.
const candidatesFor = (route: Route, method: string, index: Map<string, Route[]>): Route[] => {
  const shape = `${method} ${String(route.segments.length)}`;
  let best: Route[][] = [index.get(shape) ?? []];
  let bestSize = best[0]?.length ?? 0;
  for (const [at, tokens] of route.segments.entries()) {
    const text = plainText(tokens);
    if (at === 0 || text === undefined) {
      continue;
    }
    const buckets = [
      index.get(`${shape} ${String(at)} ${text}`) ?? [],
      index.get(`${shape} ${String(at)} *`) ?? [],
    ];
    const size = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
    if (size < bestSize) {
      best = buckets;
      bestSize = size;
    }
  }
  return best.flat();
};

// The operations that are not exposed and can make a request for `route`
// refused, added to `found` as each is found, so a budget that runs out
// later keeps them. An excluded path is registered in several readings:
// each counts once.
const addOverlapsOf = (
  route: Route,
  excluded: Map<string, Route[]>,
  concrete: ReadonlySet<string>,
  work: Work,
  found: RouteOverlap[],
): void => {
  const seen = new Set<string>();
  // The request authorization also reads the path as an upstream may
  const own = JSON.stringify(route.segments);
  spend(work, route.path.length);
  const readings = withReadings({ method: route.method, path: route.path, exposed: false })
    .slice(1)
    .filter((reading) => JSON.stringify(reading.segments) !== own);
  for (const [index, read] of [route, ...readings].entries()) {
    const candidates = methodsFor(route.method).flatMap((method) =>
      candidatesFor(read, method, excluded),
    );
    for (const other of candidates) {
      if (!seen.has(other.key) && refuses(read, other, concrete, work, index > 0)) {
        seen.add(other.key);
        found.push({ exposed: route.key, excluded: other.key });
      }
    }
  }
};

export const routeOverlaps = (
  entries: readonly RouteEntry[],
  budget = OVERLAP_WORK_BUDGET,
): RouteOverlapReport => {
  const work: Work = { remaining: budget, items: new Map() };
  const overlaps: RouteOverlap[] = [];
  let compiled: readonly Route[] | undefined;
  try {
    // One step per character of a path, whose readings are compiled too
    spend(
      work,
      entries.reduce((sum, entry) => sum + entry.path.length, 0),
    );
    const routes = compileRoutes(entries);
    compiled = routes;
    const excluded = indexExcluded(routes.filter((route) => !route.exposed));
    const concrete = new Set(
      routes.filter((route) => route.concrete).map((route) => concreteKey(route.method, route)),
    );
    for (const route of routes.filter((candidate) => candidate.exposed)) {
      addOverlapsOf(route, excluded, concrete, work, overlaps);
    }
  } catch {
    return { overlaps, complete: false, ...(compiled === undefined ? {} : { routes: compiled }) };
  }
  return { overlaps, complete: true, ...(compiled === undefined ? {} : { routes: compiled }) };
};
