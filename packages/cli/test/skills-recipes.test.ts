import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '@kaisers-io/openapi-mcp-core';
import { testContext } from '../src/context.ts';
import { run } from '../src/main.ts';

// The filter recipes of the configuring skill (#72) expose exactly the tools
// they list, against the shop example of docs/filtering.md.

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));
const RECIPES = fileURLToPath(
  new URL('../../../skills/configuring-openapi-mcp/references/filtering.md', import.meta.url),
);
const RECIPE =
  /<!-- recipe: (?<name>[\w-]+) -->\n```\nargs:(?<args>[^\n]*)\ntools:(?<tools>[^\n]*)\n```/gu;

type Recipe = { name: string; args: string[]; tools: string[] };

const words = (text: string | undefined): string[] =>
  (text ?? '').split(' ').filter((word) => word !== '');

const recipes = async (): Promise<Recipe[]> => {
  const text = await readFile(RECIPES, 'utf8');
  return [...text.matchAll(RECIPE)].map(({ groups }) => ({
    name: groups?.['name'] ?? '',
    args: words(groups?.['args']),
    tools: words(groups?.['tools']),
  }));
};

const exposedTools = async (args: readonly string[]): Promise<string[]> => {
  const lines: string[] = [];
  const ctx = testContext({
    lines,
    readFileText: (path) => readFile(path, 'utf8'),
    fileSizeBytes: async (path) => {
      const stats = await stat(path);
      return stats.size;
    },
    cwd: () => fixturesDir,
  });
  const argv = ['node', 'openapi-mcp', '--json', 'tools', '--spec', 'shop-filtering.json'];
  const code = await run(ctx, [...argv, ...args, '--strict-filters']);
  expect(code).toBe(EXIT.OK);
  const { data } = JSON.parse(lines[0] ?? '') as { data: { tools: { name: string }[] } };
  return data.tools.map((tool) => tool.name);
};

describe('filter recipes of the configuring skill', () => {
  it('has recipes', async () => {
    const found = await recipes();
    expect(found.map((recipe) => recipe.name)).toEqual([
      'read-only',
      'reads-and-create',
      'orders-without-delete',
      'all-but-delete',
    ]);
  });

  it('exposes exactly the tools each recipe lists', async () => {
    for (const recipe of await recipes()) {
      const exposed = await exposedTools(recipe.args);
      expect({ recipe: recipe.name, tools: exposed.toSorted() }).toEqual({
        recipe: recipe.name,
        tools: recipe.tools.toSorted(),
      });
    }
  });
});
