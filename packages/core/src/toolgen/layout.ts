import { z } from 'zod';
import { SPEC_BUDGETS } from '../spec/budgets.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { convertSchema, isDangerousKey } from './schema.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type FieldMapping =
  | { destination: 'path'; wireName: string; style: 'simple'; explode: boolean; required: true }
  | { destination: 'query'; wireName: string; style: 'form'; explode: boolean; required: boolean }
  | {
      destination: 'header';
      wireName: string;
      style: 'simple';
      explode: boolean;
      required: boolean;
    }
  | { destination: 'body'; bodyPath: readonly string[]; required: boolean };

export interface RequestMapper {
  bodyMode: 'flattened' | 'single' | 'none';
  bodyContentType?: 'application/json' | 'application/x-www-form-urlencoded';
  fields: Record<string, FieldMapping>;
}

export interface Field {
  preferred: string;
  name: string;
  location: 'path' | 'query' | 'header' | 'body';
  schema: z.ZodType;
  required: boolean;
  mapping: FieldMapping;
  bodyGroup?: { requiredWhenPresent: boolean };
}

const STYLE_SUPPORT: Readonly<Record<'path' | 'query' | 'header', 'simple' | 'form'>> = {
  path: 'simple',
  query: 'form',
  header: 'simple',
};

export const paramFields = (
  operation: OperationRecord,
  reservedHeaders: ReadonlySet<string>,
  // `version` threads the spec's OpenAPI version to convertSchema so a 3.0
  // `nullable: true` is honoured only under 3.0. The `'3.1'` default is
  // test-ergonomics only; production callers (buildLayout ← buildTools) always
  // pass the real spec version explicitly.
  version: OpenapiVersion = '3.1',
): { ok: Field[] } | { unrepresentable: string } => {
  const fields: Field[] = [];
  const seenHeaders = new Set<string>();
  for (const param of operation.parameters) {
    const { name } = param;
    const location = param['in'];
    if (
      typeof name !== 'string' ||
      (location !== 'path' && location !== 'query' && location !== 'header')
    ) {
      return { unrepresentable: 'a parameter with an unsupported location' };
    }
    // Validate EVERY parameter — including a reserved header — BEFORE deciding to
    // keep or drop it: the tool boundary is fully fail-closed, so a
    // malformed/unsupported reserved-header param omits the operation rather than
    // being silently discarded. allowReserved/content/style and the schema
    // conversion run first; the reserved-header drop comes after.
    if (param['allowReserved'] === true) {
      return { unrepresentable: `parameter "${name}" uses allowReserved, which is not supported` };
    }
    if (param['content'] !== undefined) {
      return { unrepresentable: `parameter "${name}" uses content instead of schema` };
    }
    const style = typeof param['style'] === 'string' ? param['style'] : STYLE_SUPPORT[location];
    if (style !== STYLE_SUPPORT[location]) {
      return { unrepresentable: `parameter "${name}" uses the unsupported style "${style}"` };
    }
    const explode = typeof param['explode'] === 'boolean' ? param['explode'] : style === 'form';
    const converted = convertSchema(param['schema'] ?? {}, version);
    if (!('ok' in converted)) {
      return { unrepresentable: `parameter "${name}": ${converted.unrepresentable}` };
    }
    if (location === 'header') {
      const lower = name.toLowerCase();
      // A reserved header (system or operator-auth) is validated above but NOT
      // exposed as a tool input — it is injected at request time. Drop it now (it
      // never reaches the mapper and does not participate in the kept-header dedup).
      if (reservedHeaders.has(lower)) {
        continue;
      }
      // HTTP header names are case-insensitive; two params differing only in case
      // target the same header and would serialize ambiguously. Omit fail-closed.
      if (seenHeaders.has(lower)) {
        return { unrepresentable: `duplicate header parameter "${name}" (case-insensitive)` };
      }
      seenHeaders.add(lower);
    }
    const schema =
      typeof param['description'] === 'string'
        ? converted.ok.describe(sanitizeSpecText(param['description'], SPEC_BUDGETS.maxTextLength))
        : converted.ok;
    const required = location === 'path' ? true : param['required'] === true;
    const mapping: FieldMapping =
      location === 'path'
        ? { destination: 'path', wireName: name, style: 'simple', explode, required: true }
        : location === 'query'
          ? { destination: 'query', wireName: name, style: 'form', explode, required }
          : { destination: 'header', wireName: name, style: 'simple', explode, required };
    fields.push({ preferred: name, name, location, schema, required, mapping });
  }
  return { ok: fields };
};

export interface LayoutResult {
  inputSchema: z.ZodType;
  mapper: RequestMapper;
}

type BodyContentType = 'application/json' | 'application/x-www-form-urlencoded';

interface BodyResult {
  fields: Field[];
  mode: 'flattened' | 'single' | 'none';
  contentType?: BodyContentType;
}

// Keys allowed on a body object-root for it to be FLATTENED. Anything else
// (not, enum, allOf, minProperties, nullable, ...) routes the body to the single
// `body` field via convertSchema, which then omits it if truly unrepresentable —
// so a root `not` is never bypassed by flattening.
const FLATTEN_ROOT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
  'example',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'xml',
  'externalDocs',
  '$comment',
  '$schema',
]);

const selectMedia = (
  content: Record<string, unknown>,
): { contentType: BodyContentType; entry: Record<string, unknown> } | undefined => {
  for (const contentType of ['application/json', 'application/x-www-form-urlencoded'] as const) {
    const entry = content[contentType];
    if (isRecord(entry)) {
      return { contentType, entry };
    }
  }
  return undefined;
};

const isFlattenableRoot = (root: unknown): root is Record<string, unknown> => {
  if (!isRecord(root)) {
    return false;
  }
  // Only a plain object root flattens: `type` must be exactly 'object' or absent.
  // A 3.1 nullable object (`type: ['object','null']`) or an array root routes to
  // the single `body` field instead, preserving the null/array alternative.
  if (root['type'] !== undefined && root['type'] !== 'object') {
    return false;
  }
  // Flatten only a CLOSED object: additionalProperties absent or exactly `false`.
  // `true`/schema route to the single `body` field. A MALFORMED value (e.g. `7`)
  // must ALSO leave the flatten path — otherwise it is silently ignored and an
  // operation is generated; the single-body path runs it through convertSchema,
  // which omits it (fail-closed).
  if (root['additionalProperties'] !== undefined && root['additionalProperties'] !== false) {
    return false;
  }
  if (!isRecord(root['properties']) || Object.keys(root['properties']).length === 0) {
    return false;
  }
  for (const key of Object.keys(root)) {
    if (!key.startsWith('x-') && !FLATTEN_ROOT_KEYS.has(key)) {
      return false;
    }
  }
  return true;
};

const bodyFields = (
  requestBody: Record<string, unknown> | undefined,
  version: OpenapiVersion = '3.1',
): { ok: BodyResult } | { unrepresentable: string } => {
  if (requestBody === undefined) {
    return { ok: { fields: [], mode: 'none' } };
  }
  const content = isRecord(requestBody['content']) ? requestBody['content'] : undefined;
  const media = content === undefined ? undefined : selectMedia(content);
  if (media === undefined) {
    return { unrepresentable: 'the request body has no JSON or form-urlencoded content' };
  }
  if (isRecord(media.entry['encoding']) && Object.keys(media.entry['encoding']).length > 0) {
    return { unrepresentable: 'a request body encoding object is not supported' };
  }
  const bodyRequired = requestBody['required'] === true;
  const root = media.entry['schema'];
  if (isFlattenableRoot(root)) {
    const properties = root['properties'] as Record<string, unknown>;
    // The flatten path never runs the root through convertSchema, so the root's
    // `required` bypasses schema.ts's malformedKeyword gate. Validate it here with
    // the same rule (an array of UNIQUE strings) — otherwise required:[123] or a
    // duplicate would be silently filtered, an invalid Schema Object accepted
    // (fail-closed; mirrors malformedKeyword's `required` check).
    const requiredRaw = root['required'];
    if (
      requiredRaw !== undefined &&
      (!Array.isArray(requiredRaw) ||
        !requiredRaw.every((k) => typeof k === 'string') ||
        new Set(requiredRaw).size !== requiredRaw.length)
    ) {
      return { unrepresentable: 'the request body has a malformed "required" array' };
    }
    const requiredProps = new Set(Array.isArray(requiredRaw) ? (requiredRaw as string[]) : []);
    // A required name with no declared property cannot be enforced on the flatten
    // path (which iterates declared properties only) — omit, mirroring
    // objectSchema. Object.hasOwn so an inherited name is not treated as declared.
    for (const name of requiredProps) {
      if (!Object.hasOwn(properties, name)) {
        return { unrepresentable: `body property "${name}" is required but not declared` };
      }
    }
    const fields: Field[] = [];
    for (const [prop, child] of Object.entries(properties)) {
      const converted = convertSchema(child, version, 1);
      if (!('ok' in converted)) {
        return { unrepresentable: `body property "${prop}": ${converted.unrepresentable}` };
      }
      const propRequired = requiredProps.has(prop);
      fields.push({
        preferred: prop,
        name: prop,
        location: 'body',
        schema: converted.ok,
        required: propRequired && bodyRequired,
        mapping: { destination: 'body', bodyPath: [prop], required: propRequired && bodyRequired },
        ...(bodyRequired ? {} : { bodyGroup: { requiredWhenPresent: propRequired } }),
      });
    }
    return { ok: { fields, mode: 'flattened', contentType: media.contentType } };
  }
  const converted = convertSchema(root ?? {}, version, 0);
  if (!('ok' in converted)) {
    return { unrepresentable: `request body: ${converted.unrepresentable}` };
  }
  return {
    ok: {
      fields: [
        {
          preferred: 'body',
          name: 'body',
          location: 'body',
          schema: converted.ok,
          required: bodyRequired,
          mapping: { destination: 'body', bodyPath: [], required: bodyRequired },
        },
      ],
      mode: 'single',
      contentType: media.contentType,
    },
  };
};

// Scans a path template's `{...}` runs into a placeholder-name set. Rejects an
// empty `{}`, a nested/unclosed brace, and a lone `}` with no matching `{` as
// malformed — the caller omits the operation fail-closed rather than guessing
// a name.
const pathPlaceholders = (path: string): { names: Set<string> } | { malformed: true } => {
  const names = new Set<string>();
  let inBrace = false;
  let current = '';
  for (const char of path) {
    if (char === '{') {
      if (inBrace) {
        return { malformed: true };
      }
      inBrace = true;
      current = '';
    } else if (char === '}') {
      if (!inBrace || current === '') {
        return { malformed: true };
      }
      names.add(current);
      inBrace = false;
    } else if (inBrace) {
      current += char;
    }
  }
  if (inBrace) {
    return { malformed: true };
  }
  return { names };
};

// The STATIC text of a path segment (a whole segment with no placeholder, or
// the literal text left over once every `{...}` placeholder run has been
// stripped from a mixed segment) is dangerous once decoded if it resolves to
// a dot-segment or smuggles a path separator: `.`/`..` (traversal), or a
// decoded `/`/`\` (an encoded separator baked into the spec's path template,
// which could re-emerge once the upstream origin decodes it and escape the
// intended base path). A decoded `?` or `#` is equally dangerous: joinFinalUrl
// (executor.ts) assembles the final URL by STRING CONCATENATION of the built
// pathname + `?` + query, so a static `?` baked into the path template would
// either truncate/inject the real query string or introduce a spec-baked
// query the caller never asked for, and a static `#` would smuggle a fragment
// into what should be plain path text. Malformed percent-encoding fails closed
// too.
const isDangerousStaticSegment = (segment: string): boolean => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }
  return (
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('?') ||
    decoded.includes('#')
  );
};

const resolveCollisions = (fields: Field[]): { ok: Field[] } | { unrepresentable: string } => {
  const preferredCounts = new Map<string, number>();
  for (const field of fields) {
    preferredCounts.set(field.preferred, (preferredCounts.get(field.preferred) ?? 0) + 1);
  }
  for (const field of fields) {
    field.name =
      (preferredCounts.get(field.preferred) ?? 0) > 1
        ? `${field.location}_${field.preferred}`
        : field.preferred;
  }
  const finalCounts = new Map<string, number>();
  for (const field of fields) {
    finalCounts.set(field.name, (finalCounts.get(field.name) ?? 0) + 1);
  }
  for (const [name, count] of finalCounts) {
    if (count > 1) {
      return { unrepresentable: `field name "${name}" still collides after location prefixing` };
    }
  }
  return { ok: fields };
};

export const buildLayout = (
  operation: OperationRecord,
  reservedHeaders: ReadonlySet<string>,
  version: OpenapiVersion = '3.1',
): { ok: LayoutResult } | { unrepresentable: string } => {
  const params = paramFields(operation, reservedHeaders, version);
  if (!('ok' in params)) {
    return params;
  }
  const body = bodyFields(operation.requestBody, version);
  if (!('ok' in body)) {
    return body;
  }
  const resolved = resolveCollisions([...params.ok, ...body.ok.fields]);
  if (!('ok' in resolved)) {
    return resolved;
  }
  // Build-time path-template consistency guard (fail-closed): the executor
  // later builds the request URL by substituting every `destination:'path'`
  // wireName into `operation.path`'s `{...}` placeholders. A mismatch in
  // either direction — a placeholder with no path param, or a path param with
  // no placeholder — would build a broken (or, worse, silently wrong) URL, so
  // omit the operation here instead of at call time.
  for (const segment of operation.path.split('/')) {
    // Strip every well-formed `{...}` run before checking: static text baked
    // AROUND a placeholder in the SAME segment (e.g. `{id}.json`, or a
    // hostile `{id}%2F..%2Fadmin`) must still be validated as static text. A
    // segment that is ONLY a placeholder strips to '' (never dangerous). A
    // malformed brace (unclosed, empty, nested, or a lone `}`) does not match
    // the strip pattern and is left in place for `pathPlaceholders` below to
    // reject fail-closed.
    const staticText = segment.replaceAll(/\{[^{}]+\}/gu, '');
    if (isDangerousStaticSegment(staticText)) {
      return { unrepresentable: `the path template has an unsafe static segment "${segment}"` };
    }
  }
  const placeholders = pathPlaceholders(operation.path);
  if ('malformed' in placeholders) {
    return { unrepresentable: 'the path template has a malformed "{...}" placeholder' };
  }
  const pathWireNames = new Set<string>();
  for (const field of resolved.ok) {
    if (field.mapping.destination === 'path') {
      pathWireNames.add(field.mapping.wireName);
    }
  }
  const placeholdersMatch =
    placeholders.names.size === pathWireNames.size &&
    [...placeholders.names].every((name) => pathWireNames.has(name));
  if (!placeholdersMatch) {
    return {
      unrepresentable: 'the path template placeholders do not match its path parameters',
    };
  }
  // A field whose preferred (wire) name is prototype-hazardous omits the
  // operation (fail-closed). Location prefixing never produces such a name, so
  // checking the preferred name covers every final shape key.
  for (const field of resolved.ok) {
    if (isDangerousKey(field.preferred)) {
      return { unrepresentable: `a field named "${field.preferred}"` };
    }
  }
  const shape: Record<string, z.ZodType> = {};
  for (const field of resolved.ok) {
    shape[field.name] = field.required ? field.schema : field.schema.optional();
  }
  let inputSchema: z.ZodType = z.strictObject(shape);
  const group = resolved.ok.filter((field) => field.bodyGroup !== undefined);
  const requiredNames = group
    .filter((field) => field.bodyGroup?.requiredWhenPresent === true)
    .map((field) => field.name);
  if (group.length > 0 && requiredNames.length > 0) {
    const groupNames = group.map((field) => field.name);
    inputSchema = inputSchema.refine(
      (value) => {
        const record = value as Record<string, unknown>;
        const anyPresent = groupNames.some((name) => record[name] !== undefined);
        return !anyPresent || requiredNames.every((name) => record[name] !== undefined);
      },
      { message: 'provide all required body fields together, or omit the body entirely' },
    );
  }
  const fields: Record<string, FieldMapping> = {};
  for (const field of resolved.ok) {
    fields[field.name] = field.mapping;
  }
  const mapper: RequestMapper = {
    bodyMode: body.ok.mode,
    ...(body.ok.contentType === undefined ? {} : { bodyContentType: body.ok.contentType }),
    fields,
  };
  return { ok: { inputSchema, mapper } };
};
