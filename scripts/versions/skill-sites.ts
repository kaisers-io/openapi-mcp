// The agent skills (#72) state the CLI version they were checked against in their frontmatter
// (`metadata.version`), so a release bumps them with the other sites.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { distinct, lineOf, problem, readText, ROOT } from './sites.ts';
import type { Site } from './sites.ts';

const SKILLS_DIR = 'skills';
const SKILL_VERSION_LINE = /^(?<prefix>[ \t]+version:[ \t]*)"(?<version>[^"\\]*)"[ \t]*$/gmu;

// Each skill's `metadata.version`. A tree without skills/ has none to check.
export const skillSites = async (): Promise<Site[]> => {
  let names: string[];
  try {
    const entries = await readdir(join(ROOT, SKILLS_DIR), { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
  const sites: Site[] = [];
  for (const name of names) {
    const file = `${SKILLS_DIR}/${name}/SKILL.md`;
    const text = await readText(file);
    if (text === undefined) {
      continue;
    }
    const [line, ...extra] = text.matchAll(SKILL_VERSION_LINE);
    if (line === undefined || extra.length > 0) {
      problem(
        `${file} has ${extra.length + (line ? 1 : 0)} metadata version line(s), expected one`,
      );
      continue;
    }
    const values = [
      {
        label: `${file}:${lineOf(text, line.index)} metadata.version`,
        value: line.groups?.['version'],
      },
    ];
    sites.push({
      file,
      values,
      rewrite: (version) =>
        text.replaceAll(SKILL_VERSION_LINE, (_line, prefix: string) => `${prefix}"${version}"`),
      describeChange: (version) => `${distinct(values)} -> ${version}`,
    });
  }
  return sites;
};
