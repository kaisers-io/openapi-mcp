import { describe, expect, it } from 'vitest';
import { withinApi } from '../src/server/execute/hop-authorizer.ts';

// Issue #16: an API's credentials go only to URLs on that API. With several
// APIs on one origin, every reading of the path must stay within the base.

describe('withinApi', () => {
  const shop = withinApi(new URL('https://api.example.test/shop/v1'));
  const at = (path: string): boolean => shop(new URL(`https://api.example.test${path}`));

  it('accepts the base and paths below it, in any letter case', () => {
    expect(at('/shop/v1')).toBe(true);
    expect(at('/shop/v1/orders/1')).toBe(true);
    expect(at('/SHOP/V1/orders')).toBe(true);
  });

  it('refuses another API on the same origin, a sibling prefix and another origin', () => {
    expect(at('/crm/v1/contacts')).toBe(false);
    expect(at('/shop/v10/orders')).toBe(false);
    expect(at('/shop')).toBe(false);
    expect(shop(new URL('https://other.example.test/shop/v1/orders'))).toBe(false);
  });

  it('refuses a path that leaves the base in one of its readings', () => {
    expect(at('/shop/v1/..%2F..%2Fcrm/v1')).toBe(false);
    expect(at('/shop/v1/%2e%2e/%2e%2e/crm')).toBe(false);
  });

  it('accepts every path on an API at the origin root', () => {
    const root = withinApi(new URL('https://api.example.test/'));
    expect(root(new URL('https://api.example.test/anything/at/all'))).toBe(true);
    expect(root(new URL('https://api.example.test'))).toBe(true);
  });
});
