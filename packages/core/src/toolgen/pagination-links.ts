import { parseMediaType } from './media-type.ts';
import { deepObjectValue, linkValue } from './pagination-values.ts';
import type { HintScalar, PaginationField } from './pagination-values.ts';

// Next-page URLs: where a response declares one in its body (JSON:API), and
// how a next URL's query maps back onto a tool's own arguments. The
// same-origin / same-path rule is applied by the caller (pagination.ts).

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// JSON:API (https://jsonapi.org/format/#fetching-pagination) puts the next
// page in the BODY: a top-level `links` object whose `next` is a URL. It is
// read only where the spec says the response has that shape: a JSON:API
// media type (`application/vnd.api+json`), or a JSON schema that declares
// `links.next`. An arbitrary body that merely happens to carry `links` is
// never treated as a pagination link.
const JSON_API_ESSENCE = 'application/vnd.api+json';

const declaresLinksNext = (schema: unknown): boolean => {
  if (!isRecord(schema) || !isRecord(schema['properties'])) {
    return false;
  }
  const { links } = schema['properties'];
  return isRecord(links) && isRecord(links['properties']) && 'next' in links['properties'];
};

export const declaresJsonApiLinks = (responses: Readonly<Record<string, unknown>>): boolean =>
  Object.entries(responses).some(
    ([status, response]) =>
      status.startsWith('2') &&
      isRecord(response) &&
      isRecord(response['content']) &&
      Object.entries(response['content']).some(
        ([type, entry]) =>
          parseMediaType(type)?.essence === JSON_API_ESSENCE ||
          (isRecord(entry) && declaresLinksNext(entry['schema'])),
      ),
  );

// Query wire name -> the tool field carrying it.
type QueryFields = Readonly<Record<string, PaginationField>>;

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
const queryField = (query: QueryFields, name: string): PaginationField | undefined =>
  Object.hasOwn(query, name) ? query[name] : undefined;

const linkParam = (
  query: QueryFields,
  name: string,
  raws: readonly string[],
): LinkParam | undefined => {
  const direct = queryField(query, name);
  const { name: owned, key } = DEEP_OBJECT_KEY_RE.exec(name)?.groups ?? {};
  const owner = owned === undefined ? undefined : queryField(query, owned);
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

// Every query parameter of a next URL, mapped onto `base` (the arguments
// carried over unchanged): undefined as soon as one parameter does not map
// or decode, so a URL is used whole or not at all.
export const queryArgs = (
  query: QueryFields,
  params: URLSearchParams,
  base: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const mapped = { ...base };
  // The deepObject properties, collected per field and assembled at the end
  // with Object.fromEntries (own data properties, whatever the key).
  const objects = new Map<string, [string, HintScalar][]>();
  for (const name of new Set(params.keys())) {
    const param = linkParam(query, name, params.getAll(name));
    if (param === undefined) {
      return undefined;
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
  return mapped;
};
