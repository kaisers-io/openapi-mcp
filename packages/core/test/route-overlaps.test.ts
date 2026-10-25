import { describe, expect, it } from 'vitest';
import { routeOverlaps } from '../src/index.ts';
import type { RouteEntry } from '../src/index.ts';
import { OVERLAP_WORK_BUDGET } from '../src/server/execute/route-overlaps.ts';

// Issue #41: an exposed operation whose path can match the same URL as one
// that is not exposed is refused for those URLs (templates are not ranked).
// That is reported at startup instead of only failing calls.

const route = (method: string, path: string, exposed = true): RouteEntry => ({
  method,
  path,
  exposed,
});

const pairs = (entries: readonly RouteEntry[]): string[] =>
  routeOverlaps(entries).overlaps.map((overlap) => `${overlap.exposed} | ${overlap.excluded}`);

describe('routeOverlaps', () => {
  it('reports a template that overlaps an excluded template', () => {
    expect(
      pairs([
        route('GET', '/orders/{orderId}/items'),
        route('GET', '/orders/{orderId}/{section}', false),
      ]),
    ).toEqual(['GET /orders/{orderId}/items | GET /orders/{orderId}/{section}']);
    // A partial overlap counts too: `/files/ab` matches both
    expect(pairs([route('GET', '/files/{id}'), route('GET', '/files/a{x}', false)])).toEqual([
      'GET /files/{id} | GET /files/a{x}',
    ]);
    expect(
      pairs([route('GET', '/files/{name}.json'), route('GET', '/files/{name}', false)]),
    ).toEqual(['GET /files/{name}.json | GET /files/{name}']);
  });

  it('uses the readings of an excluded path, reported once', () => {
    expect(pairs([route('GET', '/orders/{id}'), route('GET', '/orders//{id}', false)])).toEqual([
      'GET /orders/{id} | GET /orders//{id}',
    ]);
  });

  // Review of #41: the request authorization reads the exposed path too
  it('uses the readings of an exposed path', () => {
    expect(
      pairs([route('GET', '/orders//{id}/items'), route('GET', '/orders/{id}/{section}', false)]),
    ).toEqual(['GET /orders//{id}/items | GET /orders/{id}/{section}']);
    // A concrete reading wins only through a concrete operation of that path
    expect(pairs([route('GET', '/orders//me'), route('GET', '/orders/{id}', false)])).toEqual([
      'GET /orders//me | GET /orders/{id}',
    ]);
    expect(
      pairs([
        route('GET', '/orders//me'),
        route('GET', '/orders/me'),
        route('GET', '/orders/{id}', false),
      ]),
    ).toEqual([]);
  });

  it('compares an excluded path with a dot segment only in its readings', () => {
    // `/{a}/{b}/..` is sent as `/{a}`: URL parsing resolves the `..`
    expect(pairs([route('GET', '/{x}.json/{y}/{z}'), route('GET', '/{a}/{b}/..', false)])).toEqual(
      [],
    );
    expect(pairs([route('GET', '/{x}.json'), route('GET', '/{a}/{b}/..', false)])).toEqual([
      'GET /{x}.json | GET /{a}/{b}/..',
    ]);
  });

  it('reports a concrete path an excluded template matches only by case', () => {
    expect(pairs([route('GET', '/ORDERS/me'), route('GET', '/orders/{id}', false)])).toEqual([
      'GET /ORDERS/me | GET /orders/{id}',
    ]);
    // Concrete before templated: the exact match is no overlap
    expect(pairs([route('GET', '/orders/me'), route('GET', '/orders/{id}', false)])).toEqual([]);
    expect(pairs([route('GET', '/orders/me'), route('GET', '/Orders/me', false)])).toEqual([
      'GET /orders/me | GET /Orders/me',
    ]);
  });

  it('resolves HEAD as GET too, where only a concrete GET path wins', () => {
    expect(pairs([route('HEAD', '/orders/me'), route('GET', '/orders/{id}', false)])).toEqual([
      'HEAD /orders/me | GET /orders/{id}',
    ]);
    // Review of #41: the concrete GET wins, as in the route table
    expect(
      pairs([
        route('HEAD', '/orders/me'),
        route('GET', '/orders/me'),
        route('GET', '/orders/{id}', false),
      ]),
    ).toEqual([]);
    // A concrete GET inside a HEAD template is that URL of another operation
    expect(pairs([route('HEAD', '/items/{id}'), route('GET', '/items/export', false)])).toEqual([]);
  });

  // Review of #41: `/Reports/all` is the excluded operation by case, which
  // the tool error says, as for `id: "export"`
  it('does not report a concrete path inside a template that differs only by case', () => {
    expect(pairs([route('GET', '/Reports/{id}'), route('GET', '/reports/all', false)])).toEqual([]);
  });

  // Review of #41: the only URL both templates match belongs to a concrete
  // operation, which wins
  it('does not report a shared URL that a concrete operation owns', () => {
    expect(
      pairs([
        route('GET', '/users/{id}/items'),
        route('GET', '/users/123/{part}', false),
        route('GET', '/users/123/items'),
      ]),
    ).toEqual([]);
    expect(
      pairs([route('GET', '/users/{id}/items'), route('GET', '/users/123/{part}', false)]),
    ).toEqual(['GET /users/{id}/items | GET /users/123/{part}']);
    // `/users/ME/items` is no concrete operation, and matching regardless of
    // case refuses it, so this one is reported
    expect(
      pairs([
        route('GET', '/users/{id}/items'),
        route('GET', '/users/me/{part}', false),
        route('GET', '/users/me/items'),
      ]),
    ).toEqual(['GET /users/{id}/items | GET /users/me/{part}']);
  });

  it('does not report what never shares a URL, or the one URL another operation owns', () => {
    expect(
      pairs([
        route('GET', '/orders/{id}'),
        route('GET', '/customers/{id}', false),
        route('DELETE', '/orders/{id}', false),
        route('GET', '/orders/{id}/items', false),
        route('GET', '/files/{name}.json'),
        route('GET', '/files/{name}.xml', false),
        // `id: "export"` is the excluded operation: that is the check's job
        route('GET', '/orders/export', false),
      ]),
    ).toEqual([]);
  });

  // A spec at the 4,096-operation limit, half of it excluded, stays complete
  it('stays within the budget for a large spec of similar paths', () => {
    const shapes = [
      (index: number) => `/r${String(index)}/{id}/sub/x`,
      (index: number) => `/{tenant}/r${String(index)}/{id}`,
    ];
    for (const shape of shapes) {
      const entries = Array.from({ length: 4096 }, (_unused, index) =>
        route('GET', shape(index), index % 2 === 0),
      );
      const started = performance.now();
      expect(routeOverlaps(entries)).toEqual({ overlaps: [], complete: true });
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });

  // Review of #44: a common prefix such as `/v1` must not put every route in
  // one bucket
  it('compares a route only with those that share its most selective plain segment', () => {
    const catalog = Array.from({ length: 1024 }, (_unused, index) =>
      route('GET', `/v1/resources${String(index)}/{id}`, index % 2 === 0),
    );
    expect(routeOverlaps(catalog)).toEqual({ overlaps: [], complete: true });
    // The chosen segment differs per route, and overlaps are still found
    const others = Array.from({ length: 50 }, (_unused, index) =>
      route('GET', `/v1/other${String(index)}/{id}`, false),
    );
    expect(
      pairs([
        ...others,
        route('GET', '/v1/orders/{id}'),
        route('GET', '/v1/{kind}/{id}', false),
        route('GET', '/beta/{a}/x'),
        route('GET', '/beta/{b}/{c}', false),
      ]),
    ).toEqual(['GET /v1/orders/{id} | GET /v1/{kind}/{id}', 'GET /beta/{a}/x | GET /beta/{b}/{c}']);
  });

  // Review of #44: compiling paths and their readings is charged before it
  // is done, so long paths cannot run past the budget
  it('charges compiling and reading paths', () => {
    const long = `/${'a'.repeat(5000)}/{id}`;
    expect(routeOverlaps([route('GET', long), route('GET', '/x/{id}', false)], 4000)).toEqual({
      overlaps: [],
      complete: false,
    });
  });

  it('stops when the work budget is spent, and says the list is incomplete', () => {
    const long = (prefix: string): string =>
      `/${Array.from({ length: 300 }, () => `{p}${prefix}`).join('')}`;
    const entries = [
      ...Array.from({ length: 4 }, (_unused, index) => route('GET', long(`a${String(index)}`))),
      ...Array.from({ length: 4 }, (_unused, index) =>
        route('GET', long(`b${String(index)}`), false),
      ),
    ];
    expect(routeOverlaps(entries, 10_000)).toEqual({ overlaps: [], complete: false });
    // Review of #41: what was found before the budget ran out is kept
    // Enough to compile the paths and compare the short pair, not the long one
    const found = routeOverlaps(
      [route('GET', '/{p}'), route('GET', '/{y}', false), route('GET', long('b'), false)],
      long('b').length + 200,
    );
    expect(found).toEqual({
      overlaps: [{ exposed: 'GET /{p}', excluded: 'GET /{y}' }],
      complete: false,
    });
    expect(OVERLAP_WORK_BUDGET).toBe(5_000_000);
  });
});
