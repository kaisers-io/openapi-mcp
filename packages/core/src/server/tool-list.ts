// `tools/list` pagination (MCP pagination utility): a fixed page size and
// an opaque cursor. A server with at most one page of tools answers exactly
// as before — every tool, no `nextCursor` — so small specs see no change.
//
// The cursor encodes the next offset bound to the snapshot's accepted
// content hash, so a cursor minted for one spec cannot page through
// another; anything that does not decode to a valid position is rejected
// (the spec: an invalid cursor is an Invalid Params error).

export const TOOLS_PAGE_SIZE = 100;

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
  pageSize = TOOLS_PAGE_SIZE,
): ToolPage<T> => {
  const offset = cursor === undefined ? 0 : decodeCursor(cursor, contentHash, tools.length);
  if (offset === undefined) {
    return { invalidCursor: true };
  }
  const end = offset + pageSize;
  return {
    tools: tools.slice(offset, end),
    ...(end < tools.length ? { nextCursor: encodeCursor(contentHash, end) } : {}),
  };
};
