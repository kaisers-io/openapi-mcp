import { describe, expect, it } from 'vitest';
import { createRouteTable, hopAuthorizer, routeEntriesFor, routeKey } from '../src/index.ts';
import {
  mayHaveOtherReadings,
  pathReadings,
  templateReadings,
} from '../src/server/execute/path-readings.ts';
import { ROUTE_MATCH_BUDGET, withReadings } from '../src/server/execute/route-table.ts';
import type { RouteEntry } from '../src/index.ts';

// Issue #40: every hop of a request is resolved against every operation of
// the spec. An excluded operation is never reached, whatever the arguments
// or the upstream's redirects.

const route = (method: string, path: string, exposed = true): RouteEntry => ({
  method,
  path,
  exposed,
});

describe('createRouteTable — resolving a request', () => {
  const table = createRouteTable([
    route('GET', '/items/{id}'),
    route('GET', '/items/export', false),
    route('GET', '/orders/{id}'),
    route('GET', '/orders/me'),
    route('DELETE', '/orders/{id}', false),
    route('GET', '/files/{name}.json'),
    route('GET', '/files/report.json', false),
    route('GET', '/v-{version}/status'),
  ]);

  it('lets a request reach the operation it was built from', () => {
    expect(table.authorize('GET', '/items/42', routeKey('GET', '/items/{id}'))).toBeUndefined();
    expect(
      table.authorize('GET', '/files/a.json', routeKey('GET', '/files/{name}.json')),
    ).toBeUndefined();
    expect(
      table.authorize('GET', '/v-2/status', routeKey('GET', '/v-{version}/status')),
    ).toBeUndefined();
  });

  it('matches a concrete path before a template, as OpenAPI does', () => {
    // The excluded concrete operation wins over the exposed template
    expect(table.authorize('GET', '/items/export', routeKey('GET', '/items/{id}'))).toBe(
      'not-exposed',
    );
    expect(table.authorize('GET', '/files/report.json')).toBe('not-exposed');
    // An exposed concrete operation is still another operation for hop 0...
    expect(table.authorize('GET', '/orders/me', routeKey('GET', '/orders/{id}'))).toBe(
      'other-operation',
    );
    // ...but a redirect may land on it
    expect(table.authorize('GET', '/orders/me')).toBeUndefined();
  });

  it('reads the request path as an upstream would', () => {
    // Percent-encoding and one trailing slash do not hide the operation
    expect(table.authorize('GET', '/items/%65xport')).toBe('not-exposed');
    expect(table.authorize('GET', '/items/export/')).toBe('not-exposed');
    expect(table.authorize('GET', '/items/42/')).toBeUndefined();
    // An encoded slash stays inside its segment
    expect(table.authorize('GET', '/items/a%2Fb')).toBeUndefined();
  });

  it('refuses a request that resolves to no operation', () => {
    expect(table.authorize('GET', '/unknown')).toBe('unknown');
    expect(table.authorize('GET', '/items/1/extra')).toBe('unknown');
    expect(table.authorize('POST', '/items/1')).toBe('unknown');
    expect(table.authorize('GET', '/files/a.txt')).toBe('unknown');
  });

  it('keeps an excluded method excluded on a shared path', () => {
    expect(table.authorize('DELETE', '/orders/1')).toBe('not-exposed');
  });
});

describe('createRouteTable — no ranking between templates', () => {
  // Neither template is more concrete than the other at `/users/me`
  const table = createRouteTable([
    route('GET', '/users/{id}'),
    route('GET', '/{entity}/me', false),
  ]);

  it('refuses a request two templates share when one of them is excluded', () => {
    // The tool's own operation, and one that is not exposed (issue #41)
    expect(table.authorize('GET', '/users/me', routeKey('GET', '/users/{id}'))).toBe('shared');
    expect(table.authorize('GET', '/users/7', routeKey('GET', '/users/{id}'))).toBeUndefined();
  });

  it('lets a shared request through when every template is exposed', () => {
    const exposed = createRouteTable([route('GET', '/users/{id}'), route('GET', '/{entity}/me')]);
    expect(exposed.authorize('GET', '/users/me', routeKey('GET', '/users/{id}'))).toBeUndefined();
  });
});

describe('createRouteTable — letter case', () => {
  it('only adds refusals: an excluded operation differing just by case is refused', () => {
    const table = createRouteTable([
      route('GET', '/Reports/{id}'),
      route('GET', '/reports/all', false),
    ]);
    // That URL is the other operation by case, not a shared one (issue #41)
    expect(table.authorize('GET', '/Reports/all', routeKey('GET', '/Reports/{id}'))).toBe(
      'not-exposed',
    );
    expect(table.authorize('GET', '/Reports/7', routeKey('GET', '/Reports/{id}'))).toBeUndefined();
  });

  it('never authorizes through case: an exposed operation in another case does not help', () => {
    const table = createRouteTable([route('GET', '/USERS/me'), route('GET', '/users/{id}', false)]);
    expect(table.authorize('GET', '/users/me')).toBe('not-exposed');
  });
});

describe('createRouteTable — HEAD', () => {
  it('matches a HEAD operation first and falls back to GET only without one', () => {
    const withHead = createRouteTable([
      route('GET', '/files/{id}'),
      route('HEAD', '/files/{id}', false),
    ]);
    expect(withHead.authorize('HEAD', '/files/1')).toBe('not-exposed');
    const getOnly = createRouteTable([route('GET', '/files/{id}')]);
    expect(getOnly.authorize('HEAD', '/files/1')).toBeUndefined();
  });
});

// Review of #40: a server may answer HEAD through its GET handler
// Review of #40: an excluded path is registered in the readings an upstream
// may give it too, so `/denied//export` also refuses `/denied/export`
describe('createRouteTable — readings of an excluded path', () => {
  it('refuses a request that reaches the excluded path once it is normalized', () => {
    const table = createRouteTable([
      route('GET', '/items/{id}'),
      route('GET', '/denied//export', false),
    ]);
    const authorize = hopAuthorizer(
      table,
      new URL('https://api.example.test/'),
      routeKey('GET', '/items/{id}'),
      false,
    );
    const url = new URL('/items/x%2F..%2F..%2Fdenied%2Fexport', 'https://api.example.test');
    expect(authorize(url, 'GET', 0)).toBe('route-refused');
    expect(table.authorize('GET', '/denied/export')).toBe('not-exposed');
  });
});

// Review of #40: decoding an excluded path must not turn encoded braces into a
// placeholder, or it would block every request a template shares
describe('createRouteTable — encoded braces in an excluded path', () => {
  const table = createRouteTable([
    route('GET', '/items/{id}'),
    route('GET', '/items/%7Breserved%7D', false),
  ]);

  it('keeps them literal text', () => {
    expect(table.authorize('GET', '/items/42', routeKey('GET', '/items/{id}'))).toBeUndefined();
    expect(table.authorize('GET', '/items/%7Breserved%7D')).toBe('not-exposed');
    expect(table.authorize('GET', '/items/%257Breserved%257D')).toBe('not-exposed');
  });
});

// Review of #40: split before decoding, as URL parsing reads `%2e%2e`
describe('createRouteTable — an excluded path that canonicalizes onto another', () => {
  it('refuses the path its dot segments resolve to', () => {
    const table = createRouteTable([
      route('GET', '/denied'),
      route('GET', '/a%2Fb/%2e%2e/denied', false),
    ]);
    expect(table.authorize('GET', '/denied', routeKey('GET', '/denied'))).toBe('shared');
    const authorize = hopAuthorizer(
      table,
      new URL('https://api.example.test/'),
      routeKey('GET', '/denied'),
      false,
    );
    expect(authorize(new URL('/denied', 'https://api.example.test'), 'GET', 0)).toBe(
      'route-overlap',
    );
  });
});

// Review of #40: dot segments and repeated slashes, in either order
describe('readings — dot segments before or after merging slashes', () => {
  it('refuses a redirect that resolves `..` against an empty segment', () => {
    const table = createRouteTable([
      route('GET', '/a/{id}/denied'),
      route('GET', '/a/denied', false),
    ]);
    const authorize = hopAuthorizer(
      table,
      new URL('https://api.example.test/'),
      routeKey('GET', '/a/{id}/denied'),
      false,
    );
    expect(authorize(new URL('/a/%2f../denied', 'https://api.example.test'), 'GET', 1)).toBe(
      'redirect-refused',
    );
  });

  it('registers an excluded path that resolves to the root', () => {
    const table = createRouteTable([route('GET', '/'), route('GET', '/x/..', false)]);
    expect(table.authorize('GET', '/', routeKey('GET', '/'))).toBe('shared');
    const authorize = hopAuthorizer(
      table,
      new URL('https://api.example.test/'),
      routeKey('GET', '/'),
      false,
    );
    expect(authorize(new URL('/', 'https://api.example.test'), 'GET', 0)).toBe('route-overlap');
  });

  it('registers an excluded path in both orders', () => {
    const table = createRouteTable([route('GET', '/x/{id}'), route('GET', '/x//../denied', false)]);
    // Merging first reads it as /denied, resolving `..` first as /x/denied
    expect(table.authorize('GET', '/denied')).toBe('not-exposed');
    expect(table.authorize('GET', '/x/denied')).toBe('not-exposed');
  });
});

describe('createRouteTable — HEAD through GET', () => {
  it('refuses a HEAD request that an excluded concrete GET would answer', () => {
    const table = createRouteTable([
      route('HEAD', '/items/{id}'),
      route('GET', '/items/export', false),
    ]);
    expect(table.authorize('HEAD', '/items/export', routeKey('HEAD', '/items/{id}'))).toBe(
      'not-exposed',
    );
    expect(table.authorize('HEAD', '/items/7', routeKey('HEAD', '/items/{id}'))).toBeUndefined();
  });

  // Review of #41: the GET reading of a HEAD tool's own path is shared
  it('reports a HEAD tool whose own path an excluded GET template shares', () => {
    const table = createRouteTable([
      route('HEAD', '/orders/me'),
      route('GET', '/orders/{id}', false),
    ]);
    expect(table.authorize('HEAD', '/orders/me', routeKey('HEAD', '/orders/me'))).toBe('shared');
    // A concrete GET of the same path wins, so nothing is refused
    const withGet = createRouteTable([
      route('HEAD', '/orders/me'),
      route('GET', '/orders/me'),
      route('GET', '/orders/{id}', false),
    ]);
    expect(withGet.authorize('HEAD', '/orders/me', routeKey('HEAD', '/orders/me'))).toBeUndefined();
  });
});

// Review of #40: text without `%` skips the byte-wise decoder, which must
// not change a reading. A lone surrogate still becomes U+FFFD, a leading
// U+FEFF is still dropped, and a malformed escape is still kept as written
describe('readings — text that needs no decoding', () => {
  it('reads as before for plain, malformed and invalid input', () => {
    expect(pathReadings('/orders/42')).toEqual(['/orders/42']);
    expect(pathReadings('/\uFEFFx')).toEqual(['/\uFEFFx', '/x']);
    expect(pathReadings('/\uD800x')).toEqual(['/\uD800x', '/\uFFFDx']);
    expect(pathReadings('/%zz')).toEqual(['/%zz']);
    expect(pathReadings('/%FFa')).toEqual(['/%FFa', '/\uFFFDa']);
    expect(
      templateReadings([[{ literal: '' }], [{ literal: '\uFEFFx' }, { param: true }]]),
    ).toEqual([[[{ literal: '\uFEFFx' }, { param: true }]], [[{ literal: 'x' }, { param: true }]]]);
  });
});

describe('createRouteTable — bounded work', () => {
  // Review of #40: the work multiplies across routes and readings, and runs
  // synchronously, so it is budgeted per hop and fails closed when spent
  it('refuses a hop whose matching work exceeds the budget, quickly', () => {
    const hostile = (index: number): string =>
      `/${Array.from({ length: 200 }, (_unused, at) => `{p${String(at)}}x`).join('')}q${String(index)}`;
    const table = createRouteTable([
      ...Array.from({ length: 10 }, (_unused, index) => route('GET', hostile(index), false)),
      route('GET', '/{id}'),
    ]);
    const authorize = hopAuthorizer(
      table,
      new URL('https://api.example.test/'),
      routeKey('GET', '/{id}'),
      false,
    );
    const started = performance.now();
    const url = new URL(`/${'x'.repeat(8000)}y`, 'https://api.example.test');
    expect(authorize(url, 'GET', 0)).toBe('route-refused');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(ROUTE_MATCH_BUDGET).toBe(1_000_000);
  });

  // Review of #40: a long literal compared at many positions is charged by
  // its length, not as one step
  it('charges long literal comparisons, so they cannot stall the server either', () => {
    // Building the table counts too: `serve` does it synchronously at startup
    const started = performance.now();
    const table = createRouteTable([
      ...Array.from({ length: 60 }, (_unused, index) =>
        route('GET', `/{id}${'a'.repeat(4000)}b${String(index)}`, false),
      ),
      route('GET', '/{id}'),
    ]);
    const authorize = hopAuthorizer(
      table,
      new URL('https://api.example.test/'),
      routeKey('GET', '/{id}'),
      false,
    );
    const url = new URL(`/${'a'.repeat(8000)}`, 'https://api.example.test');
    expect(authorize(url, 'GET', 0)).toBe('route-refused');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // A legitimate spec at the 4,096-operation limit must never hit the budget,
  // including one whose paths all start with a placeholder
  it('stays far below the budget for a spec at the operation limit', () => {
    const shapes = [
      (index: number) => `/r${String(index)}/{id}/sub/x`,
      (index: number) => `/{tenant}/r${String(index)}/{id}`,
      (index: number) => `/{a}/{b}/r${String(index)}`,
    ];
    for (const shape of shapes) {
      const paths = Array.from({ length: 4096 }, (_unused, index) => shape(index));
      const table = createRouteTable(
        paths.map((path, index) => route('GET', path, index % 2 === 0)),
      );
      const work = { remaining: ROUTE_MATCH_BUDGET };
      const request = shape(2).replaceAll(/\{[^}]*\}/gu, 'acme');
      const bound = routeKey('GET', shape(2));
      expect(table.authorize('GET', request, bound, work)).toBeUndefined();
      expect(ROUTE_MATCH_BUDGET - work.remaining).toBeLessThan(1000);
    }
  });

  it('stays far below the budget for an ordinary request', () => {
    const table = createRouteTable([route('GET', '/orders/{id}'), route('GET', '/orders/me')]);
    const work = { remaining: ROUTE_MATCH_BUDGET };
    expect(table.authorize('GET', '/orders/42', undefined, work)).toBeUndefined();
    expect(ROUTE_MATCH_BUDGET - work.remaining).toBeLessThan(100);
  });

  it('skips entries that are no paths, such as webhook omissions', () => {
    const table = createRouteTable([route('*', 'webhook:orderCreated', false)]);
    expect(table.authorize('GET', '/webhook:orderCreated')).toBe('unknown');
  });
});

describe('routeEntriesFor', () => {
  it('marks only the served tools exposed and keeps omitted and withheld operations', () => {
    const spec = {
      operations: [
        { method: 'get', path: '/a', tags: [], deprecated: false, parameters: [], responses: {} },
        {
          method: 'delete',
          path: '/a',
          tags: [],
          deprecated: false,
          parameters: [],
          responses: {},
        },
      ],
      omitted: [{ method: 'POST', path: '/a', reason: 'callbacks are not supported' }],
    } as const;
    const entries = routeEntriesFor(
      spec,
      [{ method: 'PUT', path: '/a', reason: 'withheld' }],
      [{ method: 'get', path: '/a' }],
    );
    expect(entries).toEqual([
      { method: 'GET', path: '/a', exposed: true },
      { method: 'DELETE', path: '/a', exposed: false },
      { method: 'POST', path: '/a', exposed: false },
      { method: 'PUT', path: '/a', exposed: false },
    ]);
  });
});

describe('hopAuthorizer', () => {
  const table = createRouteTable([
    route('GET', '/safe'),
    route('GET', '/denied', false),
    route('GET', '/other'),
  ]);
  const base = new URL('https://api.example.test/api');
  const bound = routeKey('GET', '/safe');
  const strict = hopAuthorizer(table, base, bound, false);
  const lenient = hopAuthorizer(table, base, bound, true);
  const at = (path: string): URL => new URL(path, 'https://api.example.test');

  it('checks hop 0 against the tool’s own operation', () => {
    expect(strict(at('/api/safe'), 'GET', 0)).toBeUndefined();
    expect(strict(at('/api/other'), 'GET', 0)).toBe('route-refused');
    expect(strict(at('/api/denied'), 'GET', 0)).toBe('route-refused');
  });

  it('lets a redirect reach an exposed operation only', () => {
    expect(strict(at('/api/other'), 'GET', 1)).toBeUndefined();
    expect(strict(at('/api/denied'), 'GET', 1)).toBe('redirect-refused');
    expect(strict(at('/api/denied/'), 'GET', 1)).toBe('redirect-refused');
    expect(strict(at('/api/nowhere'), 'GET', 1)).toBe('redirect-refused');
  });

  it('refuses a redirect off the API unless the operator opted in', () => {
    for (const target of [
      'https://cdn.example.test/file',
      'https://api.example.test/apix/safe',
      'https://api.example.test/',
    ]) {
      expect(strict(new URL(target), 'GET', 1)).toBe('redirect-offsite');
      expect(lenient(new URL(target), 'GET', 1)).toBeUndefined();
    }
    // Hop 0 off the API is never allowed, opt-in or not
    expect(lenient(new URL('https://cdn.example.test/file'), 'GET', 0)).toBe('route-refused');
    // Back on the API, a later hop is checked again
    expect(lenient(at('/api/denied'), 'GET', 2)).toBe('redirect-refused');
  });
});

// Review of #40: an upstream may decode an encoded separator, resolve the dot
// segments that decoding produces, take `\` as a separator, or decode the base
// path before routing. Every such reading counts, but only to refuse.
describe('hopAuthorizer — other readings of a path', () => {
  const table = createRouteTable([
    route('GET', '/items/{id}'),
    route('GET', '/items/private/export', false),
    route('GET', '/denied', false),
    route('GET', '/projects/{id}'),
  ]);
  const origin = 'https://api.example.test';
  const authorizer = (basePath: string, allowOffsite: boolean) =>
    hopAuthorizer(table, new URL(basePath, origin), routeKey('GET', '/items/{id}'), allowOffsite);
  const strict = authorizer('/api', false);
  const at = (path: string): URL => new URL(path, origin);

  it('refuses a path that reaches an excluded operation once a separator is decoded', () => {
    for (const path of [
      '/api/items/private%2Fexport',
      '/api/items/private%2fexport',
      '/api/items/private%5Cexport',
      '/api/items/x%2F..%2F..%2Fdenied',
      '/api/items/x%2F%2E%2E%2F%2E%2E%2Fdenied',
    ]) {
      expect(strict(at(path), 'GET', 1)).toBe('redirect-refused');
      expect(strict(at(path), 'GET', 0)).toBe('route-refused');
    }
  });

  it('still lets an encoded slash reach its own operation', () => {
    // As in GitLab's /projects/:id with id "group/project"
    const projects = hopAuthorizer(
      table,
      new URL('/api', origin),
      routeKey('GET', '/projects/{id}'),
      false,
    );
    expect(projects(at('/api/projects/group%2Fproject'), 'GET', 0)).toBeUndefined();
    expect(strict(at('/api/items/a%2Fb'), 'GET', 1)).toBeUndefined();
  });

  it('treats a reading that climbs out of the base as off the API', () => {
    expect(strict(at('/api/items/..%2F..%2Fother'), 'GET', 0)).toBe('route-refused');
    expect(strict(at('/api/items/..%2F..%2Fother'), 'GET', 1)).toBe('redirect-offsite');
    expect(authorizer('/api', true)(at('/api/items/..%2F..%2Fother'), 'GET', 1)).toBeUndefined();
  });

  it('treats a percent-encoded or differently cased base path as on the API', () => {
    const lenient = authorizer('/api', true);
    for (const path of ['/%61pi/items/private/export', '/API/items/private/export']) {
      expect(lenient(at(path), 'GET', 1)).toBe('redirect-refused');
    }
    expect(lenient(at('/%61pi/items/7'), 'GET', 1)).toBeUndefined();
  });

  it('matches an encoded base path in the configuration in its decoded form too', () => {
    const encodedBase = authorizer('/%61pi', true);
    expect(encodedBase(at('/api/denied'), 'GET', 1)).toBe('redirect-refused');
    expect(encodedBase(at('/api/items/7'), 'GET', 1)).toBeUndefined();
  });
});

// Review of #40: repeated slashes, as NGINX merges them by default
describe('hopAuthorizer — merged slashes', () => {
  it('refuses a redirect whose decoded reading reaches the excluded operation via //', () => {
    const table = createRouteTable([route('GET', '/items/{id}'), route('GET', '/denied', false)]);
    const authorize = hopAuthorizer(
      table,
      new URL('/api', 'https://api.example.test'),
      routeKey('GET', '/items/{id}'),
      false,
    );
    const url = new URL('/api/items/x%2F..%2F..%2F%2Fdenied', 'https://api.example.test');
    expect(authorize(url, 'GET', 1)).toBe('redirect-refused');
  });
});

// Review of #40: NGINX decodes byte by byte and keeps `;` when it decodes
describe('hopAuthorizer — byte-level decoding and segment parameters', () => {
  const table = createRouteTable([
    route('GET', '/items/{id}'),
    route('GET', '/denied', false),
    route('GET', '/items/private;v=1/export', false),
  ]);
  const authorize = hopAuthorizer(
    table,
    new URL('/api', 'https://api.example.test'),
    routeKey('GET', '/items/{id}'),
    false,
  );
  const at = (path: string): URL => new URL(path, 'https://api.example.test');

  it('decodes past an invalid UTF-8 byte', () => {
    expect(authorize(at('/api/items/%FF%2F..%2F..%2Fdenied'), 'GET', 1)).toBe('redirect-refused');
    expect(authorize(at('/api/items/%C3%2F..%2F..%2Fdenied'), 'GET', 1)).toBe('redirect-refused');
  });

  it('reads a segment with and without its parameters', () => {
    expect(authorize(at('/api/items/private%3Bv=1%2Fexport'), 'GET', 1)).toBe('redirect-refused');
    expect(authorize(at('/api/items/x/..;/..;/denied'), 'GET', 1)).toBe('redirect-refused');
  });
});

// Review of #40: the readings combine. Every mix of letter case, encoded
// separators, encoded dot segments and base path spellings that an upstream
// could route to the excluded operation is refused, opt-in or not.
describe('hopAuthorizer — combined readings', () => {
  const table = createRouteTable([
    route('GET', '/items/{id}'),
    route('GET', '/items/private/export', false),
  ]);
  const origin = 'https://api.example.test';
  const authorizer = (allowOffsite: boolean) =>
    hopAuthorizer(table, new URL('/api', origin), routeKey('GET', '/items/{id}'), allowOffsite);
  const product = (...lists: readonly (readonly string[])[]): string[] =>
    lists.reduce<string[]>(
      (paths, list) => paths.flatMap((path) => list.map((part) => `${path}${part}`)),
      [''],
    );

  it('refuses every combination that reaches the excluded operation', () => {
    const paths = product(
      ['/api', '/%61pi', '/API', '/%41PI'],
      ['/items/'],
      [
        '',
        'x%2F..%2F',
        'x%2F%2E%2E%2F',
        'x%5C..%5C',
        'x%2F..%2F%2F',
        'x/..;/',
        'x%252F..%252F',
        '%2F%2F',
      ],
      ['private', 'PRIVATE', 'Private', '%70rivate'],
      ['/', '%2F', '%2f', '%5C', '%5c', '//', '%2F%2F', ';v=1/'],
      ['export', 'EXPORT'],
    );
    expect(paths).toHaveLength(2048);
    for (const allowOffsite of [false, true]) {
      const authorize = authorizer(allowOffsite);
      const allowed = paths.filter(
        (path) => authorize(new URL(path, origin), 'GET', 1) === undefined,
      );
      expect(allowed).toEqual([]);
    }
  });

  it('still allows the exposed operation in those spellings', () => {
    for (const path of ['/api/items/7', '/API/items/7', '/api/items/a%2Fb']) {
      expect([path, authorizer(false)(new URL(path, origin), 'GET', 1)]).toEqual([path, undefined]);
    }
    // Off the API as written: allowed only with the opt-in, and then only
    // because the decoded reading is an exposed operation
    expect(authorizer(false)(new URL('/%61pi/items/7', origin), 'GET', 1)).toBe('redirect-offsite');
    expect(authorizer(true)(new URL('/%61pi/items/7', origin), 'GET', 1)).toBeUndefined();
  });
});

// Issue #47: a path without anything a reading can change is read only as
// written, so its readings are skipped. Proven against templateReadings on
// generated paths and on the special characters it acts on.
describe('readings — skipped only for paths that cannot have other readings', () => {
  const pieces = [
    'a',
    'B',
    '{id}',
    'x.json',
    '',
    '.',
    '..',
    '%2F',
    'a;b',
    'a\\b',
    '\uFEFFa',
    '\uD800',
    'ü',
    '{p}{q}',
    '*',
  ];

  it('finds no other reading for any path it skips', () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    let skipped = 0;
    for (let run = 0; run < 4000; run += 1) {
      const path = `/${Array.from({ length: 1 + random(4) }, () => pieces[random(pieces.length)]).join('/')}`;
      if (mayHaveOtherReadings(path)) {
        continue;
      }
      skipped += 1;
      // Without a `%`, the route's compiled tokens are its raw tokens
      const [compiled] = withReadings({ method: 'GET', path, exposed: false });
      const written = JSON.stringify(compiled?.segments);
      for (const reading of templateReadings(compiled?.segments ?? [])) {
        const segments = [
          [{ literal: '' }],
          ...(reading.length === 0 ? [[{ literal: '' }]] : reading),
        ];
        expect({ path, reading: JSON.stringify(segments) }).toEqual({ path, reading: written });
      }
    }
    expect(skipped).toBeGreaterThan(500);
  });

  it('keeps the readings of every path that has a trigger', () => {
    for (const path of [
      '/a%2Fb',
      '/a;b',
      '/a\\b',
      '/a//b',
      '/a/./b',
      '/a/../b',
      '/\uFEFFa',
      '/a\uD800',
      '/',
    ]) {
      expect(mayHaveOtherReadings(path)).toBe(true);
    }
    expect(mayHaveOtherReadings('/orders/{orderId}/items')).toBe(false);
  });
});
