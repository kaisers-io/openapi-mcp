// Tasks against real public APIs (issue #60): the GitHub REST API and PokeAPI.
// The answers are read from the APIs themselves when a run starts, so data
// that changes between runs still has one right answer per run. GitHub needs
// a token in GITHUB_AUTH (`Bearer <token>`, read-only use only); PokeAPI none.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { githubTruth, pokeapiTruth } from './real-truth.ts';

// The descriptions, pinned to a commit so every run reads the same spec
const GITHUB_SPEC =
  'https://raw.githubusercontent.com/github/rest-api-description/c66e298030d4070b70a569dcd4268b3a041b5380/descriptions/api.github.com/api.github.com.json';
const POKEAPI_SPEC =
  'https://raw.githubusercontent.com/PokeAPI/pokeapi/2bf639e5572812a67d2b94903fdcb9d095f5aeb2/openapi.yml';

type Truth = Record<string, unknown>;

export interface RealTask {
  id: string;
  exercises: string;
  prompt: { en: string; de: string };
  check: (answer: string, truth: Truth) => { correct: boolean; expected: string };
}

export interface RealApi {
  // Downloads the spec into `dir` and returns the serve flags
  args: (dir: string) => Promise<string[]>;
  // The environment variables the server needs, passed through by name
  env: string[];
  truth: () => Promise<Truth>;
  tasks: RealTask[];
}

// Names match whatever their spelling: "flare-blitz", "Flare Blitz"
const plain = (text: string) => text.toLowerCase().replaceAll(/[-_\s]+/gu, ' ');
const has = (text: string, needle: string) => plain(text).includes(plain(needle));
const numbers = (text: string) =>
  [...text.matchAll(/\d[\d.,]*/gu)].map((match) =>
    Number(match[0].replaceAll(/[.,](?=\d{3}\b)/gu, '').replace(',', '.')),
  );
const hasNumber = (text: string, value: number) => numbers(text).includes(value);

const download = async (url: string, file: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not download ${url}: ${String(response.status)}`);
  }
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
};

const GITHUB_TASKS: RealTask[] = [
  {
    id: 'gh-lookup',
    exercises: 'one direct call',
    prompt: {
      en: 'What is the SPDX license identifier of the GitHub repository request/request?',
      de: 'Welche SPDX-Lizenzkennung hat das GitHub-Repository request/request?',
    },
    check: (answer, truth) => ({
      correct: has(answer, String(truth['license'])),
      expected: String(truth['license']),
    }),
  },
  {
    id: 'gh-pagination',
    exercises: 'paging through every release and counting',
    prompt: {
      en: 'How many releases does the GitHub repository atom/atom have in total? Give the exact number.',
      de: 'Wie viele Releases hat das GitHub-Repository atom/atom insgesamt? Nenne die genaue Zahl.',
    },
    check: (answer, truth) => ({
      correct: hasNumber(answer, Number(truth['releases'])),
      expected: String(truth['releases']),
    }),
  },
  {
    id: 'gh-aggregate',
    exercises: 'one large list, grouped and ranked',
    prompt: {
      en: 'Among the 100 most recently created closed pull requests of the GitHub repository request/request, which user opened the most? Answer with the login.',
      de: 'Welcher Nutzer hat unter den 100 zuletzt erstellten geschlossenen Pull Requests des GitHub-Repositorys request/request die meisten eröffnet? Antworte mit dem Login.',
    },
    check: (answer, truth) => ({
      correct: has(answer, String(truth['topAuthor'])),
      expected: String(truth['topAuthor']),
    }),
  },
  {
    id: 'gh-fanout',
    exercises: 'a filtered list, then one detail call per item',
    prompt: {
      en: 'Of the 10 most recently created merged pull requests of the GitHub repository request/request, which one changed the most lines (additions plus deletions)? Give its number.',
      de: 'Welcher der 10 zuletzt erstellten gemergten Pull Requests des GitHub-Repositorys request/request hat die meisten Zeilen geändert (Hinzufügungen plus Löschungen)? Nenne seine Nummer.',
    },
    check: (answer, truth) => ({
      correct: hasNumber(answer, Number(truth['biggestPull'])),
      expected: String(truth['biggestPull']),
    }),
  },
  {
    id: 'gh-search',
    exercises: 'choosing between the search and the list operations',
    prompt: {
      en: 'How many open issues (not pull requests) with the label "bug" does the GitHub repository atom/atom have?',
      de: 'Wie viele offene Issues (keine Pull Requests) mit dem Label "bug" hat das GitHub-Repository atom/atom?',
    },
    check: (answer, truth) => ({
      correct: hasNumber(answer, Number(truth['openBugs'])),
      expected: String(truth['openBugs']),
    }),
  },
  {
    id: 'gh-chain',
    exercises: 'two dependent calls',
    prompt: {
      en: 'What is the first line of the message of the latest commit on the default branch of the GitHub repository request/request, and what is the GitHub login of its author?',
      de: 'Wie lautet die erste Zeile der Nachricht des neuesten Commits auf dem Default-Branch des GitHub-Repositorys request/request, und welchen GitHub-Login hat sein Autor?',
    },
    check: (answer, truth) => ({
      correct:
        has(answer, String(truth['commitLine'])) && has(answer, String(truth['commitAuthor'])),
      expected: `${String(truth['commitLine'])} / ${String(truth['commitAuthor'])}`,
    }),
  },
];

const POKEAPI_TASKS: RealTask[] = [
  {
    id: 'pk-lookup',
    exercises: 'one direct call',
    prompt: {
      en: 'What is the base experience of the Pokémon pikachu in PokeAPI?',
      de: 'Welche Basis-Erfahrung hat das Pokémon pikachu in der PokeAPI?',
    },
    check: (answer, truth) => ({
      correct: hasNumber(answer, Number(truth['pikachu'])),
      expected: String(truth['pikachu']),
    }),
  },
  {
    id: 'pk-chain',
    exercises: 'species, then its evolution chain',
    prompt: {
      en: 'Into how many different Pokémon can eevee evolve directly, according to PokeAPI?',
      de: 'In wie viele verschiedene Pokémon kann sich eevee laut PokeAPI direkt entwickeln?',
    },
    check: (answer, truth) => ({
      correct: hasNumber(answer, Number(truth['eevee'])),
      expected: String(truth['eevee']),
    }),
  },
  {
    id: 'pk-fanout',
    exercises: 'about 70 detail calls, more than one script allows',
    prompt: {
      en: 'Among all Pokémon of type ice in PokeAPI, what is the highest base experience, and which Pokémon have it?',
      de: 'Was ist die höchste Basis-Erfahrung unter allen Pokémon vom Typ ice in der PokeAPI, und welche Pokémon haben sie?',
    },
    check: (answer, truth) => {
      const names = truth['iceTopNames'] as string[];
      return {
        correct:
          hasNumber(answer, Number(truth['iceTop'])) && names.every((name) => has(answer, name)),
        expected: `${String(truth['iceTop'])}: ${names.join(', ')}`,
      };
    },
  },
  {
    id: 'pk-aggregate',
    exercises: 'three calls and a sum',
    prompt: {
      en: 'What is the combined weight, as PokeAPI reports it, of bulbasaur, ivysaur and venusaur?',
      de: 'Wie hoch ist das gemeinsame Gewicht von bulbasaur, ivysaur und venusaur, so wie die PokeAPI es angibt?',
    },
    check: (answer, truth) => ({
      correct: hasNumber(answer, Number(truth['bulbasaurWeight'])),
      expected: String(truth['bulbasaurWeight']),
    }),
  },
  {
    id: 'pk-filter',
    exercises: 'one detail call per move, then a filter',
    prompt: {
      en: 'Which moves that charmander learns by level-up have a power of 80 or more, according to PokeAPI? List the move names.',
      de: 'Welche Attacken, die charmander durch Levelaufstieg lernt, haben laut PokeAPI eine Stärke von 80 oder mehr? Liste die Namen auf.',
    },
    check: (answer, truth) => {
      const moves = truth['charmanderStrong'] as string[];
      return { correct: moves.every((move) => has(answer, move)), expected: moves.join(', ') };
    },
  },
];

export const REAL_APIS: Record<string, RealApi> = {
  // The parts of GitHub an agent typically reads, small enough for per-operation
  github: {
    args: async (dir) => [
      '--spec',
      await download(GITHUB_SPEC, path.join(dir, 'github.json')),
      '--header-env',
      'Authorization=GITHUB_AUTH',
      ...['repos', 'issues', 'pulls', 'users', 'search'].flatMap((tag) => [
        '--allow',
        `tag:${tag}`,
      ]),
      ...['post', 'put', 'patch', 'delete'].flatMap((method) => ['--deny', `method:${method}`]),
      // The API answers differently from its description here
      '--nullable-response-fields',
      'all',
      '--omit-output-schema',
      'operationId:repos/get',
    ],
    env: ['GITHUB_AUTH'],
    truth: githubTruth,
    tasks: GITHUB_TASKS,
  },
  // Every read of GitHub: more than per-operation can serve
  'github-all': {
    args: async (dir) => [
      '--spec',
      await download(GITHUB_SPEC, path.join(dir, 'github.json')),
      '--header-env',
      'Authorization=GITHUB_AUTH',
      '--nullable-response-fields',
      'all',
      '--omit-output-schema',
      'operationId:repos/get',
    ],
    env: ['GITHUB_AUTH'],
    truth: githubTruth,
    tasks: GITHUB_TASKS,
  },
  pokeapi: {
    args: async (dir) => [
      '--spec',
      await download(POKEAPI_SPEC, path.join(dir, 'pokeapi.yml')),
      '--nullable-response-fields',
      'all',
      '--omit-output-schema',
      'operationId:pokemon_retrieve',
      '--omit-output-schema',
      'operationId:type_retrieve',
    ],
    env: [],
    truth: pokeapiTruth,
    tasks: POKEAPI_TASKS,
  },
};
