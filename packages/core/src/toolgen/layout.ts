import type { z } from 'zod';
import { SPEC_BUDGETS } from '../spec/budgets.ts';
import type { OperationRecord } from '../spec/normalize.ts';
import { sanitizeSpecText } from '../spec/sanitize.ts';
import type { OpenapiVersion } from '../spec/validate.ts';
import { convertSchema } from './schema.ts';

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
    // keep or drop it (owner decision, round-15): the tool boundary is fully
    // fail-closed, so a malformed/unsupported reserved-header param omits the
    // operation rather than being silently discarded. allowReserved/content/style
    // and the schema conversion run first; the reserved-header drop comes after.
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
