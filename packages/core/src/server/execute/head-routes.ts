import { decodeSegment, splitPath } from './path-readings.ts';
import { createRouteTable, routeKey, tokenize } from './route-table.ts';
import type { RouteEntry } from './route-table.ts';

// A HEAD request reaches the GET on the same path (route-table.ts), so an
// exposed HEAD operation is refused on every call while a GET with the same
// template is not exposed (issue #68). Such a HEAD is left out instead of
// offered as a tool that never works.
//
// "The same template" is decided on the route table's own tokens: segments
// split and decoded as it splits them, placeholders by position whatever
// their names, letters regardless of case, since the route table also
// refuses a request that differs from an excluded operation only by case.
// A GET whose template only overlaps the HEAD's refuses some calls, not all,
// and stays a startup warning (route-overlaps.ts).
const templateKey = (path: string): string =>
  JSON.stringify(
    splitPath(path).map((segment) =>
      tokenize(segment, decodeSegment).map((token) =>
        'param' in token ? token : { literal: token.literal.toLowerCase() },
      ),
    ),
  );

const isRefused = (verdict: string | undefined): boolean =>
  verdict === 'not-exposed' || verdict === 'shared';

// The route key of every exposed HEAD that is refused on every call because
// of a GET that is not exposed, with that GET's path when one has the same
// template. A HEAD on a concrete path is one URL, so the route table that
// authorizes calls answers for it directly: refused as it is, and allowed
// once the hidden GETs count as exposed.
export const headsWithoutGet = (entries: readonly RouteEntry[]): Map<string, string> => {
  const paths = entries.filter((entry) => entry.path.startsWith('/'));
  const hiddenGets = new Map(
    paths
      .filter((entry) => entry.method === 'GET' && !entry.exposed)
      .map((entry) => [templateKey(entry.path), entry.path]),
  );
  const found = new Map<string, string>();
  if (hiddenGets.size === 0) {
    return found;
  }
  const heads = paths.filter((entry) => entry.method === 'HEAD' && entry.exposed);
  const concrete = heads.filter((entry) => !entry.path.includes('{'));
  const tables =
    concrete.length === 0
      ? undefined
      : {
          now: createRouteTable(paths),
          withGets: createRouteTable(
            paths.map((entry) =>
              entry.method === 'GET'
                ? { method: entry.method, path: entry.path, exposed: true }
                : entry,
            ),
          ),
        };
  for (const head of heads) {
    const key = routeKey(head.method, head.path);
    const same = hiddenGets.get(templateKey(head.path));
    if (same !== undefined) {
      found.set(key, same);
    } else if (
      tables !== undefined &&
      concrete.includes(head) &&
      isRefused(tables.now.authorize('HEAD', head.path, key)) &&
      !isRefused(tables.withGets.authorize('HEAD', head.path, key))
    ) {
      found.set(key, '');
    }
  }
  return found;
};
