// The right answers of the real-API tasks (real-apis.ts), read from the APIs
// when a run starts

type Truth = Record<string, unknown>;

const github = async <T>(route: string): Promise<T> => {
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      authorization: process.env['GITHUB_AUTH'] ?? '',
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${route}: ${String(response.status)}`);
  }
  return (await response.json()) as T;
};

const pokeapi = async <T>(route: string): Promise<T> => {
  const response = await fetch(`https://pokeapi.co/api/v2${route}`);
  return (await response.json()) as T;
};

interface Pull {
  number: number;
  user: { login: string };
  merged_at: string | null;
}

export const githubTruth = async (): Promise<Truth> => {
  const repo = await github<{ license: { spdx_id: string }; default_branch: string }>(
    '/repos/request/request',
  );
  let releases = 0;
  for (let page = 1; ; page += 1) {
    const batch = await github<unknown[]>(
      `/repos/atom/atom/releases?per_page=100&page=${String(page)}`,
    );
    releases += batch.length;
    if (batch.length < 100) {
      break;
    }
  }
  const pulls = await github<Pull[]>(
    '/repos/request/request/pulls?state=closed&sort=created&direction=desc&per_page=100',
  );
  const authors = new Map<string, number>();
  for (const pull of pulls) {
    authors.set(pull.user.login, (authors.get(pull.user.login) ?? 0) + 1);
  }
  const ranked = [...authors].toSorted((left, right) => right[1] - left[1]);
  const merged: number[] = [];
  for (let page = 1; merged.length < 10; page += 1) {
    const batch = await github<Pull[]>(
      `/repos/request/request/pulls?state=closed&sort=created&direction=desc&per_page=100&page=${String(page)}`,
    );
    merged.push(...batch.filter((pull) => pull.merged_at !== null).map((pull) => pull.number));
  }
  const sizes = await Promise.all(
    merged.slice(0, 10).map(async (number) => {
      const pull = await github<{ additions: number; deletions: number }>(
        `/repos/request/request/pulls/${String(number)}`,
      );
      return [number, pull.additions + pull.deletions] as const;
    }),
  );
  const biggest = sizes.toSorted((left, right) => right[1] - left[1]);
  const bugs = await github<{ total_count: number }>(
    `/search/issues?q=${encodeURIComponent('repo:atom/atom is:issue is:open label:bug')}`,
  );
  const [commit] = await github<
    { commit: { message: string }; author: { login: string } | null }[]
  >(`/repos/request/request/commits?sha=${repo.default_branch}&per_page=1`);
  return {
    license: repo.license.spdx_id,
    releases,
    // Only a clear winner makes a task; a tie fails the run before it starts
    topAuthor: ranked[0]![1] > ranked[1]![1] ? ranked[0]![0] : undefined,
    biggestPull: biggest[0]![1] > biggest[1]![1] ? biggest[0]![0] : undefined,
    openBugs: bugs.total_count,
    commitLine: commit!.commit.message.split('\n')[0],
    commitAuthor: commit!.author?.login,
  };
};

export const pokeapiTruth = async (): Promise<Truth> => {
  const pikachu = await pokeapi<{ base_experience: number }>('/pokemon/pikachu');
  const species = await pokeapi<{ evolution_chain: { url: string } }>('/pokemon-species/eevee');
  const chain = await pokeapi<{ chain: { evolves_to: unknown[] } }>(
    species.evolution_chain.url.replace('https://pokeapi.co/api/v2', ''),
  );
  const ice = await pokeapi<{ pokemon: { pokemon: { name: string } }[] }>('/type/ice');
  const experience = await Promise.all(
    ice.pokemon.map(async ({ pokemon }) => {
      const detail = await pokeapi<{ base_experience: number | null }>(`/pokemon/${pokemon.name}`);
      return [pokemon.name, detail.base_experience ?? 0] as const;
    }),
  );
  const top = Math.max(...experience.map(([, value]) => value));
  let weight = 0;
  for (const name of ['bulbasaur', 'ivysaur', 'venusaur']) {
    const pokemon = await pokeapi<{ weight: number }>(`/pokemon/${name}`);
    weight += pokemon.weight;
  }
  const charmander = await pokeapi<{
    moves: {
      move: { name: string };
      version_group_details: { move_learn_method: { name: string } }[];
    }[];
  }>('/pokemon/charmander');
  const levelUp = charmander.moves
    .filter((entry) =>
      entry.version_group_details.some((detail) => detail.move_learn_method.name === 'level-up'),
    )
    .map((entry) => entry.move.name);
  const strong: string[] = [];
  for (const name of levelUp) {
    const move = await pokeapi<{ power: number | null }>(`/move/${name}`);
    if ((move.power ?? 0) >= 80) {
      strong.push(name);
    }
  }
  return {
    pikachu: pikachu.base_experience,
    eevee: chain.chain.evolves_to.length,
    iceTop: top,
    iceTopNames: experience.filter(([, value]) => value === top).map(([name]) => name),
    bulbasaurWeight: weight,
    charmanderStrong: strong,
  };
};
