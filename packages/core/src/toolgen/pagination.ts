import type { OperationRecord } from '../spec/normalize.ts';
import type { RequestMapper } from './layout.ts';
import { isJsonApiResponse, jsonApiBranches, queryArgs } from './pagination-links.ts';
import type { JsonApiBranches } from './pagination-links.ts';
import { fieldOf, hintValue } from './pagination-values.ts';
import type { PaginationField } from './pagination-values.ts';

export type { PaginationField } from './pagination-values.ts';

// Pagination support, decided once at tool-generation time from the spec
// alone (no runtime guessing from response data): an operation is
// "paginated" when it is a GET and either has a query parameter with a
// well-known page/cursor name, or declares a `Link` response header. For
// such a tool the result carries `pagination.next`: the ARGUMENTS for the
// next call — never a URL — or null when no next page is known (the last
// page, or the upstream did not say; null never claims "exhausted").

// Query parameter names that select a page or cursor. Size and position
// controls (`limit`, `offset`, `per_page`, `page_size`) alone do not make an
// operation paginated: without a Link header or a body cursor no hint could
// ever be derived for them, so `next` would always be null.
const PAGINATION_PARAMS: ReadonlySet<string> = new Set([
  'cursor',
  'page_token',
  'pagetoken',
  'after',
  'starting_after',
  'page',
]);

// Body cursor conventions: a response property whose value is the cursor
// for a given query parameter (`next_cursor` -> `?cursor=`, Google's
// `nextPageToken` -> `?pageToken=`, ...).
const BODY_CURSORS: readonly { property: string; param: string }[] = [
  { property: 'next_cursor', param: 'cursor' },
  { property: 'nextCursor', param: 'cursor' },
  { property: 'next_page_token', param: 'page_token' },
  { property: 'nextPageToken', param: 'pageToken' },
];

export type PaginationPlan = {
  // Query wire name -> the tool field carrying it.
  query: Readonly<Record<string, PaginationField>>;
  // Tool fields that are NOT query parameters (path/header): carried over
  // unchanged into `next`, since a next-page link must keep the same path.
  carried: readonly string[];
  // Applicable body-cursor rules (only those whose parameter exists).
  bodyCursors: readonly { property: string; field: PaginationField }[];
  // Stripe-style `has_more` + last item id -> `starting_after`.
  startingAfter?: PaginationField;
  // The success responses declared JSON:API-shaped (pagination-links.ts):
  // when the actual response is one of them, its top-level `links.next` URL
  // is read like a Link header's. Absent when the operation has none.
  jsonApiLinks?: JsonApiBranches;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const declaresLinkHeader = (responses: Readonly<Record<string, unknown>>): boolean =>
  Object.entries(responses).some(
    ([status, response]) =>
      status.startsWith('2') &&
      isRecord(response) &&
      isRecord(response['headers']) &&
      Object.keys(response['headers']).some((name) => name.toLowerCase() === 'link'),
  );

export const detectPagination = (
  operation: OperationRecord,
  mapper: RequestMapper,
  wireSchema: Readonly<Record<string, unknown>>,
): PaginationPlan | undefined => {
  if (operation.method.toLowerCase() !== 'get') {
    return undefined;
  }
  const properties = isRecord(wireSchema['properties']) ? wireSchema['properties'] : {};
  const query: Record<string, PaginationField> = {};
  const carried: string[] = [];
  for (const [field, mapping] of Object.entries(mapper.fields)) {
    if (mapping.destination === 'query') {
      query[mapping.wireName] = fieldOf(field, properties[field], mapping);
    } else {
      carried.push(field);
    }
  }
  const named = Object.keys(query).some((name) => PAGINATION_PARAMS.has(name.toLowerCase()));
  if (!named && !declaresLinkHeader(operation.responses)) {
    return undefined;
  }
  const bodyCursors = BODY_CURSORS.flatMap(({ property, param }) => {
    const field = query[param];
    return field === undefined ? [] : [{ property, field }];
  });
  const startingAfter = query['starting_after'];
  const jsonApiLinks = jsonApiBranches(operation.responses);
  return {
    query,
    carried,
    bodyCursors,
    ...(startingAfter === undefined ? {} : { startingAfter }),
    ...(jsonApiLinks === undefined ? {} : { jsonApiLinks }),
  };
};

// The `pagination` envelope property's schema (only on paginated tools).
export const PAGINATION_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    // Any argument object: `next` carries the call's other arguments too
    // (booleans, arrays, ...). It is checked against the tool's own input
    // schema at run time instead (an invalid hint becomes null).
    next: { type: ['object', 'null'] },
  },
  required: ['next'],
  additionalProperties: false,
};

export type HintInput = {
  // Parsed `Link` header (rel=next looked up here), if any.
  links?: readonly { target: string; rels: readonly string[] }[];
  // The URL the response came from (relative link targets) and the URL
  // that was requested (origin + path a next link must keep).
  responseUrl: string;
  requestUrl: string;
  // The parsed response body, when available.
  data?: unknown;
  // The response's status and Content-Type (which documented response it is).
  status?: number;
  contentType?: string;
  // The arguments of the call that produced this page.
  args: Readonly<Record<string, unknown>>;
};

const carriedArgs = (plan: PaginationPlan, args: HintInput['args']): Record<string, unknown> =>
  Object.fromEntries(
    plan.carried.flatMap((field) => (field in args ? [[field, args[field]]] : [])),
  );

type Args = Record<string, unknown>;

// The wire contract: `pagination.next` is JSON null when no next page is
// known. Internally "no next page" is `undefined`; this is the one place it
// becomes null.
// oxlint-disable-next-line unicorn/no-null -- the hint's JSON contract requires null for "no next page"
export const NO_NEXT_PAGE = null;

export type PageHint = { next: Args | typeof NO_NEXT_PAGE };

const parseUrl = (raw: string, base?: string): URL | undefined => {
  try {
    return new URL(raw, base);
  } catch {
    return undefined;
  }
};

// A next-page URL (from a Link header or a JSON:API `links.next`) turned
// into arguments: only a target with the SAME origin and path as the
// request is accepted, and every one of its query parameters must map onto
// one of the tool's own query fields (a deepObject field's properties
// included) — otherwise no hint. A hostile upstream therefore cannot steer
// the next call to another host, path or parameter. A relative target is
// resolved against the response URL.
const fromNextUrl = (
  plan: PaginationPlan,
  input: HintInput,
  raw: string | undefined,
): { next?: Args } => {
  const target = raw === undefined ? undefined : parseUrl(raw, input.responseUrl);
  const request = parseUrl(input.requestUrl);
  if (
    target === undefined ||
    request === undefined ||
    target.origin !== request.origin ||
    target.pathname !== request.pathname
  ) {
    return {};
  }
  const next = queryArgs(plan.query, target.searchParams, carriedArgs(plan, input.args));
  return next === undefined ? {} : { next };
};

// The RFC 8288 / IANA relation types that describe pagination. A Link
// header that carries none of them (only `deprecation`, `describedby`, ...,
// or nothing parsable) says nothing about pages.
const PAGINATION_RELS: ReadonlySet<string> = new Set(['next', 'prev', 'previous', 'first', 'last']);

// From `Link: <...>; rel="next"`. Returns `{ next }` when the Link header
// speaks about pagination (its verdict is final, even "no next": e.g. only
// rel="prev" on the last page), undefined when there was none or it carried
// no pagination relation, so a body link or cursor still gets its turn.
const fromLink = (plan: PaginationPlan, input: HintInput): { next?: Args } | undefined => {
  const paging = input.links?.some((candidate) =>
    candidate.rels.some((rel) => PAGINATION_RELS.has(rel.toLowerCase())),
  );
  if (input.links === undefined || paging !== true) {
    return undefined;
  }
  const link = input.links.find((candidate) =>
    candidate.rels.some((rel) => rel.toLowerCase() === 'next'),
  );
  return fromNextUrl(plan, input, link?.target);
};

// A JSON:API link is a URI-reference string or a link object whose `href`
// is one (JSON:API 1.1, "Links"); null means the link does not exist.
const jsonApiHref = (link: unknown): string | undefined => {
  if (typeof link === 'string') {
    return link;
  }
  const href = isRecord(link) ? link['href'] : undefined;
  return typeof href === 'string' ? href : undefined;
};

// From a JSON:API document's top-level `links.next` (only when the actual
// response is one of the declared JSON:API branches). A `links` object is the document's verdict: a next link
// is mapped like a Link target, and anything else (null on the last page,
// absent, malformed) is "no next page". Undefined when the body has no
// `links` object, so the body cursors still get their turn.
const fromJsonApiLinks = (plan: PaginationPlan, input: HintInput): { next?: Args } | undefined => {
  const { data } = input;
  if (
    plan.jsonApiLinks === undefined ||
    input.status === undefined ||
    !isJsonApiResponse(plan.jsonApiLinks, input.status, input.contentType) ||
    !isRecord(data) ||
    !isRecord(data['links'])
  ) {
    return undefined;
  }
  return fromNextUrl(plan, input, jsonApiHref(data['links']['next']));
};

const withArg = (args: Args, field: PaginationField, raw: unknown): Args | undefined => {
  const value = hintValue(raw, field);
  return value === undefined ? undefined : { ...args, [field.field]: value };
};

const fromBody = (plan: PaginationPlan, input: HintInput): Args | undefined => {
  const { data } = input;
  if (!isRecord(data)) {
    return undefined;
  }
  const rule = plan.bodyCursors.find(({ property }) => data[property] !== undefined);
  if (rule !== undefined) {
    return withArg(input.args, rule.field, data[rule.property]);
  }
  const items = data['data'];
  if (plan.startingAfter !== undefined && data['has_more'] === true && Array.isArray(items)) {
    const last: unknown = items.at(-1);
    return isRecord(last) ? withArg(input.args, plan.startingAfter, last['id']) : undefined;
  }
  return undefined;
};

// `next` for a paginated tool's result: a `Link` header decides when the
// upstream sent one (even "no next"); then a JSON:API `links` object; then
// a recognized body cursor.
export const nextPageHint = (plan: PaginationPlan, input: HintInput): PageHint => {
  const linked = fromLink(plan, input) ?? fromJsonApiLinks(plan, input);
  const next = linked === undefined ? fromBody(plan, input) : linked.next;
  return { next: next ?? NO_NEXT_PAGE };
};
