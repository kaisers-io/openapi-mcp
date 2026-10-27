import { isIP } from 'node:net';
import { EgressError, pinnedLookup, validateHopUrlSync } from '../../http/pinned-dispatcher.ts';
import type { PinnedPolicy, Resolve } from '../../http/pinned-dispatcher.ts';
import type { ToolCallOutcome } from '../result.ts';
import type { SnapshotTool } from '../types.ts';
import type { ExecutorConfig } from './executor.ts';
import { callArguments, checkBase, prepareCall, readCallUploads, unsent } from './prepare.ts';
import { overFinalBudget } from './wire.ts';

// `call --dry-run` (issue #78): the request a tool call would send, built by
// the same steps as the executor (prepare.ts), described instead of sent. No
// value of a header is reported, only its name, and a credential as `set`.
// The egress check resolves the host, as the transport would before it
// connects; nothing else leaves the process.

export type DryRunCheck =
  | { status: 'allowed' }
  | { status: 'refused'; reason: string }
  | { status: 'not evaluated'; reason: string };

export type DryRunHeader = { name: string; credential?: 'set' | 'not evaluated' };

export type DryRunReport = {
  method: string;
  origin: string;
  path: string;
  // Parameter names only, never their values
  query: string[];
  headers: DryRunHeader[];
  body: { mediaType?: string; bytes: number } | 'none';
  uploads: { field: string; file: string; bytes: number }[];
  checks: { route: DryRunCheck; egress: DryRunCheck; budgets: DryRunCheck };
  // What only sending can show
  notEvaluated: string[];
};

const NOT_EVALUATED = [
  'redirects and their targets',
  'the DNS answer at the time of sending',
  'the response',
  'the queue and the rate limit of a running server',
];

const isFileReference = (value: unknown): value is { file: string } =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { file?: unknown }).file === 'string';

const ignore = (): void => {};

// The answer the transport's own lookup would give, without connecting
const lookupCheck = async (
  hostname: string,
  policy: PinnedPolicy,
  resolve: Resolve,
): Promise<DryRunCheck> => {
  const checked = Promise.withResolvers<DryRunCheck>();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- pinnedLookup has the Node-style lookup contract the transport's connector calls
  pinnedLookup(policy, resolve)(hostname, { all: true }, (error) => {
    if (error === null) {
      checked.resolve({ status: 'allowed' });
    } else if (error instanceof EgressError) {
      checked.resolve({ status: 'refused', reason: error.message });
    } else {
      checked.resolve({
        status: 'not evaluated',
        reason: `the host did not resolve: ${error.message}`,
      });
    }
  });
  return await checked.promise;
};

const routeCheck = (refusal: string | undefined, configured: boolean): DryRunCheck => {
  if (!configured) {
    return { status: 'not evaluated', reason: 'no route table is configured' };
  }
  return refusal === undefined ? { status: 'allowed' } : { status: 'refused', reason: refusal };
};

const egressCheck = async (
  url: URL,
  policy: PinnedPolicy,
  resolve: Resolve,
): Promise<DryRunCheck> => {
  // oxlint-disable-next-line node/no-sync -- pure in-memory URL/IP classification, as in pinnedRequest
  const sync = validateHopUrlSync(url, policy);
  if (sync !== undefined) {
    return { status: 'refused', reason: sync };
  }
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return isIP(hostname) === 0
    ? await lookupCheck(hostname, policy, resolve)
    : { status: 'allowed' };
};

export const dryRunCall = async (
  config: ExecutorConfig,
  tool: SnapshotTool,
  args: unknown,
  resolve: Resolve,
): Promise<{ report: DryRunReport } | { refused: ToolCallOutcome }> => {
  const { generated } = tool;
  if (generated === undefined) {
    return { refused: unsent('this tool has no upstream operation to execute') };
  }
  const checked = checkBase(config, generated, ignore);
  if ('refused' in checked) {
    return checked;
  }
  const uploaded =
    config.uploads === undefined
      ? { data: callArguments(args) }
      : await readCallUploads(config.uploads, generated, args, ignore);
  if ('refused' in uploaded) {
    return uploaded;
  }
  const preparation = prepareCall(config, generated, checked.base, uploaded.data);
  if ('refused' in preparation) {
    return preparation;
  }
  const { method, built, finalUrl, authorizeHop, assemble } = preparation.prepared;
  const { sameOriginHeaders } = assemble();
  const credentials = new Set(config.secretHeaders.map((header) => header.name.toLowerCase()));
  const headers: DryRunHeader[] = Object.keys(sameOriginHeaders).map((name) =>
    credentials.has(name) ? { name, credential: 'set' } : { name },
  );
  if (config.oauth !== undefined) {
    headers.push({ name: 'authorization', credential: 'not evaluated' });
  }
  const refusal = authorizeHop?.(finalUrl, method, 0);
  const given = callArguments(args);
  return {
    report: {
      method,
      origin: finalUrl.origin,
      path: finalUrl.pathname,
      query: [...new Set(new URLSearchParams(finalUrl.search).keys())],
      headers,
      body:
        built.body === undefined
          ? 'none'
          : {
              ...(built.contentType === undefined ? {} : { mediaType: built.contentType }),
              bytes: built.body.byteLength,
            },
      uploads: Object.entries(generated.mapper.fields).flatMap(([field, mapping]) => {
        const value = given[field];
        const resolved = uploaded.data[field];
        return mapping.destination === 'body' &&
          mapping.upload === true &&
          isFileReference(value) &&
          typeof resolved === 'string'
          ? [{ field, file: value.file, bytes: Buffer.from(resolved, 'base64').byteLength }]
          : [];
      }),
      checks: {
        route: routeCheck(refusal, authorizeHop !== undefined),
        egress: await egressCheck(
          finalUrl,
          { trusted: config.baseTrusted, allowPrivateNetwork: config.allowPrivateNetwork },
          resolve,
        ),
        budgets: overFinalBudget(finalUrl, sameOriginHeaders, config.outboundBudgets)
          ? { status: 'refused', reason: 'the request exceeds the outbound resource budget' }
          : { status: 'allowed' },
      },
      notEvaluated: [
        ...NOT_EVALUATED,
        ...(config.oauth === undefined
          ? []
          : ['the OAuth2 access token, its size and its request']),
      ],
    },
  };
};
