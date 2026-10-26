import { describe, expect, it } from 'vitest';
import { apiViews, assertSeparateApis, combinedContentHash, MAX_APIS } from '../src/multi-api.ts';
import type { Occurrence } from '../src/multi-api.ts';

// Several APIs behind one serve (issue #16): splitting the options by API

const base = {
  allow: [] as string[],
  deny: [] as string[],
  specHeaderEnv: [] as string[],
  omitOutputSchema: [] as string[],
  headerEnv: [] as string[],
  header: [] as string[],
  upstreamOauthScope: [] as string[],
  ttl: '1h',
  toolMode: 'discover',
};
const defaults = { ttl: '1h', upstreamOauthClientAuth: 'client_secret_basic' };
const views = (opts: Record<string, unknown>, occurrences: Occurrence[] = []) =>
  apiViews<Record<string, unknown> & { deny: readonly string[] }>(
    { ...base, ...opts },
    occurrences,
    defaults,
  );
const two = ['github=https://api.example.test/github.json', 'shop=./shop.yaml'];

describe('apiViews (#16)', () => {
  it('leaves a single API alone, and refuses --enable without --api', () => {
    expect(views({ spec: 'spec.json' })).toBeUndefined();
    expect(() => views({ spec: 'spec.json', enable: ['x=trust-spec-updates'] })).toThrow(
      '--enable needs --api',
    );
  });

  it('splits every per-API option by its prefix, consuming exactly one', () => {
    const result = views(
      {
        api: two,
        allow: ['github=tag:repos', 'shop=path:/orders/**'],
        deny: ['method:delete', 'shop=route:GET /admin=x/**'],
        headerEnv: ['github=Authorization=GITHUB_TOKEN', 'shop=X-Api-Key=SHOP_KEY'],
        header: ['shop=X-Query:a=b'],
        enable: ['shop=allow-private-network', 'github=trust-spec-updates'],
        toolMode: 'discover',
      },
      [
        { flag: '--base-url', value: 'shop=https://shop.example.test/v1?x=1' },
        { flag: '--ttl', value: 'github=2h' },
      ],
    );
    expect(result?.map((view) => [view.name, view.source])).toStrictEqual([
      ['github', 'https://api.example.test/github.json'],
      ['shop', './shop.yaml'],
    ]);
    const [github, shop] = result ?? [];
    expect(github?.options).toMatchObject({
      spec: 'https://api.example.test/github.json',
      allow: ['tag:repos'],
      deny: ['method:delete'],
      headerEnv: ['Authorization=GITHUB_TOKEN'],
      header: [],
      ttl: '2h',
      trustSpecUpdates: true,
      toolMode: 'discover',
    });
    expect(github?.options['allowPrivateNetwork']).toBeUndefined();
    expect(github?.options['baseUrl']).toBeUndefined();
    expect(shop?.options).toMatchObject({
      allow: ['path:/orders/**'],
      deny: ['method:delete', 'route:GET /admin=x/**'],
      headerEnv: ['X-Api-Key=SHOP_KEY'],
      header: ['X-Query:a=b'],
      baseUrl: 'https://shop.example.test/v1?x=1',
      ttl: '1h',
      allowPrivateNetwork: true,
    });
    expect(shop?.options).not.toHaveProperty('api');
    expect(shop?.options).not.toHaveProperty('enable');
  });

  it.each([
    [{ api: two, spec: 'x.json' }, [], '--spec and --api cannot be combined'],
    [{ api: ['github'] }, [], 'is not <name>=<source>'],
    [{ api: ['GitHub=x.json'] }, [], 'is not <name>=<source>'],
    [{ api: ['my_api=x.json'] }, [], 'is not <name>=<source>'],
    [{ api: ['a=x.json', 'a=y.json'] }, [], '--api names "a" twice'],
    [{ api: two, allow: ['tag:repos'] }, [], 'does not start with the name of an API'],
    [{ api: two, allow: ['crm=tag:repos'] }, [], 'does not start with the name of an API'],
    [{ api: two, deny: ['crm=method:delete'] }, [], 'does not start with the name of an API'],
    [{ api: two, headerEnv: ['Authorization=TOKEN'] }, [], 'does not start with the name'],
    [
      { api: two },
      [{ flag: '--base-url', value: 'https://api.example.test' }],
      'does not start with the name',
    ],
    [
      { api: two },
      [
        { flag: '--base-url', value: 'shop=https://a.example.test' },
        { flag: '--base-url', value: 'shop=https://b.example.test' },
      ],
      '--base-url is given twice for the API "shop"',
    ],
    [
      { api: two },
      [{ flag: '--nullable-response-fields', value: true }],
      '--nullable-response-fields needs <name>=<value>',
    ],
    [
      { api: two },
      [{ flag: '--allow-private-network', value: true }],
      'write --enable <name>=allow-private-network',
    ],
    [{ api: two, enable: ['shop=uploads'] }, [], 'names no switch'],
    [{ api: two, enable: ['crm=trust-spec-updates'] }, [], 'does not start with the name'],
  ])('refuses %j %j', (opts, occurrences, message) => {
    expect(() => views(opts, occurrences as Occurrence[])).toThrow(message);
  });

  it(`accepts up to ${String(MAX_APIS)} APIs`, () => {
    const many = (count: number) =>
      Array.from(
        { length: count },
        (_unused, index) => `api${String(index)}=x${String(index)}.json`,
      );
    expect(views({ api: many(MAX_APIS) })).toHaveLength(MAX_APIS);
    expect(() => views({ api: many(MAX_APIS + 1) })).toThrow(`at most ${String(MAX_APIS)} APIs`);
  });
});

describe('assertSeparateApis (#16)', () => {
  const api = (name: string, url: string, namespace = name) => ({
    name,
    namespace,
    base: new URL(url),
  });

  it('accepts APIs on separate paths of one origin', () => {
    expect(() =>
      assertSeparateApis([
        api('a', 'https://api.example.test/a'),
        api('b', 'https://api.example.test/b'),
        api('c', 'https://other.example.test/'),
      ]),
    ).not.toThrow();
  });

  it('refuses an overlapping base URL, in any letter case', () => {
    expect(() =>
      assertSeparateApis([
        api('a', 'https://api.example.test/'),
        api('b', 'https://api.example.test/b'),
      ]),
    ).toThrow('the base URLs of the APIs "a" and "b" overlap');
    expect(() =>
      assertSeparateApis([
        api('a', 'https://api.example.test/V1/shop'),
        api('b', 'https://api.example.test/v1'),
      ]),
    ).toThrow('overlap');
  });

  // Review of #16: the check uses the readings the credential scope uses
  it('refuses a base URL that overlaps another only once decoded', () => {
    expect(() =>
      assertSeparateApis([
        api('a', 'https://api.example.test/shop%2Fv1'),
        api('b', 'https://api.example.test/shop/v1'),
      ]),
    ).toThrow('overlap');
    // Nested once both are decoded, though neither contains every reading
    // of the other
    expect(() =>
      assertSeparateApis([
        api('a', 'https://api.example.test/shop%2Fv1'),
        api('b', 'https://api.example.test/shop/v1%2Fsub'),
      ]),
    ).toThrow('overlap');
    expect(() =>
      assertSeparateApis([
        api('a', 'https://api.example.test/shop%2Fv1'),
        api('b', 'https://api.example.test/shop/v2'),
      ]),
    ).not.toThrow();
  });

  it('refuses two APIs in one cache namespace', () => {
    expect(() =>
      assertSeparateApis([
        api('a', 'https://a.example.test/', 'same'),
        api('b', 'https://b.example.test/', 'same'),
      ]),
    ).toThrow('load the same spec with the same cache key');
  });
});

describe('combinedContentHash (#16)', () => {
  it('changes when any API or its spec changes', () => {
    const hash = combinedContentHash([
      { name: 'a', hash: '1' },
      { name: 'b', hash: '2' },
    ]);
    expect(hash).toMatch(/^[a-f\d]{64}$/u);
    expect(
      combinedContentHash([
        { name: 'a', hash: '1' },
        { name: 'b', hash: '3' },
      ]),
    ).not.toBe(hash);
    expect(
      combinedContentHash([
        { name: 'a', hash: '1' },
        { name: 'c', hash: '2' },
      ]),
    ).not.toBe(hash);
  });
});
