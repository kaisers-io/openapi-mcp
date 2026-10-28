import type { Token } from './path-readings.ts';
import { compileRoutes, routeKey } from './route-table.ts';
import type { Route, RouteEntry } from './route-table.ts';

// A HEAD request is also read as the GET on the same URL (route-table.ts),
// and refused when that GET is an operation that is not exposed. An exposed
// HEAD whose every URL is refused that way can never be called, so it is
// left out instead of offered as a tool (issue #68).
//
// Left out only when that is proven, never on a guess: a tool that is kept
// although its calls are refused stays reported as an overlap at startup,
// while a tool left out wrongly would hide a working operation. Proven means:
//
// - an excluded GET route covers the HEAD's template: every URL the HEAD can
//   send also matches it, in the same segments, regardless of letter case
//   (the route table also refuses a case variant of an excluded operation),
//   and in any reading the route table gives an excluded path (`/a//{id}`);
// - and no exposed GET on a concrete path is one of the HEAD's URLs: that
//   path wins over every template, so the HEAD call to it is allowed.
//
// Placeholders match one or more characters within a segment. The cover
// check is sound, not complete: a cover it cannot show keeps the tool.

type Item = { char: string } | 'one' | 'star';

// Comparison work per startup, as the overlap check bounds its own
// (route-overlaps.ts). A hostile spec that spends it keeps every HEAD left.
export const HEAD_COVER_BUDGET = 5_000_000;
type Work = { remaining: number };
const spend = (work: Work, steps: number): void => {
  work.remaining -= steps;
  if (work.remaining < 0) {
    throw new RangeError('HEAD cover budget exceeded');
  }
};

// A placeholder of the HEAD is one opaque item: only a placeholder of the
// GET can stand for it
type HeadItem = { char: string } | 'param';

const patternItems = (tokens: readonly Token[], fold: boolean): Item[] =>
  tokens.flatMap((token): Item[] =>
    'param' in token
      ? ['one', 'star']
      : [...(fold ? token.literal.toLowerCase() : token.literal)].map((char) => ({ char })),
  );

// The route table folds a whole request segment at once, but each template
// text on its own. Outside ASCII, lower case can depend on the neighbours (a
// final Greek sigma), so a cover that relies on folding is proven only for
// ASCII text; any other text must match as written.
const isAscii = (tokens: readonly Token[]): boolean =>
  tokens.every(
    (token) =>
      'param' in token || [...token.literal].every((char) => (char.codePointAt(0) ?? 0) < 0x80),
  );

const headItems = (tokens: readonly Token[], fold: boolean): HeadItem[] =>
  tokens.flatMap((token): HeadItem[] =>
    'param' in token
      ? ['param']
      : [...(fold ? token.literal.toLowerCase() : token.literal)].map((char) => ({ char })),
  );

// Whether `pattern` matches every text `head` stands for: a search over
// pairs of positions, each visited once
const coversSegment = (
  pattern: readonly Item[],
  head: readonly HeadItem[],
  work: Work,
): boolean => {
  spend(work, pattern.length + head.length + 1);
  const width = head.length + 1;
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
    const mine = pattern[row];
    const theirs = head[col];
    if (mine === undefined) {
      if (theirs === undefined) {
        return true;
      }
      continue;
    }
    if (mine === 'star') {
      // Skip the star, or let it take one more item
      visit(row + 1, col);
      if (theirs !== undefined) {
        visit(row, col + 1);
      }
    } else if (mine === 'one') {
      if (theirs !== undefined) {
        visit(row + 1, col + 1);
      }
    } else if (theirs !== undefined && theirs !== 'param' && theirs.char === mine.char) {
      visit(row + 1, col + 1);
    }
  }
  return false;
};

const covers = (get: Route, head: Route, work: Work): boolean =>
  get.segments.length === head.segments.length &&
  get.segments.every((tokens, index) => {
    const theirs = head.segments[index] ?? [];
    const fold = isAscii(tokens) && isAscii(theirs);
    return coversSegment(patternItems(tokens, fold), headItems(theirs, fold), work);
  });

// Whether a concrete path is one of the URLs of `head`, matched as written,
// as the route table picks a concrete winner
const isUrlOf = (head: Route, concrete: Route, work: Work): boolean =>
  head.segments.length === concrete.segments.length &&
  head.segments.every((tokens, index) =>
    coversSegment(
      patternItems(tokens, false),
      headItems(concrete.segments[index] ?? [], false),
      work,
    ),
  );

// The route key of every exposed HEAD that no call can pass, with the path
// of an excluded GET that refuses it
export const headsWithoutGet = (
  entries: readonly RouteEntry[],
  budget = HEAD_COVER_BUDGET,
): Map<string, string> => {
  const routes = compileRoutes(entries);
  const hiddenGets = routes.filter((route) => route.method === 'GET' && !route.exposed);
  const found = new Map<string, string>();
  if (hiddenGets.length === 0) {
    return found;
  }
  const concreteGets = routes.filter(
    (route) => route.method === 'GET' && route.exposed && route.concrete,
  );
  const work = { remaining: budget };
  try {
    for (const head of routes) {
      if (head.method !== 'HEAD' || !head.exposed) {
        continue;
      }
      const refusing = hiddenGets.find((get) => covers(get, head, work));
      if (refusing !== undefined && !concreteGets.some((get) => isUrlOf(head, get, work))) {
        found.set(routeKey(head.method, head.path), refusing.path);
      }
    }
  } catch (error) {
    // The budget is spent: every HEAD not yet proven unreachable stays
    if (!(error instanceof RangeError)) {
      throw error;
    }
  }
  return found;
};
