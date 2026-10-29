import { createHash } from 'node:crypto';
import {
  API_NAME_PATTERN,
  pathReadings,
  RESERVED_API_NAMES,
  usageError,
} from '@kaisers-io/openapi-mcp-core';

// Several APIs behind one `serve` (issue #16). `--api <name>=<source>` declares
// one; every per-API option then starts with `<name>=`, and exactly that one
// prefix is consumed (the rest is the value as with a single API). Switches
// are set with `--enable <name>=<switch>`. Without `--api`, nothing here
// applies and every option means what it always did.

export const MAX_APIS = 32;

// Per-API options whose value commander keeps only once: every occurrence is
// captured (captureOccurrences) and split here
export const PER_API_SCALARS: Readonly<Record<string, string>> = {
  '--base-url': 'baseUrl',
  '--basic-auth-env': 'basicAuthEnv',
  '--cache-key': 'cacheKey',
  '--ttl': 'ttl',
  '--nullable-response-fields': 'nullableResponseFields',
  '--upstream-oauth-client-id-env': 'upstreamOauthClientIdEnv',
  '--upstream-oauth-client-secret-env': 'upstreamOauthClientSecretEnv',
  '--upstream-oauth-scheme': 'upstreamOauthScheme',
  '--upstream-oauth-token-url': 'upstreamOauthTokenUrl',
  '--upstream-oauth-client-auth': 'upstreamOauthClientAuth',
};

// Repeatable per-API options (commander collects every value)
export const PER_API_LISTS: Readonly<Record<string, string>> = {
  '--allow': 'allow',
  '--spec-header-env': 'specHeaderEnv',
  '--omit-output-schema': 'omitOutputSchema',
  '--omit-unsupported-parameters': 'omitUnsupportedParameters',
  '--header-env': 'headerEnv',
  '--header': 'header',
  '--upstream-oauth-scope': 'upstreamOauthScope',
};

// Per-API switches, set with `--enable <name>=<switch>`
export const PER_API_SWITCHES: Readonly<Record<string, string>> = {
  'allow-private-network': 'allowPrivateNetwork',
  'allow-insecure-http': 'allowInsecureHttp',
  'allow-offsite-redirects': 'allowOffsiteRedirects',
  'trust-spec-updates': 'trustSpecUpdates',
  'default-response-is-error': 'defaultResponseIsError',
};

export type Occurrence = { flag: string; value: unknown };

// The flags whose occurrences must be captured one by one
export const CAPTURED_FLAGS: readonly string[] = [
  ...Object.keys(PER_API_SCALARS),
  ...Object.keys(PER_API_SWITCHES).map((name) => `--${name}`),
];

export type ApiView<Opts> = { name: string; source: string; options: Opts };

type MultiApiOpts = Record<string, unknown> & {
  api?: readonly string[];
  enable?: readonly string[];
  spec?: string;
  deny: readonly string[];
};

const splitPrefix = (value: string): [string, string] | undefined => {
  const at = value.indexOf('=');
  return at === -1 ? undefined : [value.slice(0, at), value.slice(at + 1)];
};

const declarationsOf = (raw: readonly string[]): { name: string; source: string }[] => {
  if (raw.length > MAX_APIS) {
    throw usageError(
      `--api is given ${String(raw.length)} times; at most ${String(MAX_APIS)} APIs`,
    );
  }
  const seen = new Set<string>();
  return raw.map((value) => {
    const parts = splitPrefix(value);
    if (parts === undefined || !API_NAME_PATTERN.test(parts[0]) || parts[1] === '') {
      throw usageError(
        `--api "${value}" is not <name>=<source>; a name is 1 to 32 lower-case letters, digits or "-", starting with a letter`,
      );
    }
    const [name, source] = parts;
    if (RESERVED_API_NAMES.has(name)) {
      throw usageError(
        `--api name "${name}" is reserved: its tool names could collide with this server's own tools`,
      );
    }
    if (seen.has(name)) {
      throw usageError(`--api names "${name}" twice`);
    }
    seen.add(name);
    return { name, source };
  });
};

// The views of every declared API, or undefined without --api.
// `occurrences` are the captured scalar and switch flags; `defaults` their
// commander defaults, which an API that does not name the flag keeps.
export const apiViews = <Opts extends MultiApiOpts>(
  cmdOpts: Opts,
  occurrences: readonly Occurrence[],
  defaults: Readonly<Record<string, unknown>>,
): ApiView<Opts>[] | undefined => {
  const declared = cmdOpts.api ?? [];
  if (declared.length === 0) {
    if ((cmdOpts.enable ?? []).length > 0) {
      throw usageError('--enable needs --api: it names a switch of one declared API');
    }
    return undefined;
  }
  if (cmdOpts.spec !== undefined) {
    throw usageError(
      '--spec and --api cannot be combined: declare every API with --api <name>=<source>',
    );
  }
  const declarations = declarationsOf(declared);
  const names = new Set(declarations.map((declaration) => declaration.name));
  const nameList = [...names].join(', ');
  const ownerOf = (flag: string, value: string): [string, string] => {
    const parts = splitPrefix(value);
    if (parts === undefined || !names.has(parts[0])) {
      throw usageError(
        `${flag} "${value}" does not start with the name of an API (${nameList}): write ${flag} <name>=…`,
      );
    }
    return parts;
  };
  const views = new Map(
    declarations.map(({ name, source }) => {
      const options: Record<string, unknown> = { ...cmdOpts, spec: source, deny: [] };
      for (const key of Object.values(PER_API_LISTS)) {
        options[key] = [];
      }
      for (const key of Object.values(PER_API_SCALARS)) {
        options[key] = defaults[key];
      }
      for (const key of Object.values(PER_API_SWITCHES)) {
        options[key] = undefined;
      }
      delete options['api'];
      delete options['enable'];
      return [name, options] as const;
    }),
  );
  const add = (name: string, key: string, value: string): void => {
    const options = views.get(name) as Record<string, unknown>;
    options[key] = [...(options[key] as string[]), value];
  };
  for (const [flag, key] of Object.entries(PER_API_LISTS)) {
    for (const value of (cmdOpts[key] ?? []) as readonly string[]) {
      const [name, rest] = ownerOf(flag, value);
      add(name, key, rest);
    }
  }
  // An unnamed --deny applies to every API: it can only narrow
  for (const value of cmdOpts.deny) {
    const parts = splitPrefix(value);
    if (parts !== undefined && API_NAME_PATTERN.test(parts[0])) {
      const [name, rest] = ownerOf('--deny', value);
      add(name, 'deny', rest);
    } else {
      for (const name of names) {
        add(name, 'deny', value);
      }
    }
  }
  const scalarSet = new Set<string>();
  for (const { flag, value } of occurrences) {
    if (flag in PER_API_SCALARS) {
      const key = PER_API_SCALARS[flag] as string;
      if (typeof value !== 'string') {
        throw usageError(`${flag} needs <name>=<value> with --api`);
      }
      const [name, rest] = ownerOf(flag, value);
      if (scalarSet.has(`${name} ${flag}`)) {
        throw usageError(`${flag} is given twice for the API "${name}"`);
      }
      scalarSet.add(`${name} ${flag}`);
      (views.get(name) as Record<string, unknown>)[key] = rest;
    } else {
      throw usageError(
        `${flag} cannot be used with --api; write --enable <name>=${flag.slice(2)} for each API that needs it`,
      );
    }
  }
  for (const value of cmdOpts.enable ?? []) {
    const [name, rest] = ownerOf('--enable', value);
    const key = PER_API_SWITCHES[rest];
    if (key === undefined) {
      throw usageError(
        `--enable "${value}" names no switch; one of ${Object.keys(PER_API_SWITCHES).join(', ')}`,
      );
    }
    (views.get(name) as Record<string, unknown>)[key] = true;
  }
  return declarations.map(({ name, source }) => ({
    name,
    source,
    options: views.get(name) as Opts,
  }));
};

// One fingerprint of every accepted spec, which the tools/list cursor binds
export const combinedContentHash = (apis: readonly { name: string; hash: string }[]): string =>
  createHash('sha256')
    .update(apis.map((api) => `${api.name}:${api.hash}`).join('\n'))
    .digest('hex');

// Every way an upstream may read a base path (decoded or not), lower-cased,
// without a trailing slash
const readingsOf = (url: URL): string[] => [
  ...new Set(
    [url.pathname, ...pathReadings(url.pathname)].map(
      (path) => `${path.replace(/\/+$/u, '').toLowerCase()}/`,
    ),
  ),
];

// Two bases overlap when any reading of one lies within any reading of the
// other: an upstream that decodes `%2F` sees `/shop%2Fv1` and `/shop/v1%2Fsub`
// as nested (review of #16)
const overlap = (first: URL, second: URL): boolean =>
  first.origin === second.origin &&
  readingsOf(first).some((one) =>
    readingsOf(second).some((other) => one.startsWith(other) || other.startsWith(one)),
  );

// No two APIs may share a cache namespace: different credentials would share
// an authenticated entry. Checked before any spec is loaded, so neither can
// touch the other's cache first (review of #16).
export const assertSeparateNamespaces = (
  apis: readonly { name: string; namespace: string }[],
): void => {
  const namespaces = new Map<string, string>();
  for (const api of apis) {
    const other = namespaces.get(api.namespace);
    if (other !== undefined) {
      throw usageError(
        `the APIs "${other}" and "${api.name}" load the same spec with the same cache key; give one of them its own --cache-key`,
      );
    }
    namespaces.set(api.namespace, api.name);
  }
};

// No base URL may lie within another's, since credentials are scoped to an
// API's base URL
export const assertSeparateBases = (apis: readonly { name: string; base: URL }[]): void => {
  for (const [index, first] of apis.entries()) {
    for (const second of apis.slice(index + 1)) {
      if (overlap(first.base, second.base)) {
        throw usageError(
          `the base URLs of the APIs "${first.name}" and "${second.name}" overlap (${first.base.href}, ${second.base.href}); each API needs a base URL of its own`,
        );
      }
    }
  }
};
