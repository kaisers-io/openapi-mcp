// `tools/list` pagination (MCP pagination utility): an operator-chosen page
// size (`serve --tools-page-size`) and an opaque cursor. OFF by default:
// several MCP hosts call tools/list once and never follow `nextCursor`, so
// paging would silently hide every tool past the first page. The tool count
// is already bounded by the spec budget. With paging off, or with at most
// one page of tools, the answer is every tool and no `nextCursor`.
//
// The cursor encodes the next offset bound to the snapshot's accepted
// content hash, so a cursor minted for one spec cannot page through
// another; anything that does not decode to a valid position is rejected
// (the spec: an invalid cursor is an Invalid Params error).

const HASH_PREFIX_LENGTH = 16;

const encodeCursor = (hash: string, offset: number): string =>
  Buffer.from(`${hash.slice(0, HASH_PREFIX_LENGTH)}:${String(offset)}`, 'utf8').toString(
    'base64url',
  );

const decodeCursor = (cursor: string, hash: string, total: number): number | undefined => {
  if (!/^[\w-]{1,128}$/u.test(cursor)) {
    return undefined;
  }
  const [prefix, rawOffset] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (prefix !== hash.slice(0, HASH_PREFIX_LENGTH) || rawOffset === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(rawOffset)) {
    return undefined;
  }
  const offset = Number(rawOffset);
  return offset < total ? offset : undefined;
};

export type ToolPage<T> = { tools: readonly T[]; nextCursor?: string } | { invalidCursor: true };

export const pageTools = <T>(
  tools: readonly T[],
  cursor: string | undefined,
  contentHash: string,
  // Omitted = no paging (every tool in one response).
  pageSize?: number,
): ToolPage<T> => {
  const offset = cursor === undefined ? 0 : decodeCursor(cursor, contentHash, tools.length);
  if (offset === undefined) {
    return { invalidCursor: true };
  }
  const end = pageSize === undefined ? tools.length : offset + pageSize;
  return {
    tools: tools.slice(offset, end),
    ...(end < tools.length ? { nextCursor: encodeCursor(contentHash, end) } : {}),
  };
};

// Issue #49: from MCP revision 2025-11-25 on, a schema without `$schema` is
// JSON Schema 2020-12, so the keyword on every listed input and output schema
// says nothing a client does not already assume (3% of the DigitalOcean list,
// more for small tools). An earlier revision defines no default dialect and
// keeps it. Only the 2020-12 value is dropped; revisions are dates, so they
// compare as strings.
const DEFAULT_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const DEFAULT_DIALECT_SINCE = '2025-11-25';

export const hasDefaultDialect = (protocolVersion?: string): boolean =>
  protocolVersion !== undefined && protocolVersion >= DEFAULT_DIALECT_SINCE;

export const withoutDefaultDialect = (schema: unknown): unknown => {
  if (schema === null || typeof schema !== 'object' || !('$schema' in schema)) {
    return schema;
  }
  const { $schema: dialect, ...rest } = schema as Record<string, unknown>;
  return dialect === DEFAULT_DIALECT ? rest : schema;
};

export const listedTool = <T extends { inputSchema: unknown; outputSchema?: unknown }>(
  tool: T,
): T => ({
  ...tool,
  inputSchema: withoutDefaultDialect(tool.inputSchema),
  ...(tool.outputSchema === undefined
    ? {}
    : { outputSchema: withoutDefaultDialect(tool.outputSchema) }),
});
