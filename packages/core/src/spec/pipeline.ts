import { usageError, validationError } from '../errors.ts';
import type { DnsLookup } from '../http/egress.ts';
import type { ResolvedHeader } from '../http/headers.ts';
import { assignToolNames, type NamedOperation } from '../toolgen/naming.ts';
import { SPEC_BUDGETS } from './budgets.ts';
import { dereference } from './dereference.ts';
import { fetchSpec } from './fetch.ts';
import { loadSpecFromFile, parseSpecSource, type LoadedSpecText } from './load.ts';
import { normalizeSpec, type NormalizedSpec } from './normalize.ts';
import { parseSpecText } from './parse.ts';
import { validateOpenApiDocument } from './validate.ts';

export interface SpecPipelineOptions {
  specHeaders: readonly ResolvedHeader[];
  timeoutMs: number;
  cwd: string;
  allowPrivateNetwork: boolean;
}

export interface SpecPipelineDeps {
  fetcher: typeof fetch;
  lookup: DnsLookup;
  readFileText: (path: string) => Promise<string>;
  fileSizeBytes: (path: string) => Promise<number>;
}

export interface SpecPipelineResult {
  spec: NormalizedSpec;
  namedOperations: readonly NamedOperation[];
  contentHash: string;
  displaySource: string;
}

// M2a loads fresh on every run; M2b inserts the cache between load and parse
export const runSpecPipeline = async (
  rawSource: string,
  opts: SpecPipelineOptions,
  deps: SpecPipelineDeps,
): Promise<SpecPipelineResult> => {
  const source = parseSpecSource(rawSource, { cwd: opts.cwd });
  let loaded: LoadedSpecText;
  if (source.kind === 'url') {
    loaded = await fetchSpec(
      source.url,
      {
        headers: opts.specHeaders,
        timeoutMs: opts.timeoutMs,
        allowPrivateNetwork: opts.allowPrivateNetwork,
      },
      { fetcher: deps.fetcher, lookup: deps.lookup },
    );
  } else {
    if (opts.specHeaders.length > 0) {
      throw usageError('--spec-header-env only applies to URL spec sources');
    }
    loaded = await loadSpecFromFile(source.path, SPEC_BUDGETS.maxSpecBytes, deps);
  }
  const parsed = parseSpecText(loaded.text);
  const validated = validateOpenApiDocument(parsed);
  const dereferenced = dereference(validated.document);
  const spec = normalizeSpec(dereferenced, validated.version);
  if (spec.operations.length > SPEC_BUDGETS.maxToolCount) {
    throw validationError(
      `spec defines ${spec.operations.length} operations — exceeds the ${SPEC_BUDGETS.maxToolCount}-tool budget`,
    );
  }
  const namedOperations = assignToolNames(spec.operations);
  return {
    spec,
    namedOperations,
    contentHash: loaded.contentHash,
    displaySource: loaded.displaySource,
  };
};
