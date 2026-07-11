import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TOOL_NAME_MAX_LENGTH,
  assignToolNames,
  type HttpMethod,
  type OperationRecord,
} from '../src/index.ts';

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
    expect(assignToolNames([record('get', '/pets', 'list pets!')])[0]?.toolName).toBe('list_pets_');
  });

  it('caps long operationIds at the maximum length', () => {
    const name = assignToolNames([record('get', '/pets', 'x'.repeat(100))])[0]?.toolName;
    expect(name).toBe('x'.repeat(TOOL_NAME_MAX_LENGTH));
  });

  it('falls back to method_path for a missing operationId', () => {
    expect(assignToolNames([record('get', '/users/{id}')])[0]?.toolName).toBe('get_users_by_id');
  });

  it('falls back to method_path when the operationId sanitizes to nothing', () => {
    // Sanitizing '###' yields '___'; only characters outside the charset become
    // underscores, so an all-underscore result never occurs from real input.
    // An empty operationId is dropped by normalize; the empty-string branch
    // guards direct core consumers.
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
    expect(new Set(colliding.map((entry) => entry.toolName)).size).toBe(2);
    expect(colliding[0]?.toolName).toBe(`get_users_by_id_${suffix('POST', '/x', 8)}`);
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
