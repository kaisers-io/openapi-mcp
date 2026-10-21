import { z } from 'zod';
import { SPEC_BUDGETS } from '../spec/budgets.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { FORM_URLENCODED, isJsonEssence, parseMediaType } from './media-type.ts';
import { convertSchema, isDangerousKey } from './schema.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type FieldMapping =
  | { destination: 'path'; wireName: string; style: 'simple'; explode: boolean; required: true }
  | {
      destination: 'query';
      wireName: string;
      style: QueryStyle;
      explode: boolean;
      required: boolean;
    }
  | {
      destination: 'header';
      wireName: string;
      style: 'simple';
      explode: boolean;
      required: boolean;
    }
  | { destination: 'body'; bodyPath: readonly string[]; required: boolean };

export type QueryStyle = 'form' | 'deepObject' | 'spaceDelimited' | 'pipeDelimited';

export type RequestMapper = {
  bodyMode: 'flattened' | 'single' | 'none';
  // The request body's media type exactly as the spec declares it (parameters
  // included, decision D5): `application/json`, any `application/*+json`
  // variant, or `application/x-www-form-urlencoded`. Sent verbatim as the
  // Content-Type; buildRequest picks the encoding from its essence.
  bodyContentType?: string;
  fields: Record<string, FieldMapping>;
};

export type Field = {
  preferred: string;
  name: string;
  location: 'path' | 'query' | 'header' | 'body';
  schema: z.ZodType;
  required: boolean;
  mapping: FieldMapping;
  bodyGroup?: { requiredWhenPresent: boolean };
};

const STYLE_SUPPORT: Readonly<Record<'path' | 'query' | 'header', 'simple' | 'form'>> = {
  path: 'simple',
  query: 'form',
  header: 'simple',
};

const SCALAR_TYPES: ReadonlySet<unknown> = new Set(['string', 'number', 'integer', 'boolean']);

// A schema whose instances are scalars: a scalar `type` (3.1 `[T,'null']`
// included), or a typeless enum/const. Anything else — an object, an array, a
// composition, an unconstrained `{}` — is not provably scalar.
const isScalarSchema = (node: unknown): boolean => {
  if (!isRecord(node)) {
    return false;
  }
  const { type } = node;
  if (typeof type === 'string') {
    return SCALAR_TYPES.has(type);
  }
  if (Array.isArray(type)) {
    return (
      type.some((name) => SCALAR_TYPES.has(name)) &&
      type.every((name) => SCALAR_TYPES.has(name) || name === 'null')
    );
  }
  return type === undefined && (Array.isArray(node['enum']) || 'const' in node);
};

// An object whose declared property values (and additionalProperties schema,
// if any) are scalars — the only object shape deepObject and the delimited
// styles define ("Allows objects with scalar properties"; "The representation
// of array or object properties is not defined", OAS 3.1.1 §4.8.12.3). A
// free-form object (no declared properties) is accepted: its values are only
// known at call time, where buildRequest rejects a nested value fail-closed.
const isScalarObjectSchema = (node: Record<string, unknown>): boolean => {
  if (node['type'] !== 'object' && !isRecord(node['properties'])) {
    return false;
  }
  const properties = isRecord(node['properties']) ? Object.values(node['properties']) : [];
  const ap = node['additionalProperties'];
  const apScalar = ap === undefined || typeof ap === 'boolean' || isScalarSchema(ap);
  return apScalar && properties.every((child) => isScalarSchema(child));
};

// Query styles beyond `form`, restricted to the cells OAS 3.1.1 §4.8.12.4
// (Style Examples) defines — every `n/a` cell omits (fail-closed):
//   - deepObject: object of scalars, explode MUST be true (explode=false is
//     n/a; the spec default for non-form styles is false, so it must be
//     declared explicitly);
//   - spaceDelimited / pipeDelimited: array of scalars or object of scalars,
//     explode=false only (explode=true is n/a).
const queryStyleProblem = (
  style: QueryStyle,
  explode: boolean,
  schema: unknown,
): string | undefined => {
  if (style === 'form') {
    return undefined;
  }
  const node = isRecord(schema) ? schema : {};
  if (style === 'deepObject') {
    if (!explode) {
      return 'deepObject requires explode: true';
    }
    return isScalarObjectSchema(node)
      ? undefined
      : 'deepObject requires an object of scalar values';
  }
  if (explode) {
    return `${style} is only defined with explode: false`;
  }
  const scalarArray = node['type'] === 'array' && isScalarSchema(node['items']);
  return scalarArray || isScalarObjectSchema(node)
    ? undefined
    : `${style} requires an array or object of scalar values`;
};

const QUERY_STYLES: ReadonlySet<unknown> = new Set([
  'form',
  'deepObject',
  'spaceDelimited',
  'pipeDelimited',
]);

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
  // Imperative on purpose (like headers.ts's mapping loop): each parameter is
  // validated — and, on failure, the WHOLE operation is omitted — in
  // encounter order, while `seenHeaders` accumulates case-insensitive
  // dedup state across iterations. A `map`/`filter` restatement would need
  // its callback to both early-return the outer function AND mutate that
  // shared dedup state, hiding both effects inside a mapping.
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
    const styleSupported =
      location === 'query' ? QUERY_STYLES.has(style) : style === STYLE_SUPPORT[location];
    if (!styleSupported) {
      return { unrepresentable: `parameter "${name}" uses the unsupported style "${style}"` };
    }
    const explode = typeof param['explode'] === 'boolean' ? param['explode'] : style === 'form';
    if (location === 'query') {
      const problem = queryStyleProblem(style as QueryStyle, explode, param['schema']);
      if (problem !== undefined) {
        return { unrepresentable: `parameter "${name}": ${problem}` };
      }
    }
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
    const mapping: FieldMapping = ((): FieldMapping => {
      switch (location) {
        case 'path': {
          return { destination: 'path', wireName: name, style: 'simple', explode, required: true };
        }
        case 'query': {
          return {
            destination: 'query',
            wireName: name,
            style: style as QueryStyle,
            explode,
            required,
          };
        }
        default: {
          return { destination: 'header', wireName: name, style: 'simple', explode, required };
        }
      }
    })();
    fields.push({ preferred: name, name, location, schema, required, mapping });
  }
  return { ok: fields };
};

export type LayoutResult = {
  inputSchema: z.ZodType;
  mapper: RequestMapper;
};

type BodyResult = {
  fields: Field[];
  mode: 'flattened' | 'single' | 'none';
  contentType?: string;
};

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

type MediaCandidate = { contentType: string; essence: string; hasParameters: boolean };
type SelectedMedia = { contentType: string; entry: Record<string, unknown> };

// Among candidates of one tier: the only one, else the only one without
// parameters (`application/json` beats `application/json; charset=utf-8`),
// else no deterministic winner.
const pickOne = (candidates: readonly MediaCandidate[]): MediaCandidate | undefined => {
  if (candidates.length === 1) {
    return candidates[0];
  }
  const bare = candidates.filter((candidate) => !candidate.hasParameters);
  return bare.length === 1 ? bare[0] : undefined;
};

const jsonTier = (json: readonly MediaCandidate[]): readonly MediaCandidate[] => {
  const exact = json.filter((candidate) => candidate.essence === 'application/json');
  if (exact.length > 0) {
    return exact;
  }
  const mergePatch = json.filter(
    (candidate) => candidate.essence === 'application/merge-patch+json',
  );
  return mergePatch.length > 0 ? mergePatch : json;
};

// Picks the request body media type deterministically (#54, decision D5):
//   1. `application/json` (any case, with or without parameters);
//   2. otherwise one `application/*+json` variant — if several are declared,
//      `application/merge-patch+json` (RFC 7396) wins: it is the
//      object-shaped patch format (Kubernetes declares json-patch+json,
//      merge-patch+json and strategic-merge-patch+json on every PATCH, all
//      with the same schema); any other tie omits — never an arbitrary pick;
//   3. otherwise `application/x-www-form-urlencoded` (exact key, as before).
// The declared key is returned verbatim; a key that is not a well-formed
// media type is never selected (see media-type.ts).
const selectMedia = (
  content: Record<string, unknown>,
): SelectedMedia | { ambiguous: string } | undefined => {
  const json: MediaCandidate[] = Object.keys(content).flatMap((contentType) => {
    const parsed = parseMediaType(contentType);
    return parsed !== undefined && isJsonEssence(parsed.essence) && isRecord(content[contentType])
      ? [{ contentType, ...parsed }]
      : [];
  });
  const tier = jsonTier(json);
  if (tier.length > 0) {
    const chosen = pickOne(tier);
    if (chosen === undefined) {
      return {
        ambiguous: `several JSON media types (${tier.map((candidate) => candidate.contentType).join(', ')})`,
      };
    }
    return {
      contentType: chosen.contentType,
      entry: content[chosen.contentType] as Record<string, unknown>,
    };
  }
  const form = content[FORM_URLENCODED];
  return isRecord(form) ? { contentType: FORM_URLENCODED, entry: form } : undefined;
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
  if ('ambiguous' in media) {
    return {
      unrepresentable: `the request body declares ${media.ambiguous} with no deterministic choice`,
    };
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
        !requiredRaw.every((name) => typeof name === 'string') ||
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
    // Imperative on purpose: any single malformed property aborts the WHOLE
    // request body (fail-closed) before later properties are even converted.
    // `properties` is spec-controlled (a hostile document can declare many
    // properties, each with a deep schema) — mapping every property through
    // convertSchema first and checking afterward would turn this
    // short-circuit into forced conversion work for every property on
    // hostile input, even past the first failure.
    for (const [prop, child] of Object.entries(properties)) {
      // A readOnly property is response-only (OAS 3.0.3 §4.7.24.2: it "SHOULD
      // NOT be sent as part of the request", and `required` on it "will take
      // effect on the response only"). It never becomes a tool input, so the
      // model is not forced to invent a server-assigned `id`, and the strict
      // input object rejects it if sent. Mirrors convertSchema's request mode
      // for nested objects. If every property is readOnly the operation is
      // kept with no body fields.
      if (isRecord(child) && child['readOnly'] === true) {
        continue;
      }
      const converted = convertSchema(child, version, 1, 'request');
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
  // Imperative on purpose: a single left-to-right character scan carrying
  // brace-depth state (`inBrace`) and the in-progress placeholder text
  // (`current`) — a streaming state machine, not an accumulation a
  // map/filter/reduce could restate without reintroducing the same mutable
  // state as its accumulator.
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
  try {
    const decoded = decodeURIComponent(segment);
    return (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('?') ||
      decoded.includes('#')
    );
  } catch {
    return true;
  }
};

// Imperative on purpose (collision resolution + dedup, like headers.ts's
// mapping loop): count by preferred name, then rename in encounter order,
// then verify the renamed set is collision-free — the three passes must run
// in this sequence before any field participates in the path/prototype
// validation below. The Field objects were just built by paramFields/
// bodyFields and are never observed by any caller before this function
// returns them, so renaming `.name` in place carries no caller-visible side
// effect; rebuilding via `.map` would be equivalent but adds an allocation
// per field on every generation run for no behavioural gain.
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
  // `flatMap` (rather than `filter().map()`) keeps the `destination === 'path'`
  // narrowing in scope for the `wireName` read below — TS does not carry a
  // `.filter` predicate's narrowing into a later `.map` on the union type.
  const pathWireNames = new Set(
    resolved.ok.flatMap((field) =>
      field.mapping.destination === 'path' ? [field.mapping.wireName] : [],
    ),
  );
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
  // Every field.name here already passed the dangerous-key gate above (via
  // field.preferred), so a plain Object.fromEntries build is safe.
  const shape: Record<string, z.ZodType> = Object.fromEntries(
    resolved.ok.map(
      (field) => [field.name, field.required ? field.schema : field.schema.optional()] as const,
    ),
  );
  const strictSchema = z.strictObject(shape);
  const group = resolved.ok.filter((field) => field.bodyGroup !== undefined);
  const requiredNames = group
    .filter((field) => field.bodyGroup?.requiredWhenPresent === true)
    .map((field) => field.name);
  // `groupNames` is computed once here, at generation time, and captured by
  // the refine closure below — NOT inside the predicate, which re-runs on
  // every tool call at request time. Kept as a named helper (not a ternary)
  // so that hot-path cost stays exactly where the original `let` version put
  // it: computed once per generated tool, not once per validated request.
  const withBodyGroupRefinement = (schema: z.ZodType): z.ZodType => {
    if (group.length === 0 || requiredNames.length === 0) {
      return schema;
    }
    const groupNames = group.map((field) => field.name);
    return schema.refine(
      (value) => {
        const record = value as Record<string, unknown>;
        const anyPresent = groupNames.some((name) => record[name] !== undefined);
        return !anyPresent || requiredNames.every((name) => record[name] !== undefined);
      },
      { message: 'provide all required body fields together, or omit the body entirely' },
    );
  };
  const inputSchema = withBodyGroupRefinement(strictSchema);
  const fields: Record<string, FieldMapping> = Object.fromEntries(
    resolved.ok.map((field) => [field.name, field.mapping] as const),
  );
  const mapper: RequestMapper = {
    bodyMode: body.ok.mode,
    ...(body.ok.contentType === undefined ? {} : { bodyContentType: body.ok.contentType }),
    fields,
  };
  return { ok: { inputSchema, mapper } };
};
