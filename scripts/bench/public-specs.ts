// The large public specs of `--suite public`: downloaded once from
// commit-pinned URLs and checked against a pinned sha256 before use.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const readIfPresent = async (file: URL): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

const download = async (url: string, file: URL): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetching ${url} failed: HTTP ${String(response.status)}`);
  }
  const text = await response.text();
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(file, text);
  return text;
};

type PublicSource = {
  url: string;
  sha256: string;
  extension: 'json' | 'yaml';
};

// Pinned by commit, so the bytes (and therefore the sha256) never move
const PUBLIC_SOURCES: Record<string, PublicSource> = {
  digitalocean: {
    url: 'https://raw.githubusercontent.com/APIs-guru/openapi-directory/f04b8d0bcd39c52e1cf3ad7a5fe744709832ae49/APIs/digitalocean.com/2.0/openapi.yaml',
    sha256: '5bd3a4800c4396372cb80d99cc82b49463e4a3f136b63d1794c19f13da37cf63',
    extension: 'yaml',
  },
  github: {
    url: 'https://raw.githubusercontent.com/github/rest-api-description/755ee33b4a81d51f6f07a902cce26cbec3b822f2/descriptions/api.github.com/api.github.com.json',
    sha256: '3177ad6a86ca04c57a9bef3fc24e28a339efb8eb040c6f950af3d3ed2fee7fa3',
    extension: 'json',
  },
  stripe: {
    url: 'https://raw.githubusercontent.com/stripe/openapi/f3799ad599a6cf7c76fd94ce72274c0367cc2ba7/openapi/spec3.json',
    sha256: '7cff4cc46d0654101a36a3302f7544640f5f73e4f3cad6f264f0e23c19fa1776',
    extension: 'json',
  },
};

// Downloads into scripts/bench/.cache/ (gitignored) on first use. A sha256
// mismatch is an error, never a silent re-download: the numbers are only
// comparable across runs if the input bytes are the same.
export const publicSpec =
  (name: string): (() => Promise<{ text: string; extension: 'json' | 'yaml' }>) =>
  async () => {
    const source = PUBLIC_SOURCES[name];
    if (source === undefined) {
      throw new Error(`unknown public fixture "${name}"`);
    }
    const file = new URL(`.cache/${name}.${source.extension}`, import.meta.url);
    const text = (await readIfPresent(file)) ?? (await download(source.url, file));
    const digest = createHash('sha256').update(text).digest('hex');
    if (digest !== source.sha256) {
      throw new Error(
        `public fixture "${name}" has sha256 ${digest}, expected ${source.sha256} — delete scripts/bench/.cache/ and retry`,
      );
    }
    return { text, extension: source.extension };
  };
