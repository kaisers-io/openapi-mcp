import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOOL_NAME_MAX_LENGTH, assignToolNames } from '../src/index.ts';
import type { HttpMethod, OperationRecord } from '../src/index.ts';

const record = (method: HttpMethod, path: string, operationId?: string): OperationRecord => ({
  method,
  path,
  ...(operationId === undefined ? {} : { operationId }),
  tags: [],
  deprecated: false,
  parameters: [],
  responses: {},
});

const suffix = (method: string, path: string, length: number): string =>
  createHash('sha256').update(`${method.toUpperCase()} ${path}`).digest('hex').slice(0, length);

describe('assignToolNames — bases', () => {
  it('keeps a clean operationId as the tool name', () => {
    expect(assignToolNames([record('get', '/pets', 'listPets')])[0]?.toolName).toBe('listPets');
  });

  it('sanitizes invalid characters to underscores', () => {
    expect(assignToolNames([record('get', '/pets', 'list pets!now')])[0]?.toolName).toBe(
      'list_pets_now',
    );
  });

  it('caps long operationIds at the maximum length', () => {
    const name = assignToolNames([record('get', '/pets', 'x'.repeat(100))])[0]?.toolName;
    expect(name).toBe('x'.repeat(TOOL_NAME_MAX_LENGTH));
  });

  it('falls back to method_path for a missing operationId', () => {
    expect(assignToolNames([record('get', '/users/{id}')])[0]?.toolName).toBe('get_users_by_id');
  });

  it('falls back to method_path when the operationId sanitizes to nothing', () => {
    // '###' has no character inside the charset, so nothing meaningful is
    // left. An empty operationId is dropped by normalize; the record without
    // one guards direct core consumers.
    expect(assignToolNames([record('post', '/pets', '###')])[0]?.toolName).toBe('post_pets');
    expect(assignToolNames([record('post', '/pets')])[0]?.toolName).toBe('post_pets');
  });

  it('lowercases the method_path fallback', () => {
    expect(assignToolNames([record('get', '/Users/{userId}')])[0]?.toolName).toBe(
      'get_users_by_userid',
    );
  });

  it('names the root path after the method alone', () => {
    expect(assignToolNames([record('get', '/')])[0]?.toolName).toBe('get');
  });
});

describe('assignToolNames — collisions', () => {
  it('suffixes colliding names with a stable content hash', () => {
    const named = assignToolNames([record('get', '/a', 'dup'), record('get', '/b', 'dup')]);
    expect(named.map((entry) => entry.toolName)).toEqual([
      `dup_${suffix('GET', '/a', 8)}`,
      `dup_${suffix('GET', '/b', 8)}`,
    ]);
  });

  it('produces identical names regardless of input order', () => {
    const forward = assignToolNames([record('get', '/a', 'dup'), record('get', '/b', 'dup')]);
    const reversed = assignToolNames([record('get', '/b', 'dup'), record('get', '/a', 'dup')]);
    expect(forward.map((entry) => entry.toolName).toSorted()).toEqual(
      reversed.map((entry) => entry.toolName).toSorted(),
    );
  });

  it('resolves collisions between operationIds and fallback names', () => {
    const named = assignToolNames([
      record('get', '/users/{id}', 'get_users_by_id'),
      record('get', '/users/{id2}'),
    ]);
    // Second op falls back to get_users_by_id2 — no collision here
    expect(named[1]?.toolName).toBe('get_users_by_id2');
    const colliding = assignToolNames([
      record('post', '/x', 'get_users_by_id'),
      record('get', '/users/{id}'),
    ]);
    // The operationId is a valid name as written, so it keeps it; the
    // derived method+path name is the one suffixed
    expect(colliding.map((entry) => entry.toolName)).toEqual([
      'get_users_by_id',
      `get_users_by_id_${suffix('GET', '/users/{id}', 8)}`,
    ]);
  });

  it('keeps an already-valid operationId when a sanitized one lands on it (repos.get + repos_get)', () => {
    const named = assignToolNames([
      record('get', '/a', 'repos.get'),
      record('get', '/b', 'repos_get'),
    ]);
    expect(named.map((entry) => entry.toolName)).toEqual([
      `repos_get_${suffix('GET', '/a', 8)}`,
      'repos_get',
    ]);
    // Order-independent
    const reversed = assignToolNames([
      record('get', '/b', 'repos_get'),
      record('get', '/a', 'repos.get'),
    ]);
    expect(reversed.map((entry) => entry.toolName)).toEqual([
      'repos_get',
      `repos_get_${suffix('GET', '/a', 8)}`,
    ]);
  });

  it('still suffixes every entry when two operationIds are identical as written', () => {
    const named = assignToolNames([
      record('get', '/a', 'dup'),
      record('get', '/b', 'dup'),
      record('get', '/c', 'dup!'),
    ]);
    expect(named.map((entry) => entry.toolName)).toEqual([
      `dup_${suffix('GET', '/a', 8)}`,
      `dup_${suffix('GET', '/b', 8)}`,
      `dup_${suffix('GET', '/c', 8)}`,
    ]);
  });

  it('defuses an operationId that mimics a suffixed name with a longer suffix', () => {
    const mimic = `dup_${suffix('GET', '/a', 8)}`;
    const named = assignToolNames([
      record('get', '/a', 'dup'),
      record('get', '/b', 'dup'),
      record('get', '/c', mimic),
    ]);
    const names = named.map((entry) => entry.toolName);
    expect(new Set(names).size).toBe(3);
  });

  it('keeps suffixed names within the maximum length', () => {
    const long = 'z'.repeat(100);
    const named = assignToolNames([record('get', '/a', long), record('get', '/b', long)]);
    for (const entry of named) {
      expect(entry.toolName.length).toBeLessThanOrEqual(TOOL_NAME_MAX_LENGTH);
    }
    expect(new Set(named.map((entry) => entry.toolName)).size).toBe(2);
  });
});

describe('assignToolNames — non-ASCII, mixed segments and the provider charset (issue #67)', () => {
  const nameOf = (method: HttpMethod, path: string, operationId?: string): string | undefined =>
    assignToolNames([record(method, path, operationId)])[0]?.toolName;

  it('strips diacritics instead of turning each accented letter into an underscore', () => {
    expect(nameOf('get', '/x', 'Ünïcödé')).toBe('Unicode');
    expect(nameOf('get', '/x', 'créerUtilisateur')).toBe('creerUtilisateur');
  });

  it('transliterates Latin letters that NFKD does not decompose instead of dropping them', () => {
    expect(nameOf('get', '/x', 'Øresund.søk')).toBe('Oresund_sok');
    expect(nameOf('get', '/x', 'łódź')).toBe('lodz');
    expect(nameOf('get', '/x', 'Straße')).toBe('Strasse');
    expect(nameOf('get', '/x', 'GROẞ')).toBe('GROSS');
    expect(nameOf('get', '/x', 'Łaskaæœ')).toBe('Laskaaeoe');
    expect(nameOf('get', '/x', 'ÆsirŒuvre')).toBe('AesirOeuvre');
    expect(nameOf('get', '/x', 'đĐ')).toBe('dD');
    expect(nameOf('get', '/x', 'Þórþ')).toBe('Thorth');
    // In paths too (the method+path fallback)
    expect(nameOf('get', '/straße/{łid}')).toBe('get_strasse_by_lid');
  });

  it('folds compatibility forms (full-width letters) to ASCII', () => {
    expect(nameOf('get', '/x', 'ｇｅｔＵｓｅｒ')).toBe('getUser');
  });

  it('falls back to method_path when an operationId has no ASCII letter or digit left (CJK)', () => {
    expect(nameOf('get', '/a', 'ユーザー取得')).toBe('get_a');
    expect(nameOf('get', '/users/{id}', '获取用户')).toBe('get_users_by_id');
  });

  it('collapses a run of replaced characters into one underscore and trims them at the ends', () => {
    expect(nameOf('get', '/x', '  list   pets!! ')).toBe('list_pets');
    expect(nameOf('get', '/x', 'list pets!')).toBe('list_pets');
  });

  it('keeps underscores the spec author wrote', () => {
    expect(nameOf('get', '/x', '__internal__list')).toBe('__internal__list');
  });

  it('maps dots to underscores: OpenAI and Anthropic tool names allow only [A-Za-z0-9_-]', () => {
    expect(nameOf('get', '/x', 'repos.get')).toBe('repos_get');
    expect(nameOf('get', '/x', 'v1.users.list')).toBe('v1_users_list');
  });

  it('names a segment that mixes a placeholder with static text', () => {
    expect(nameOf('get', '/users/{id}.json')).toBe('get_users_by_id_json');
    expect(nameOf('get', '/files/{name}.{ext}')).toBe('get_files_by_name_by_ext');
    expect(nameOf('get', '/v1.2/items')).toBe('get_v1_2_items');
  });

  it('keeps names unique, stable and within the length cap after transliteration', () => {
    const named = assignToolNames([
      record('get', '/a', 'Ünïcödé'),
      record('get', '/b', 'Unicode'),
      record('get', '/c', 'é'.repeat(80)),
    ]);
    expect(named.map((entry) => entry.toolName)).toEqual([
      `Unicode_${suffix('GET', '/a', 8)}`,
      // Valid as written: keeps its name, the transliterated one is suffixed
      'Unicode',
      'e'.repeat(TOOL_NAME_MAX_LENGTH),
    ]);
    for (const entry of named) {
      expect(entry.toolName).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
    }
  });
});
