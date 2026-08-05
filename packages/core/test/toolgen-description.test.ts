import { describe, expect, it } from 'vitest';
import { composeDescription } from '../src/index.ts';
import type { OperationRecord } from '../src/index.ts';

const RLO = String.fromCodePoint(0x20_2e); // Right-to-Left Override — never paste raw

const op = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  method: 'get',
  path: '/things/{id}',
  tags: [],
  deprecated: false,
  parameters: [],
  responses: {},
  ...overrides,
});

describe('composeDescription', () => {
  it('joins summary and description', () => {
    const text = composeDescription(
      op({ summary: 'List things', description: 'Returns all things.' }),
    );
    expect(text).toBe('List things Returns all things.');
  });

  it('does not duplicate an identical summary and description', () => {
    const text = composeDescription(op({ summary: 'Same', description: 'Same' }));
    expect(text).toBe('Same');
  });

  it('prefixes [DEPRECATED] for a deprecated operation', () => {
    const text = composeDescription(op({ summary: 'Old op', deprecated: true }));
    expect(text.startsWith('[DEPRECATED] ')).toBe(true);
  });

  it('folds documented 4xx/5xx responses into a compact error list, in ascending order', () => {
    const text = composeDescription(
      op({
        summary: 'Create',
        responses: {
          '201': { description: 'created' },
          '404': { description: 'not found' },
          '500': { description: 'server error' },
        },
      }),
    );
    expect(text).toBe('Create Errors: 404: not found; 500: server error');
  });

  it('does not leave a trailing space when a deprecated operation has no summary, description, or documented errors', () => {
    expect(composeDescription(op({ deprecated: true }))).toBe('[DEPRECATED]');
  });

  it('keeps the deprecated-prefixed description within the 4096-char budget, prefix included', () => {
    const longSummary = 'x'.repeat(5000);
    const text = composeDescription(op({ summary: longSummary, deprecated: true }));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.startsWith('[DEPRECATED] ')).toBe(true);
  });

  it('ignores non-error and non-numeric response keys (e.g. "default", "2XX")', () => {
    const text = composeDescription(
      op({
        summary: 'Create',
        responses: {
          '201': { description: 'created' },
          default: { description: 'oops' },
          '2XX': {},
        },
      }),
    );
    expect(text).toBe('Create');
  });

  it('sanitizes a hostile response description (control/bidi stripped) before it reaches the tool description', () => {
    const hostile = `bad${RLO}order`;
    const text = composeDescription(
      op({ summary: 'x', responses: { '400': { description: hostile } } }),
    );
    expect(text).not.toContain(RLO);
    expect(text).toBe('x Errors: 400: badorder');
  });

  it('returns an empty string for an operation with no summary, description, or documented errors', () => {
    expect(composeDescription(op())).toBe('');
  });

  it('falls back to the bare status code for a documented error with no description text', () => {
    const text = composeDescription(
      op({ summary: 'Create', responses: { '404': {}, '500': { description: 123 } } }),
    );
    expect(text).toBe('Create Errors: 404; 500');
  });
});
