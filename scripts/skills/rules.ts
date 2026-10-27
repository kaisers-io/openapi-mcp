import { join } from 'node:path';

// The rules every skill text follows (#72): the unslop style, no credentials, and links into
// the repository that resolve. Used by skills.ts.

// The frontmatter fields every agent reads (agentskills.io/specification)
export const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);
export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REPO_LINK =
  /https:\/\/github\.com\/kaisers-io\/openapi-mcp\/blob\/main\/(?<file>[^)#\s]+)(?:#(?<anchor>[^)\s]+))?/gu;
export const REFERENCE = /references\/[a-z0-9-]+\.md/gu;
// Word list of the unslop rules (cursor/plugins, pstack/skills/unslop at bc697d0a), rules 7
// and 31: the subset a word match can find
const UNSLOP_WORDS = [
  'additionally',
  'crucial',
  'delve',
  'enduring',
  'enhance',
  'fostering',
  'garner',
  'interplay',
  'intricate',
  'pivotal',
  'showcase',
  'tapestry',
  'testament',
  'underscore',
  'vibrant',
  'utilize',
  'leverage',
  'facilitate',
  'numerous',
  'in order to',
  'due to the fact',
  'it is important to note',
];
// Strings that look like a real credential; placeholders such as <token> pass
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/u,
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /Bearer [A-Za-z0-9._~+/-]{20,}/u,
];
// An env value in a JSON example must be a variable reference, never a literal
const ENV_OBJECT = /"env"\s*:\s*\{(?<entries>[^}]*)\}/gu;
const ENV_LITERAL = /"[A-Z][A-Z0-9_]*"\s*:\s*"(?!\$)[^"]*"/u;

export type Frontmatter = Record<string, string | Record<string, string>>;

// The frontmatter of a SKILL.md: top-level keys and one level of nesting
export const frontmatterOf = (text: string): { data: Frontmatter; body: string } => {
  const match = /^---\n(?<yaml>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(text);
  if (match?.groups === undefined) {
    throw new Error('no frontmatter');
  }
  const data: Frontmatter = {};
  let parent: Record<string, string> | undefined;
  for (const line of (match.groups['yaml'] ?? '').split('\n')) {
    const nested = /^ {2}(?<key>[\w-]+):\s*"?(?<value>[^"]*)"?$/u.exec(line);
    const top = /^(?<key>[\w-]+):\s*(?<value>.*)$/u.exec(line);
    if (nested?.groups !== undefined && parent !== undefined) {
      parent[nested.groups['key'] ?? ''] = nested.groups['value'] ?? '';
    } else if (top?.groups !== undefined) {
      const key = top.groups['key'] ?? '';
      const value = top.groups['value'] ?? '';
      if (value === '') {
        parent = {};
        data[key] = parent;
      } else {
        parent = undefined;
        data[key] = value;
      }
    }
  }
  return { data, body: match.groups['body'] ?? '' };
};

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens
const anchorOf = (heading: string): string =>
  heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .replaceAll(' ', '-');

const anchorsOf = (markdown: string): Set<string> =>
  new Set(
    markdown
      .split('\n')
      .filter((line) => /^#{1,6} /u.test(line))
      .map((line) => anchorOf(line.replace(/^#+ /u, ''))),
  );

// What checkText needs from the loaded repository
export interface Lookup {
  root: string;
  exists: (path: string) => boolean;
  read: (path: string) => string;
}

export const checkText = (lookup: Lookup, path: string, text: string, problems: string[]): void => {
  if (text.includes('—')) {
    problems.push(`${path}: contains an em dash`);
  }
  const lower = text.toLowerCase();
  for (const word of UNSLOP_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'u').test(lower)) {
      problems.push(`${path}: uses "${word}"`);
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      problems.push(`${path}: contains a value that looks like a credential`);
    }
  }
  // Every env object, also one written over several lines; PATH may hold a literal directory
  for (const match of text.matchAll(ENV_OBJECT)) {
    const entries = (match.groups?.['entries'] ?? '').replaceAll(/"PATH"\s*:\s*"[^"]*"/gu, '');
    if (ENV_LITERAL.test(entries)) {
      problems.push(`${path}: an env value is a literal, not a variable reference`);
    }
  }
  for (const match of text.matchAll(REPO_LINK)) {
    const file = match.groups?.['file'] ?? '';
    const anchor = match.groups?.['anchor'];
    const target = join(lookup.root, file);
    if (!lookup.exists(target)) {
      problems.push(`${path}: links to ${file}, which does not exist`);
    } else if (anchor !== undefined && !anchorsOf(lookup.read(target)).has(anchor)) {
      problems.push(`${path}: links to ${file}#${anchor}, which has no such heading`);
    }
  }
};
