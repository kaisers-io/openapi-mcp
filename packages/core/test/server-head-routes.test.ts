import { describe, expect, it } from 'vitest';
import { headsWithoutGet } from '../src/index.ts';
import type { RouteEntry } from '../src/index.ts';

// Issue #68: an exposed HEAD is refused on every call while a GET with the
// same template is not exposed
const entry = (method: string, path: string, exposed: boolean): RouteEntry => ({
  method,
  path,
  exposed,
});

describe('headsWithoutGet', () => {
  it('finds a HEAD whose GET has the same template, by position and regardless of case', () => {
    const found = headsWithoutGet([
      entry('GET', '/orders/{orderId}', false),
      entry('HEAD', '/Orders/{id}', true),
      entry('GET', '/files/{name}.json', false),
      entry('HEAD', '/files/{file}.JSON', true),
      entry('GET', '/caf%C3%A9/{id}', false),
      entry('HEAD', '/café/{id}', true),
    ]);
    expect(found).toStrictEqual(
      new Map([
        ['HEAD /Orders/{id}', '/orders/{orderId}'],
        ['HEAD /files/{file}.JSON', '/files/{name}.json'],
        ['HEAD /café/{id}', '/caf%C3%A9/{id}'],
      ]),
    );
  });

  it('asks the route table for a HEAD on a concrete path', () => {
    const found = headsWithoutGet([
      entry('GET', '/a/{id}', false),
      entry('HEAD', '/a/x', true),
      entry('GET', '/b/{id}', true),
      entry('HEAD', '/b/x', true),
    ]);
    expect(found).toStrictEqual(new Map([['HEAD /a/x', '']]));
  });

  it.each([
    ['the GET is exposed', [entry('GET', '/a/{id}', true), entry('HEAD', '/a/{id}', true)]],
    ['there is no GET', [entry('HEAD', '/a/{id}', true)]],
    ['the HEAD is not exposed', [entry('GET', '/a/{id}', false), entry('HEAD', '/a/{id}', false)]],
    // Overlapping is not the same: only some calls are refused, which the
    // startup overlap warning reports
    ['the templates only overlap', [entry('GET', '/a/x', false), entry('HEAD', '/a/{id}', true)]],
    [
      'a concrete GET that is exposed wins over the template',
      [entry('GET', '/a/{id}', false), entry('GET', '/a/x', true), entry('HEAD', '/a/x', true)],
    ],
    ['another segment count', [entry('GET', '/a', false), entry('HEAD', '/a/{id}', true)]],
    ['a webhook key', [entry('GET', 'orderCreated', false), entry('HEAD', 'orderCreated', true)]],
  ])('keeps the HEAD when %s', (_name, entries) => {
    expect(headsWithoutGet(entries).size).toBe(0);
  });
});
