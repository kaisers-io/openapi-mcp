import type { OperationRecord } from '../spec/normalize.ts';
import type { RequestMapper } from './layout.ts';

// Pagination support, decided once at tool-generation time from the spec
// alone (no runtime guessing from response data): an operation is
// "paginated" when it is a GET and either has a query parameter with a
// well-known pagination name, or declares a `Link` response header. For
// such a tool the result carries `pagination.next`: the ARGUMENTS for the
// next call — never a URL — or null when no next page is known.

// Query parameter names treated as page/cursor/size controls.
const PAGINATION_PARAMS: ReadonlySet<string> = new Set([
  'cursor',
  'page_token',
  'pagetoken',
  'after',
  'starting_after',
  'page',
  'offset',
  'limit',
  'per_page',
  'page_size',
  'pagesize',
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

export type PaginationField = { field: string; numeric: boolean };

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

const isNumericSchema = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  const { type } = schema;
  const types = Array.isArray(type) ? type : [type];
  return types.includes('integer') || types.includes('number');
};

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
      query[mapping.wireName] = { field, numeric: isNumericSchema(properties[field]) };
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
    next: {
      type: ['object', 'null'],
      additionalProperties: { type: ['string', 'number'] },
    },
  },
  required: ['next'],
  additionalProperties: false,
};

// Hint values become the NEXT call's arguments, so they must be safe as
// such: bounded, printable, and (for numeric fields) actually numeric.
const MAX_HINT_VALUE_LENGTH = 1024;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point (a value carrying one is refused)
const CONTROL_RE = /[\u0000-\u001F\u007F]/u;
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/u;

const hintValue = (raw: unknown, field: PaginationField): string | number | undefined => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return field.numeric ? raw : String(raw);
  }
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_HINT_VALUE_LENGTH) {
    return undefined;
  }
  if (CONTROL_RE.test(raw)) {
    return undefined;
  }
  if (!field.numeric) {
    return raw;
  }
  return NUMERIC_RE.test(raw) ? Number(raw) : undefined;
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

// From `Link: <...>; rel="next"`: only a target with the SAME origin and
// path as the request is accepted, and every one of its query parameters
// must map onto one of the tool's own query fields — otherwise no hint.
// A hostile upstream therefore cannot steer the next call to another host,
// path or parameter. Returns `{ next }` whenever a Link header was sent
// (its verdict is final), undefined when there was none.
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
  const seen = new Set<string>();
  for (const [name, raw] of target.searchParams) {
    const field = plan.query[name];
    const value = field === undefined ? undefined : hintValue(raw, field);
    if (field === undefined || value === undefined || seen.has(name)) {
      return {};
    }
    seen.add(name);
    mapped[field.field] = value;
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
