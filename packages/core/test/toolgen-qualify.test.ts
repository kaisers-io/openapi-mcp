import { describe, expect, it } from 'vitest';
import {
  API_NAME_PATTERN,
  apiOfToolName,
  buildTools,
  buildToolsDeferred,
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
