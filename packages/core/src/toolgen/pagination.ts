import type { OperationRecord } from '../spec/normalize.ts';
import type { RequestMapper } from './layout.ts';
import { deepObjectValue, fieldOf, hintValue, linkValue } from './pagination-values.ts';
import type { HintScalar, PaginationField } from './pagination-values.ts';

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
  return {
    query,
    carried,
    bodyCursors,
    ...(startingAfter === undefined ? {} : { startingAfter }),
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

// A deepObject parameter on the wire: `name[key]`, exactly one level, with
// neither part empty nor containing a bracket (the serializer refuses
// bracketed keys as ambiguous with nesting, #108). Brackets may arrive
// percent-encoded (`%5B`/`%5D`); URLSearchParams has decoded them by now.
const DEEP_OBJECT_KEY_RE = /^(?<name>[^[\]]+)\[(?<key>[^[\]]+)\]$/u;

// One next-link query parameter mapped onto the tool's fields: a form or
// delimited field by its wire name, or one property of a deepObject field
// by `name[key]`. A name both could claim (a parameter literally declared
// as `page[number]` next to a deepObject `page`) is ambiguous: no mapping.
type LinkParam =
  | { field: PaginationField; value: HintScalar | HintScalar[] }
  | { field: PaginationField; key: string; value: HintScalar };

// The tool field for a query wire name: own entries only, so a link
// parameter named `constructor` or `__proto__` never resolves to
// Object.prototype's members.
const queryField = (plan: PaginationPlan, name: string): PaginationField | undefined =>
  Object.hasOwn(plan.query, name) ? plan.query[name] : undefined;

const linkParam = (
  plan: PaginationPlan,
  name: string,
  raws: readonly string[],
): LinkParam | undefined => {
  const direct = queryField(plan, name);
  const { name: owned, key } = DEEP_OBJECT_KEY_RE.exec(name)?.groups ?? {};
  const owner = owned === undefined ? undefined : queryField(plan, owned);
  const deep = owner?.kind === 'object' ? owner : undefined;
  if (direct !== undefined && deep !== undefined) {
    return undefined;
  }
  if (deep !== undefined && key !== undefined) {
    const value = deepObjectValue(raws, deep, key);
    return value === undefined ? undefined : { field: deep, key, value };
  }
  const value = direct === undefined ? undefined : linkValue(raws, direct);
  return direct === undefined || value === undefined ? undefined : { field: direct, value };
};

// From `Link: <...>; rel="next"`: only a target with the SAME origin and
// path as the request is accepted, and every one of its query parameters
// must map onto one of the tool's own query fields (a deepObject field's
// properties included) — otherwise no hint. A hostile upstream therefore
// cannot steer the next call to another host, path or parameter. Returns
// `{ next }` whenever a Link header was sent (its verdict is final),
// undefined when there was none.
const fromLink = (plan: PaginationPlan, input: HintInput): { next?: Args } | undefined => {
  if (input.links === undefined) {
    return undefined;
  }
  const link = input.links.find((candidate) => candidate.rels.includes('next'));
  const target = link === undefined ? undefined : parseUrl(link.target, input.responseUrl);
  const request = parseUrl(input.requestUrl);
  if (
    target === undefined ||
    request === undefined ||
    target.origin !== request.origin ||
    target.pathname !== request.pathname
  ) {
    return {};
  }
  const mapped: Args = carriedArgs(plan, input.args);
  // The deepObject properties, collected per field and assembled at the end
  // with Object.fromEntries (own data properties, whatever the key).
  const objects = new Map<string, [string, HintScalar][]>();
  for (const name of new Set(target.searchParams.keys())) {
    const param = linkParam(plan, name, target.searchParams.getAll(name));
    if (param === undefined) {
      return {};
    }
    if ('key' in param) {
      const entries = objects.get(param.field.field) ?? [];
      entries.push([param.key, param.value]);
      objects.set(param.field.field, entries);
    } else {
      mapped[param.field.field] = param.value;
    }
  }
  for (const [field, entries] of objects) {
    mapped[field] = Object.fromEntries(entries);
  }
  return { next: mapped };
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
// upstream sent one (even "no next"); otherwise a recognized body cursor.
export const nextPageHint = (plan: PaginationPlan, input: HintInput): PageHint => {
  const linked = fromLink(plan, input);
  const next = linked === undefined ? fromBody(plan, input) : linked.next;
  return { next: next ?? NO_NEXT_PAGE };
};
