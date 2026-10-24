import type { HopRefusal } from '../../http/pinned-dispatcher.ts';
import { pathReadings } from './path-readings.ts';
import { ROUTE_MATCH_BUDGET } from './route-table.ts';
import type { MatchWork, RouteTable } from './route-table.ts';

// The per-hop check the executor hands to the transport. A hop on the API
// (the base origin, within the base path) must resolve to an exposed
// operation, and hop 0 to the tool's own (`bound`). A redirect off the API is
// refused unless the operator opted in with --allow-offsite-redirects; a later
// hop back onto the API is checked again. Every reading of the path counts
// (see pathReadings), and the base is matched in each of its own readings and
// regardless of case: a reading that lands on the API must not reach an
// excluded operation, and one that leaves it is off the API.
export const hopAuthorizer = (
  routes: RouteTable,
  base: URL,
  bound: string,
  allowOffsiteRedirects: boolean,
): ((url: URL, method: string, hop: number) => HopRefusal | undefined) => {
  const trimmed = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  const bases = [
    ...new Set([trimmed, ...pathReadings(trimmed).map((path) => (path === '/' ? '' : path))]),
  ];
  // The path relative to the base, or undefined when it is off the API
  const relativeTo = (path: string): string | undefined => {
    const lower = path.toLowerCase();
    const prefix =
      bases.find((candidate) => path === candidate || path.startsWith(`${candidate}/`)) ??
      bases.find((candidate) => {
        const folded = candidate.toLowerCase();
        return lower === folded || lower.startsWith(`${folded}/`);
      });
    if (prefix === undefined) {
      return undefined;
    }
    const relative = path.slice(prefix.length);
    return relative === '' ? '/' : relative;
  };
  return (url, method, hop) => {
    const work: MatchWork = { remaining: ROUTE_MATCH_BUDGET };
    const refused = hop === 0 ? 'route-refused' : 'redirect-refused';
    const offsite = (): HopRefusal | undefined => {
      if (hop === 0) {
        return 'route-refused';
      }
      return allowOffsiteRedirects ? undefined : 'redirect-offsite';
    };
    if (url.origin !== base.origin) {
      return offsite();
    }
    const [written, ...others] = pathReadings(url.pathname).map((path) => relativeTo(path));
    if (written === undefined) {
      // Off the API as written: an operator opt-in still never lets a reading
      // that lands on the API reach anything but an exposed operation
      const verdict = offsite();
      const reached = others.some(
        (relative) =>
          relative !== undefined &&
          routes.authorize(method, relative, undefined, work) !== undefined,
      );
      return verdict ?? (reached ? refused : undefined);
    }
    if (routes.authorize(method, written, hop === 0 ? bound : undefined, work) !== undefined) {
      return refused;
    }
    // A reading that leaves the API (an encoded `..` climbing out) is off the
    // API; one that stays must not reach an excluded operation
    const verdictFor = (relative: string | undefined): HopRefusal | undefined => {
      if (relative === undefined) {
        return offsite();
      }
      return routes.authorize(method, relative, undefined, work) === 'not-exposed'
        ? refused
        : undefined;
    };
    return others.map((relative) => verdictFor(relative)).find((verdict) => verdict !== undefined);
  };
};
