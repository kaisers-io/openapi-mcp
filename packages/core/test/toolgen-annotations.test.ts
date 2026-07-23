import { describe, expect, it } from 'vitest';
import { deriveAnnotations } from '../src/index.ts';

describe('deriveAnnotations — the §6.5 HTTP-method heuristic', () => {
  it('marks GET/HEAD read-only and open-world, omitting idempotentHint and destructiveHint', () => {
    for (const method of ['get', 'head'] as const) {
      expect(deriveAnnotations(method)).toEqual({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it('marks PUT/DELETE destructive, idempotent, and open-world', () => {
    for (const method of ['put', 'delete'] as const) {
      expect(deriveAnnotations(method)).toEqual({
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it('marks POST/PATCH destructive and open-world, without idempotentHint', () => {
    for (const method of ['post', 'patch'] as const) {
      expect(deriveAnnotations(method)).toEqual({ destructiveHint: true, openWorldHint: true });
    }
  });

  it('never sets readOnlyHint true for a non-GET/HEAD method', () => {
    for (const method of ['put', 'post', 'delete', 'patch'] as const) {
      expect(deriveAnnotations(method).readOnlyHint).toBeUndefined();
    }
  });
});
