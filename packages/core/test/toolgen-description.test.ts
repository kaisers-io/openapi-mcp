import { describe, expect, it } from 'vitest';
import { buildTools, composeDescription, SYSTEM_HEADERS } from '../src/index.ts';
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
          '404': { description: 'no such thing id' },
          '500': { description: 'storage quota reached' },
        },
      }),
    );
    expect(text).toBe('Create Errors: 404: no such thing id; 500: storage quota reached');
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

  it('leaves out a documented error with no description text', () => {
    const text = composeDescription(
      op({ summary: 'Create', responses: { '404': {}, '500': { description: 123 } } }),
    );
    expect(text).toBe('Create');
  });

  // Issue #49: an entry that only restates its status costs tokens on every
  // operation and tells the agent nothing the status does not
  it('leaves out errors that only restate their status, and keeps specific ones', () => {
    const text = composeDescription(
      op({
        summary: 'Create',
        responses: {
          '401': { description: 'Unauthorized' },
          '404': { description: 'The resource was not found.' },
          '409': { description: 'Conflict' },
          '422': { description: 'Validation failed, or the endpoint has been spammed.' },
          '429': { description: 'API Rate limit exceeded' },
          '500': { description: 'Server error.' },
          '503': { description: 'Service unavailable' },
        },
      }),
    );
    expect(text).toBe('Create Errors: 422: Validation failed, or the endpoint has been spammed.');
    expect(
      composeDescription(
        op({ summary: 'Create', responses: { '422': { description: 'Limit Reached' } } }),
      ),
    ).toBe('Create Errors: 422: Limit Reached');
    // Review of #49: a number, a word in another script, a word another
    // status would own, or an unlisted status is information
    expect(
      composeDescription(
        op({
          summary: 'Create',
          responses: {
            '413': { description: 'Payload exceeded 1048576' },
            '429': { description: 'Rate limit: 100 requests' },
            '404': { description: '見つかりません' },
            '409': { description: 'Resource authentication required' },
            '418': { description: 'Error' },
          },
        }),
      ),
    ).toBe(
      'Create Errors: 404: 見つかりません; 409: Resource authentication required; 413: Payload exceeded 1048576; 418: Error; 429: Rate limit: 100 requests',
    );
  });
});

// Review of #49: what reaches the client keeps code examples whole, in the
// tool description and in a body property's description; a text without
// code keeps only the text of its links
describe('markdown links in built tools', () => {
  it('leaves a text with code whole and shortens links elsewhere', () => {
    const example = 'send `[label](https://example.test)` to render a link';
    const summary = `Create a note. For link rendering, ${example}. See [docs](https://docs.example.test).`;
    const { tools } = buildTools(
      [
        {
          toolName: 'createNote',
          operation: {
            method: 'post',
            path: '/notes',
            tags: [],
            deprecated: false,
            summary,
            parameters: [],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      body: { type: 'string', description: `Markdown; ${example}.` },
                      title: {
                        type: 'string',
                        description: 'Shown in [lists](https://docs.example.test/lists).',
                      },
                    },
                  },
                },
              },
            },
            responses: { '204': { description: 'created' } },
          },
        },
      ],
      { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' },
    );
    const [tool] = tools;
    expect(tool?.description).toBe(summary);
    const wire = JSON.stringify(tool?.wireSchema);
    expect(wire).toContain(`Markdown; ${example}.`);
    expect(wire).toContain('"Shown in lists."');
  });
});
