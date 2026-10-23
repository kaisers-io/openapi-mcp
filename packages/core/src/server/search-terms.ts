// Term extraction for the search_operations index (issue
// kaisers-io/openapi-mcp-archive#38). The same function turns operation text
// into index terms and a query into query terms, so every normalization below
// applies symmetrically.

// Bounds one term: a hostile spec cannot make a single index key arbitrarily
// long.
const TERM_MAX_LENGTH = 64;

// English function words that carry no meaning in an API search ("create an
// issue", "list-for-repo"). Dropping them keeps them from outweighing the
// words that do.
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

// A light plural fold, so "issue" finds "issues" and "repositories" finds
// "repository": "-ies" becomes "-y", and a final "s" is dropped unless the
// word ends in "ss". Deliberately not a full stemmer — it only has to map one
// word's forms together, and query and index go through the same fold, so an
// odd result ("status" -> "statu") still matches itself.
const foldPlural = (term: string): string => {
  if (term.length <= 3) {
    return term;
  }
  if (term.endsWith('ies')) {
    return `${term.slice(0, -3)}y`;
  }
  return term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term;
};

// Splits camelCase/PascalCase, acronym runs and every non-letter/digit run,
// lowercases and drops stopwords: "listPetsByOwner" -> list pets owner,
// "/repos/{owner}/git/refs" -> repos owner git refs, "list_r12" -> list r12.
// A plural also yields its folded form, after the word itself: the shared
// folded term lets "issue" match "issues", while the word kept as written
// still ranks an exact plural ("list droplets" -> droplets_list) above a
// mere singular ("dropletActions_list").
export const searchTerms = (text: string): string[] =>
  text
    .replaceAll(/(?<before>\p{Ll}|\p{N})(?<upper>\p{Lu})/gu, '$<before> $<upper>')
    .replaceAll(/(?<run>\p{Lu})(?<word>\p{Lu}\p{Ll})/gu, '$<run> $<word>')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '' && !STOPWORDS.has(token))
    .flatMap((token) => {
      const term = token.slice(0, TERM_MAX_LENGTH);
      const folded = foldPlural(term);
      return folded === term ? [term] : [term, folded];
    });
