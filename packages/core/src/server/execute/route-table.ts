import {
  decodeSegment,
  mayHaveOtherReadings,
  splitPath,
  templateReadings,
} from './path-readings.ts';
import type { Token } from './path-readings.ts';
import type { NormalizedSpec, OmittedOperation } from '../../spec/normalize.ts';

// Request authorization (issue #40). A tool's request is built from its own
// path template, but the concrete URL can be a different operation of the
// same API (`GET /items/{id}` with `id: "export"` is `GET /items/export`),
// and a redirect can lead anywhere. Every hop is therefore resolved against
// every operation of the spec, exposed or not, before it is sent.
//
// Resolution follows OpenAPI's one rule (OAS 3.1.1 §4.8.8: concrete paths
// before templated ones) and nothing beyond it: templates that both match are
// not ranked, so a hop they share is refused if one of them is not exposed.

export type RouteEntry = {
  // Upper case, as sent
  method: string;
  // The spec's path template, relative to the API base
  path: string;
  exposed: boolean;
};

// `shared`: the tool's own operation, but also one not exposed (issue #41)
export type RouteRefusal = 'not-exposed' | 'shared' | 'other-operation' | 'unknown';

export type RouteTable = {
  // `bound` is the `METHOD path` of the tool's own operation, for hop 0: the
  // request must resolve to it, not to another operation, exposed or not
  authorize: (
    method: string,
    path: string,
    bound?: string,
    work?: MatchWork,
  ) => RouteRefusal | undefined;
};

export const routeKey = (method: string, path: string): string => `${method} ${path}`;

// Every operation of the spec, each marked exposed only when it became one of
// the served tools (`exposed`, after filters, toolgen and the output-schema
// opt-out). Omitted and withheld operations are kept, never exposed, so a hop
// that reaches one of them is refused instead of being unknown.
export const routeEntriesFor = (
  spec: Pick<NormalizedSpec, 'operations' | 'omitted'>,
  withheld: readonly OmittedOperation[],
  exposed: readonly { method: string; path: string }[],
): RouteEntry[] => {
  const exposedKeys = new Set(exposed.map((op) => routeKey(op.method.toUpperCase(), op.path)));
  return [
    ...spec.operations.map((op) => {
      const method = op.method.toUpperCase();
      return { method, path: op.path, exposed: exposedKeys.has(routeKey(method, op.path)) };
    }),
    ...[...spec.omitted, ...withheld].map((omission) => ({
      method: omission.method,
      path: omission.path,
      exposed: false,
    })),
  ];
};

export type Route = RouteEntry & {
  key: string;
  segments: readonly (readonly Token[])[];
  concrete: boolean;
};

const PLACEHOLDER_RE = /\{[^{}]*\}/gu;

const tokenize = (segment: string, decode: (text: string) => string): Token[] => {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of segment.matchAll(PLACEHOLDER_RE)) {
    if (match.index > last) {
      tokens.push({ literal: decode(segment.slice(last, match.index)) });
    }
    // Adjacent placeholders are one: each matches one or more characters
    if (!('param' in (tokens.at(-1) ?? {}))) {
      tokens.push({ param: true });
    }
    last = match.index + match[0].length;
  }
  if (last < segment.length || tokens.length === 0) {
    tokens.push({ literal: decode(segment.slice(last)) });
  }
  return tokens;
};

// Matching work per hop. A hostile spec's many long templates, matched
// synchronously against every reading of a long path, would stall every
// client: past this many steps the hop is refused (fail closed). A hop on
// the DigitalOcean API (290 operations) takes under 4,000.
export const ROUTE_MATCH_BUDGET = 1_000_000;
export type MatchWork = { remaining: number };
const spend = (work: MatchWork, steps: number): void => {
  work.remaining -= steps;
  if (work.remaining < 0) {
    throw new RangeError('route matching budget exceeded');
  }
};

// Whether the tokens cover the whole segment. A set of reachable positions
// is advanced token by token, so no input can make it backtrack: the cost is
// bounded by tokens x segment length, and charged to the hop's budget.
const segmentMatches = (
  tokens: readonly Token[],
  segment: string,
  fold: boolean,
  work: MatchWork,
): boolean => {
  // Every step that reads characters or positions is charged
  spend(work, segment.length + 1);
  const text = fold ? segment.toLowerCase() : segment;
  let reachable = new Set([0]);
  for (const token of tokens) {
    const next = new Set<number>();
    if ('param' in token) {
      spend(work, reachable.size);
      const from = Math.min(...reachable);
      spend(work, text.length - from + 1);
      for (let end = from + 1; end <= text.length; end += 1) {
        next.add(end);
      }
    } else {
      const literal = fold ? token.literal.toLowerCase() : token.literal;
      // Each comparison reads up to the literal's length
      spend(work, reachable.size * (literal.length + 1));
      for (const start of reachable) {
        if (text.startsWith(literal, start)) {
          next.add(start + literal.length);
        }
      }
    }
    if (next.size === 0) {
      return false;
    }
    reachable = next;
  }
  return reachable.has(text.length);
};
const routeMatches = (
  route: Route,
  segments: readonly string[],
  fold: boolean,
  work: MatchWork,
): boolean =>
  route.segments.every((tokens, index) =>
    segmentMatches(tokens, segments[index] ?? '', fold, work),
  );

const compile = (entry: RouteEntry): Route => {
  const segments = splitPath(entry.path).map((segment) => tokenize(segment, decodeSegment));
  return {
    ...entry,
    key: routeKey(entry.method, entry.path),
    segments,
    concrete: segments.every((tokens) => tokens.every((token) => 'literal' in token)),
  };
};

// An excluded operation, plus its path in the readings an upstream may give
// it (`/denied//export` as `/denied/export`), which can only add refusals
export const withReadings = (entry: RouteEntry): Route[] => {
  const route = compile(entry);
  if (!mayHaveOtherReadings(entry.path)) {
    return [route];
  }
  const raw = splitPath(entry.path).map((segment) => tokenize(segment, (text) => text));
  return [
    route,
    ...templateReadings(raw).map((segments) => ({
      method: route.method,
      path: route.path,
      exposed: false,
      key: route.key,
      // The root splits like a request for `/`: one empty segment after it
      segments: [[{ literal: '' }], ...(segments.length === 0 ? [[{ literal: '' }]] : segments)],
      concrete: segments.every((tokens) => tokens.every((token) => 'literal' in token)),
    })),
  ];
};

// Routes are indexed by method, segment count and their first segment that
// is plain text: its position and its text in lower case, so matching
// regardless of case finds it too. `/{tenant}/orders` is under `1 orders`. A
// route with no plain segment is under `*`. Only these can match a request.
const WILDCARD = '*';
const groupOf = (method: string, count: number, anchor: string): string =>
  `${method} ${String(count)} ${anchor}`;
const anchorOf = (route: Route): string => {
  const index = route.segments.findIndex(
    (tokens, at) => at > 0 && tokens.length === 1 && 'literal' in (tokens[0] ?? {}),
  );
  const [token] = route.segments[index] ?? [];
  return token !== undefined && 'literal' in token
    ? `${String(index)} ${token.literal.toLowerCase()}`
    : WILDCARD;
};

// A HEAD request matches HEAD operations, and GET ones only when the spec
// declares no HEAD for the path: an excluded HEAD is never answered by a GET
export const methodsFor = (method: string): readonly string[] =>
  method === 'HEAD' ? ['HEAD', 'GET'] : [method];

// Only paths: webhook omissions and other non-path keys are no routes. An
// operation that is not exposed is registered in its readings too.
export const compileRoutes = (entries: readonly RouteEntry[]): Route[] =>
  entries
    .filter((entry) => entry.path.startsWith('/'))
    .flatMap((entry) => (entry.exposed ? [compile(entry)] : withReadings(entry)));

// `compiled`: the same entries already compiled, shared with the overlap check
export const createRouteTable = (
  entries: readonly RouteEntry[],
  compiled?: readonly Route[],
): RouteTable => {
  const routes = compiled ?? compileRoutes(entries);
  const groups = Map.groupBy(routes, (route) =>
    groupOf(route.method, route.segments.length, anchorOf(route)),
  );
  const candidates = (
    method: string,
    segments: readonly string[],
    fold: boolean,
    work: MatchWork,
  ): Route[] => {
    const anchors = [
      WILDCARD,
      ...segments.map((segment, at) => `${String(at)} ${segment.toLowerCase()}`).slice(1),
    ];
    for (const candidate of methodsFor(method)) {
      const found = anchors
        .flatMap((anchor) => groups.get(groupOf(candidate, segments.length, anchor)) ?? [])
        .filter((route) => routeMatches(route, segments, fold, work));
      if (found.length > 0) {
        return found;
      }
    }
    return [];
  };
  const resolve = (
    method: string,
    segments: readonly string[],
    work: MatchWork,
    bound?: string,
    // The tool's own route when it was resolved under another method (HEAD)
    given?: Route,
  ): RouteRefusal | undefined => {
    const exact = candidates(method, segments, false, work);
    // Matching regardless of case can only add a refusal: an operation that
    // differs from the request just by case, and is not exposed. It counts
    // even when nothing matches exactly, for every reading of a path
    const folded = candidates(method, segments, true, work).filter(
      (route) => !route.exposed && !exact.includes(route),
    );
    if (exact.length === 0) {
      return folded.length > 0 ? 'not-exposed' : 'unknown';
    }
    const concrete = exact.filter((route) => route.concrete);
    const winners = concrete.length > 0 ? concrete : exact;
    const blockers = [...folded, ...winners.filter((route) => !route.exposed)];
    if (blockers.length > 0) {
      // `shared` (issue #41): the tool's own operation wins, and so does one
      // that is not exposed. A concrete one inside the tool's template is that
      // URL of another operation (`/items/EXPORT` under `/items/{id}`)
      const own = given ?? winners.find((route) => route.key === bound);
      return own !== undefined && blockers.some((route) => own.concrete || !route.concrete)
        ? 'shared'
        : 'not-exposed';
    }
    return bound !== undefined && !winners.some((route) => route.key === bound)
      ? 'other-operation'
      : undefined;
  };
  return {
    authorize: (method, path, bound, given) => {
      const work = given ?? { remaining: ROUTE_MATCH_BUDGET };
      const segments = splitPath(path).map((segment) => decodeSegment(segment));
      try {
        const verdict = resolve(method, segments, work, bound);
        if (method !== 'HEAD' || verdict === 'not-exposed') {
          return verdict;
        }
        // A server may answer HEAD through its GET handler, so the GET reading
        // can only add a refusal: an excluded GET operation is never reached
        const own = candidates('HEAD', segments, false, work).find((route) => route.key === bound);
        const viaGet = resolve('GET', segments, work, undefined, own);
        return viaGet === 'shared' || viaGet === 'not-exposed' ? viaGet : verdict;
      } catch {
        // The matching budget is spent: refuse rather than stall the server
        return 'not-exposed';
      }
    },
  };
};
