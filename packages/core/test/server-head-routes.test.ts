import { describe, expect, it } from 'vitest';
import { createRouteTable, headsWithoutGet, routeKey } from '../src/index.ts';
import type { RouteEntry } from '../src/index.ts';

// Issue #68: an exposed HEAD is left out only when no call it can make passes
// request authorization, because a GET that is not exposed covers every one
// of its URLs. Every expectation is written by hand from the routes.
const entry = (method: string, path: string, exposed: boolean): RouteEntry => ({
  method,
  path,
  exposed,
});
const get = (path: string, exposed = false) => entry('GET', path, exposed);
const head = (path: string) => entry('HEAD', path, true);

describe('headsWithoutGet', () => {
  it.each([
    ['the same template', [get('/a/{id}'), head('/a/{id}')], '/a/{id}'],
    [
      'other placeholder names',
      [get('/orders/{orderId}'), head('/orders/{id}')],
      '/orders/{orderId}',
    ],
    ['other letter case', [get('/Orders/{id}'), head('/orders/{id}')], '/Orders/{id}'],
    ['the same non-ASCII text', [get('/a/{id}Σ'), head('/a/{x}Σ')], '/a/{id}Σ'],
    ['percent-encoding', [get('/caf%C3%A9/{id}'), head('/café/{id}')], '/caf%C3%A9/{id}'],
    ['a text part in the segment', [get('/f/{name}.json'), head('/f/{n}.JSON')], '/f/{name}.json'],
    ['a broader template', [get('/a/{id}'), head('/a/prefix-{id}')], '/a/{id}'],
    ['two placeholders under one', [get('/a/{id}'), head('/a/{x}-{y}')], '/a/{id}'],
    ['a concrete HEAD under a template', [get('/a/{id}'), head('/a/x')], '/a/{id}'],
    ['a reading of the GET path', [get('/a//{id}'), head('/a/{id}')], '/a//{id}'],
    [
      'an exposed template next to the excluded one',
      [get('/a/{id}', true), get('/a/{key}'), head('/a/{x}')],
      '/a/{key}',
    ],
  ])('leaves out a HEAD under %s', (_name, entries, refusing) => {
    const last = entries.at(-1);
    expect(headsWithoutGet(entries)).toStrictEqual(
      new Map([[routeKey('HEAD', last?.path ?? ''), refusing]]),
    );
  });

  it.each([
    ['the GET is exposed', [get('/a/{id}', true), head('/a/{id}')]],
    ['there is no GET', [head('/a/{id}')]],
    ['the HEAD is not exposed', [get('/a/{id}'), entry('HEAD', '/a/{id}', false)]],
    // A concrete path wins over every template: HEAD /a/safe passes
    [
      'an exposed concrete GET is one of its URLs',
      [get('/a/{id}'), get('/a/safe', true), head('/a/{id}')],
    ],
    ['an exposed concrete GET is its own path', [get('/a/{id}'), get('/a/x', true), head('/a/x')]],
    // Only some URLs are refused: the startup overlap warning reports it
    ['a concrete GET inside its template', [get('/a/x'), head('/a/{id}')]],
    ['a narrower GET template', [get('/a/prefix-{id}'), head('/a/{id}')]],
    ['another segment count', [get('/a'), head('/a/{id}')]],
    ['a text part the HEAD lacks', [get('/a/{id}.json'), head('/a/{id}')]],
    ['a webhook key', [get('orderCreated'), entry('HEAD', 'orderCreated', true)]],
    // `AΣ` folds to `aς` in a request, while the template text `Σ` folds to `σ`
    ['a non-ASCII letter in another case', [get('/a/{id}σ'), head('/a/{id}Σ')]],
    // Neither mode matches `/A/AΣ`: as written `a` is not `A`, folded `aς` is not `σ`
    ['another case in one segment and non-ASCII in another', [get('/a/{id}Σ'), head('/A/{id}Σ')]],
  ])('keeps a HEAD when %s', (_name, entries) => {
    expect(headsWithoutGet(entries).size).toBe(0);
  });

  it('agrees with the route table on every listed case', () => {
    // A HEAD it leaves out is refused by the route table for sample URLs, and
    // a concrete HEAD it keeps is allowed
    const cases: { entries: RouteEntry[]; url: string; refused: boolean }[] = [
      { entries: [get('/a/{id}'), head('/a/prefix-{id}')], url: '/a/prefix-1', refused: true },
      { entries: [get('/a//{id}'), head('/a/{id}')], url: '/a/1', refused: true },
      { entries: [get('/a/{id}'), head('/a/x')], url: '/a/x', refused: true },
      {
        entries: [get('/a/{id}'), get('/a/safe', true), head('/a/{id}')],
        url: '/a/safe',
        refused: false,
      },
    ];
    for (const { entries, url, refused } of cases) {
      const own = entries.at(-1);
      const verdict = createRouteTable(entries).authorize(
        'HEAD',
        url,
        routeKey('HEAD', own?.path ?? ''),
      );
      expect({ url, refused: verdict !== undefined }).toStrictEqual({ url, refused });
    }
  });

  // Soundness against the route table itself: over many generated route
  // sets, every URL of a HEAD it leaves out is refused. Seeded, so a failure
  // reproduces.
  it('leaves out no HEAD that the route table lets any sample URL through', () => {
    let seed = 68;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)] as T;
    const SEGMENTS = [
      'a',
      'A',
      'x',
      'safe',
      '{id}',
      'prefix-{id}',
      '{p}-{q}',
      '{id}.json',
      '',
      '{id}σ',
      '{id}Σ',
      'Σ',
      'İ{id}',
    ];
    const VALUES = ['x', 'safe', '1', 'prefix-1', 'a', 'A', 'b-c', 'y.json', 'Σ', 'İ'];
    const pathOf = (): string =>
      `/${Array.from({ length: 1 + random(3) }, () => pick(SEGMENTS)).join('/')}`;
    const fill = (path: string): string => path.replaceAll(/\{[a-z]+\}/gu, () => pick(VALUES));
    let removed = 0;
    for (let round = 0; round < 20_000; round += 1) {
      const entries = [
        ...Array.from({ length: 1 + random(3) }, () => get(pathOf(), random(3) === 0)),
        head(pathOf()),
      ];
      const own = entries.at(-1)?.path ?? '';
      if (headsWithoutGet(entries).size === 0) {
        continue;
      }
      removed += 1;
      const table = createRouteTable(entries);
      for (let sample = 0; sample < 12; sample += 1) {
        const url = fill(own);
        const verdict = table.authorize('HEAD', url, routeKey('HEAD', own));
        expect({ entries, url, verdict }).toMatchObject({ verdict: expect.any(String) });
      }
    }
    // The generator must actually exercise removals
    expect(removed).toBeGreaterThan(100);
  });

  // Exhaustive over a small alphabet: every pair of one excluded GET and one
  // HEAD of up to two segments, every URL from every combination of sample
  // values. Mixed letter case and context-dependent lower case included.
  it('leaves out no HEAD that the route table lets any URL through, for every small pair', () => {
    const SEGMENTS = ['a', 'A', 'x', '{id}', 'p-{id}', '{id}Σ', '{id}σ', 'Σ', 'İ{id}'];
    const VALUES = ['x', 'A', 'a', 'p-1', 'Σ', 'İ', 'AΣ'];
    const paths = [
      ...SEGMENTS.map((first) => `/${first}`),
      ...SEGMENTS.flatMap((first) => SEGMENTS.map((second) => `/${first}/${second}`)),
    ];
    const urlsOf = (path: string): string[] =>
      path
        .split(/\{[a-z]+\}/u)
        .reduce<string[]>(
          (urls, part, index) =>
            index === 0
              ? [part]
              : urls.flatMap((url) => VALUES.map((value) => `${url}${value}${part}`)),
          [],
        );
    const segmentsOf = (path: string): number => path.split('/').length;
    const concrete = paths.filter((path) => !path.includes('{'));
    // Collected and checked once: an expect per URL costs more than the check
    const allowed: { entries: RouteEntry[]; url: string }[] = [];
    const expectAllRefused = (entries: RouteEntry[], headPath: string): void => {
      const table = createRouteTable(entries);
      for (const url of urlsOf(headPath)) {
        if (table.authorize('HEAD', url, routeKey('HEAD', headPath)) === undefined) {
          allowed.push({ entries, url });
        }
      }
    };
    let removed = 0;
    for (const getPath of paths) {
      for (const headPath of paths) {
        const entries = [get(getPath), head(headPath)];
        if (headsWithoutGet(entries).size === 0) {
          continue;
        }
        removed += 1;
        expectAllRefused(entries, headPath);
        // An exposed concrete GET next to it may only keep the HEAD. Only one
        // with as many segments can be one of its URLs.
        for (const path of concrete.filter((other) => segmentsOf(other) === segmentsOf(headPath))) {
          const withConcrete = [get(getPath), get(path, true), head(headPath)];
          if (headsWithoutGet(withConcrete).size > 0) {
            expectAllRefused(withConcrete, headPath);
          }
        }
      }
    }
    expect(allowed).toStrictEqual([]);
    expect(removed).toBeGreaterThan(100);
    // Under a second alone, several on a loaded CI runner
  }, 30_000);

  it('keeps every HEAD it has not proven when the work budget runs out', () => {
    expect(headsWithoutGet([get('/a/{id}'), head('/a/{id}')], 0).size).toBe(0);
  });
});
