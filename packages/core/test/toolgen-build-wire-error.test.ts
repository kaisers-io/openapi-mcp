import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildTools, SYSTEM_HEADERS } from '../src/index.ts';

// A plain copy of the `z` namespace, so one call can be made to throw
vi.mock(import('zod'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, z: { ...actual.z } };
});

describe('buildTools', () => {
  it('omits an operation whose input schema cannot be written as JSON Schema', () => {
    vi.spyOn(z, 'toJSONSchema').mockImplementationOnce(() => {
      throw new Error('not representable');
    });
    const operation = {
      method: 'get' as const,
      path: '/x',
      tags: [],
      deprecated: false,
      parameters: [],
      responses: {},
    };
    const { tools, omitted } = buildTools([{ toolName: 'x', operation }], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    expect(tools).toStrictEqual([]);
    expect(omitted[0]?.reason).toBe(
      'input schema cannot be represented as JSON Schema: not representable',
    );
  });
});
