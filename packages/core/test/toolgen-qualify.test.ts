import { describe, expect, it } from 'vitest';
import {
  API_NAME_PATTERN,
  apiOfToolName,
  buildTools,
  buildToolsDeferred,
  qualifiedName,
  qualifyTools,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { NamedOperation } from '../src/index.ts';

// Issue #16: tool names of several APIs are `<api>_<name>`

const op = (toolName: string): NamedOperation => ({
  toolName,
  operation: {
    method: 'get',
    path: `/${toolName}`,
    tags: [],
    deprecated: false,
    parameters: [],
    responses: {
      '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
    },
  },
});
const options = { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' as const };

describe('qualifyTools (#16)', () => {
  it('prefixes built and deferred tools, and their completed form', () => {
    const built = qualifyTools(buildTools([op('repos_get')], options), 'github');
    expect(built.tools.map((tool) => tool.toolName)).toStrictEqual(['github_repos_get']);
    const deferred = qualifyTools(buildToolsDeferred([op('repos_get')], options), 'github');
    const [tool] = deferred.tools;
    expect(tool?.toolName).toBe('github_repos_get');
    const completed = tool?.complete();
    expect(completed?.toolName).toBe('github_repos_get');
    expect(completed?.outputSchema).toBeDefined();
    expect(Object.isFrozen(completed)).toBe(true);
  });

  // Review of #16: hosts accept 64 characters
  it('keeps a qualified name within 64 characters, unique and stable', () => {
    const long = 'x'.repeat(64);
    const first = qualifiedName('shop', long);
    expect(first).toHaveLength(64);
    expect(first.startsWith('shop_xxx')).toBe(true);
    expect(qualifiedName('shop', long)).toBe(first);
    expect(qualifiedName('shop', `${'x'.repeat(63)}y`)).not.toBe(first);
    expect(apiOfToolName(first)).toBe('shop');
    expect(qualifiedName('shop', 'listOrders')).toBe('shop_listOrders');
  });

  // Review of #16: a shortened name and one that already looks like it
  it('resolves names that only collide once qualified', () => {
    const long = 'x'.repeat(64);
    const lookalike = qualifiedName('shop', long).slice('shop_'.length);
    const built = qualifyTools(buildTools([op(long), op(lookalike)], options), 'shop');
    const names = built.tools.map((tool) => tool.toolName);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.startsWith('shop_')).toBe(true);
    }
    // The same on every start
    const again = qualifyTools(buildTools([op(long), op(lookalike)], options), 'shop');
    expect(again.tools.map((tool) => tool.toolName)).toStrictEqual(names);
  });

  // Review of #16: names crafted to collide at every step still end unique
  it('stays unique against names crafted to collide again and again', () => {
    const long = 'x'.repeat(64);
    const crafted = [long];
    for (let round = 0; round < 6; round += 1) {
      const built = qualifyTools(
        buildTools(
          crafted.map((name) => op(name)),
          options,
        ),
        'shop',
      );
      const last = built.tools.at(-1)?.toolName ?? '';
      crafted.push(last.slice('shop_'.length));
    }
    const names = qualifyTools(
      buildTools(
        crafted.map((name) => op(name)),
        options,
      ),
      'shop',
    ).tools.map((tool) => tool.toolName);
    expect(new Set(names).size).toBe(crafted.length);
  });

  it('reads the API back from the part before the first underscore', () => {
    expect(apiOfToolName('github_repos_get')).toBe('github');
    expect(apiOfToolName('my-shop_orders_list')).toBe('my-shop');
  });

  it('accepts short lower-case names without underscores only', () => {
    for (const name of ['github', 'my-shop', 'a', `a${'b'.repeat(31)}`]) {
      expect(API_NAME_PATTERN.test(name)).toBe(true);
    }
    for (const name of ['GitHub', 'my_shop', '1api', '-x', '', `a${'b'.repeat(32)}`, 'a.b']) {
      expect(API_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});
