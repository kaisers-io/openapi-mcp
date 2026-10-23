import { sanitizeSpecText } from '../spec/sanitize.ts';
import { structuredOutcome } from './result.ts';
import type { ToolCallOutcome } from './result.ts';
import { searchTerms } from './search-terms.ts';
import type { SnapshotTool } from './types.ts';
import { SEARCH_LIMIT_DEFAULT, SEARCH_QUERY_MAX_TOKENS } from './discovery-schemas.ts';
import type { SearchInput } from './discovery-schemas.ts';

// The search_operations index (issue kaisers-io/openapi-mcp-archive#38): a
// deterministic keyword ranking (BM25 over weighted fields) of the snapshot's
// exposed operations, built once at startup. No embeddings, no network, no
// model calls — which is what lets a query be bounded and its result reproduced
// exactly.

// Per-entry display caps for a search result. A result is a pointer to an
// operation, not its documentation (describe_operation returns that), so the
// summary is kept short: 25 results stay well under ~25 KB.
const RESULT_SUMMARY_MAX = 200;
const RESULT_PATH_MAX = 512;
const RESULT_TAG_MAX = 64;
const RESULT_TAGS_MAX_COUNT = 5;
// Indexing caps: bound the per-operation index size against a hostile spec
// (thousands of tags, a 4,096-character description of distinct words).
const INDEX_TAGS_MAX_COUNT = 32;
// A query term of at least this length also matches index terms it is a
// prefix of ("pet" finds "pets"), at PREFIX_WEIGHT of an exact match, capped
// at PREFIX_EXPANSION_MAX index terms per query term.
const PREFIX_MIN_LENGTH = 3;
const PREFIX_WEIGHT = 0.5;
const PREFIX_EXPANSION_MAX = 64;

// Per-field term weights (a simple BM25F); weighted counts feed one BM25
// score. The operation name and the one-line summary say what an operation
// does most directly; path, tags and parameter names add context; a long
// description is mostly noise against a short query, so it only breaks ties.
// Chosen against 70 task-style queries over the DigitalOcean and GitHub REST
// descriptions.
const FIELD_WEIGHTS = {
  name: 3,
  path: 1,
  tags: 1,
  parameters: 0.5,
  summary: 2,
  description: 0.25,
} as const;
// The usual BM25 constants.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
// A query equal to an operation's full name always ranks that operation first.
const EXACT_NAME_BONUS = 1_000_000;

// The operation fields shown in a result, already sanitized and capped.
type SearchEntry = {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  // Lowercased sanitized tags, for the case-insensitive tag filter.
  readonly tagKeys: readonly string[];
  // Weighted term count (BM25 document length).
  readonly length: number;
};

// Each posting is [entry index, weighted term frequency].
type Posting = readonly [number, number];

export type SearchIndex = {
  readonly entries: readonly SearchEntry[];
  // Null-prototype record: index terms are spec-derived, so `__proto__` or
  // `constructor` are ordinary keys here, read via Object.hasOwn only.
  readonly postings: Readonly<Record<string, readonly Posting[] | undefined>>;
  // Every index term, sorted by code point, for prefix expansion.
  readonly terms: readonly string[];
  readonly averageLength: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parameterNames = (tool: SnapshotTool): string[] => {
  const { properties } = tool.wireTool.inputSchema;
  return isRecord(properties) ? Object.keys(properties) : [];
};

const compareCodePoints = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

// The fields of one operation and their weights, as weighted term counts.
const termCounts = (tool: SnapshotTool, tags: readonly string[]): Map<string, number> => {
  const operation = tool.generated?.operation;
  const description =
    operation?.description === undefined || operation.description === operation.summary
      ? ''
      : operation.description;
  const fields: [readonly string[], number][] = [
    [searchTerms(tool.name), FIELD_WEIGHTS.name],
    [searchTerms(operation?.path ?? ''), FIELD_WEIGHTS.path],
    [tags.flatMap((tag) => searchTerms(tag)), FIELD_WEIGHTS.tags],
    [parameterNames(tool).flatMap((name) => searchTerms(name)), FIELD_WEIGHTS.parameters],
    [searchTerms(operation?.summary ?? ''), FIELD_WEIGHTS.summary],
    [searchTerms(description), FIELD_WEIGHTS.description],
  ];
  const counts = new Map<string, number>();
  for (const [tokens, weight] of fields) {
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + weight);
    }
  }
  return counts;
};

const searchEntryOf = (
  tool: SnapshotTool,
  tags: readonly string[],
  length: number,
): SearchEntry => {
  const operation = tool.generated?.operation;
  const summary =
    operation?.summary === undefined ? '' : sanitizeSpecText(operation.summary, RESULT_SUMMARY_MAX);
  return {
    name: tool.name,
    method: (operation?.method ?? '').toUpperCase(),
    // Raw spec text (a literal path key), so sanitized here like every other
    // spec string that reaches the model.
    path: sanitizeSpecText(operation?.path ?? '', RESULT_PATH_MAX),
    ...(summary === '' ? {} : { summary }),
    tags: tags.slice(0, RESULT_TAGS_MAX_COUNT),
    tagKeys: tags.map((tag) => tag.toLowerCase()),
    length,
  };
};

export const buildSearchIndex = (operations: readonly SnapshotTool[]): SearchIndex => {
  const postings = new Map<string, Posting[]>();
  // Imperative on purpose: one pass builds both the entries and the inverted
  // index, appending to shared posting lists.
  const entries = operations.map((tool, index) => {
    // Tags are raw spec strings (normalizeSpec does not sanitize them).
    const tags = (tool.generated?.operation.tags ?? [])
      .slice(0, INDEX_TAGS_MAX_COUNT)
      .map((tag) => sanitizeSpecText(tag, RESULT_TAG_MAX))
      .filter((tag) => tag !== '');
    const counts = termCounts(tool, tags);
    let length = 0;
    for (const [term, count] of counts) {
      length += count;
      const list = postings.get(term);
      if (list === undefined) {
        postings.set(term, [[index, count]]);
      } else {
        list.push([index, count]);
      }
    }
    return searchEntryOf(tool, tags, length);
  });
  const record = Object.create(null) as Record<string, readonly Posting[] | undefined>;
  for (const [term, list] of postings) {
    record[term] = list;
  }
  const totalLength = entries.reduce((sum, entry) => sum + entry.length, 0);
  return {
    entries,
    postings: record,
    terms: [...postings.keys()].toSorted(compareCodePoints),
    averageLength: entries.length === 0 ? 0 : totalLength / entries.length,
  };
};

// First index in the sorted `terms` whose term is >= `prefix`.
const lowerBound = (terms: readonly string[], prefix: string): number => {
  let low = 0;
  let high = terms.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((terms[middle] as string) < prefix) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

// A query term and the index terms it matches, with their match weight: the
// term itself (1) and, from PREFIX_MIN_LENGTH characters on, up to
// PREFIX_EXPANSION_MAX longer terms it is a prefix of (PREFIX_WEIGHT).
const expandTerm = (index: SearchIndex, term: string): [string, number][] => {
  const matches: [string, number][] = [[term, 1]];
  if (term.length < PREFIX_MIN_LENGTH) {
    return matches;
  }
  for (
    let position = lowerBound(index.terms, term);
    position < index.terms.length && matches.length <= PREFIX_EXPANSION_MAX;
    position += 1
  ) {
    const candidate = index.terms[position] as string;
    if (!candidate.startsWith(term)) {
      break;
    }
    if (candidate !== term) {
      matches.push([candidate, PREFIX_WEIGHT]);
    }
  }
  return matches;
};

const postingsOf = (index: SearchIndex, term: string): readonly Posting[] =>
  (Object.hasOwn(index.postings, term) ? index.postings[term] : undefined) ?? [];

// BM25 over the weighted term counts, accumulated per entry index.
const scoreEntries = (index: SearchIndex, queryTerms: readonly string[]): Map<number, number> => {
  const scores = new Map<number, number>();
  const total = index.entries.length;
  for (const queryTerm of queryTerms) {
    for (const [term, matchWeight] of expandTerm(index, queryTerm)) {
      const list = postingsOf(index, term);
      const idf = Math.log(1 + (total - list.length + 0.5) / (list.length + 0.5));
      for (const [entryIndex, frequency] of list) {
        const entry = index.entries[entryIndex] as SearchEntry;
        const norm = 1 - BM25_B + (BM25_B * entry.length) / (index.averageLength || 1);
        const termScore = (idf * frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * norm);
        scores.set(entryIndex, (scores.get(entryIndex) ?? 0) + matchWeight * termScore);
      }
    }
  }
  return scores;
};

const passesFilters = (
  entry: SearchEntry,
  method: string | undefined,
  tagKeys: readonly string[],
): boolean =>
  (method === undefined || entry.method === method) &&
  (tagKeys.length === 0 || entry.tagKeys.some((tag) => tagKeys.includes(tag)));

const resultOf = (entry: SearchEntry, detail: 'names' | 'summary'): Record<string, unknown> =>
  detail === 'names'
    ? { name: entry.name }
    : {
        name: entry.name,
        method: entry.method,
        path: entry.path,
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        ...(entry.tags.length === 0 ? {} : { tags: [...entry.tags] }),
      };

// `data` was already validated against SEARCH_INPUT_SCHEMA by the dispatcher.
export const searchOperations = (index: SearchIndex, data: unknown): ToolCallOutcome => {
  const input = data as SearchInput;
  const query = input.query ?? '';
  const queryTerms = [...new Set(searchTerms(query))].slice(0, SEARCH_QUERY_MAX_TOKENS);
  const exactName = query.trim().toLowerCase();
  const tagKeys = (input.tags ?? []).map((tag) =>
    sanitizeSpecText(tag, RESULT_TAG_MAX).toLowerCase(),
  );
  // No query lists every entry; a query without a searchable term (only
  // stopwords or punctuation) matches nothing rather than everything.
  const scores = query.trim() === '' ? undefined : scoreEntries(index, queryTerms);
  const scoreOf = (entry: SearchEntry, entryIndex: number): number =>
    (scores?.get(entryIndex) ?? 0) +
    (entry.name.toLowerCase() === exactName ? EXACT_NAME_BONUS : 0);
  const ranked = index.entries
    .map((entry, entryIndex) => ({ entry, score: scoreOf(entry, entryIndex) }))
    // With a query, only the entries it matched; without one, every entry
    // (a filtered listing in name order).
    .filter(
      ({ entry, score }) =>
        (scores === undefined || score > 0) && passesFilters(entry, input.method, tagKeys),
    )
    // Deterministic: score descending, then name by code point.
    .toSorted(
      (left, right) =>
        right.score - left.score || compareCodePoints(left.entry.name, right.entry.name),
    );
  const detail = input.detail ?? 'summary';
  const payload = {
    results: ranked
      .slice(0, input.limit ?? SEARCH_LIMIT_DEFAULT)
      .map(({ entry }) => resultOf(entry, detail)),
    totalMatches: ranked.length,
  };
  return structuredOutcome(JSON.stringify(payload), payload);
};
