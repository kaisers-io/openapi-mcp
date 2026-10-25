import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  applyOutputSchemaOptOut,
  assignToolNames,
  buildTools,
  normalizeSpec,
  notExposedCounts,
  notExposedOperations,
  notExposedSummary,
  parseFilterPattern,
  publicOmission,
} from '../src/index.ts';
import type { FilterPattern } from '../src/index.ts';

// Issue #41: every operation of a spec is either a tool or reported with the
// one reason it is not. An invented shop API.

const ok = { '200': { description: 'ok' } };
const SHOP = {
  openapi: '3.2.0',
  info: { title: 'Shop', version: '1' },
  paths: {
    '/orders': {
      get: { operationId: 'listOrders', tags: ['Orders'], responses: ok },
      post: { operationId: 'createOrder', tags: ['Orders'], responses: ok },
    },
    '/orders/{id}': {
      delete: { operationId: 'deleteOrder', tags: ['Orders'], responses: ok },
    },
    // No operationId: a bare pattern, an operationId glob, never selects it
    '/reports': { get: { tags: ['Reports'], responses: ok } },
    '/customers': {
      get: {
        operationId: 'listCustomers',
        tags: ['Customers'],
        parameters: [{ name: 'session', in: 'cookie', schema: { type: 'string' } }],
        responses: ok,
      },
    },
    '/search': {
      servers: [{ url: 'https://search.example.test' }],
      additionalOperations: {
        SEARCH: { operationId: 'searchOrders', tags: ['Orders'], responses: ok },
      },
    },
  },
};

const patterns = (...raw: readonly string[]): FilterPattern[] =>
  raw.map((one) => parseFilterPattern(one));

const decide = (allow: readonly string[], deny: readonly string[]) => {
  const spec = normalizeSpec(SHOP, '3.2');
  const filtered = applyFilters(
    assignToolNames(spec.operations),
    patterns(...allow),
    patterns(...deny),
    undefined,
    spec.omitted,
  );
  return { spec, filtered };
};

const summaryOf = (operation: { method: string; path: string; decision: string }): string =>
  `${operation.method} ${operation.path} ${operation.decision}`;

describe('not-exposed inventory', () => {
  it('gives every filtered operation its decision, the deny pattern included', () => {
    const { filtered } = decide(['**'], ['DELETE /**']);
    expect(filtered.exposed.map((named) => named.toolName)).toEqual(['listOrders', 'createOrder']);
    expect(filtered.filteredOut).toEqual([
      {
        method: 'DELETE',
        path: '/orders/{id}',
        operationId: 'deleteOrder',
        toolName: 'deleteOrder',
        tags: ['Orders'],
        decision: 'denied',
        pattern: 'DELETE /**',
        reason: 'excluded by --deny "DELETE /**"',
      },
      {
        // Item 1 of the issue: no operationId, so `**` does not select it
        method: 'GET',
        path: '/reports',
        toolName: 'get_reports',
        tags: ['Reports'],
        decision: 'not-allowed',
        reason: 'matched by no --allow pattern',
      },
    ]);
  });

  it('reports what the read-only default leaves out', () => {
    const { filtered } = decide([], []);
    expect(filtered.filteredOut.map((operation) => summaryOf(operation))).toEqual([
      'POST /orders read-only-default',
      'DELETE /orders/{id} read-only-default',
    ]);
  });

  it('merges omitted and withheld operations, counts them and keeps omissions public', () => {
    const { spec, filtered } = decide([], []);
    const inventory = notExposedOperations(
      {
        spec,
        filteredOut: filtered.filteredOut,
        withheldOperations: [{ method: 'get', path: '/orders', reason: 'withheld' }],
      },
      [{ method: 'GET', path: '/reports', reason: 'unrepresentable', toolName: 'get_reports' }],
    );
    expect(inventory.map((operation) => summaryOf(operation))).toEqual([
      'POST /orders read-only-default',
      'DELETE /orders/{id} read-only-default',
      'GET /customers omitted',
      'SEARCH /search omitted',
      'GET /reports omitted',
      'GET /orders withheld',
    ]);
    // The omission keeps its provenance in the inventory
    expect(inventory[2]).toMatchObject({
      operationId: 'listCustomers',
      tags: ['Customers'],
      reason: 'cookie parameters are not supported',
    });
    const counts = notExposedCounts(inventory);
    expect(counts).toEqual({
      denied: 0,
      'not-allowed': 0,
      'read-only-default': 2,
      omitted: 3,
      withheld: 1,
    });
    expect(notExposedSummary(counts)).toBe(
      'operations not exposed: 2 left out by the read-only default, 3 omitted as not supported, 1 withheld for a pending candidate; every one with its reason: openapi-mcp --json tools with the same options',
    );
    expect(notExposedSummary(notExposedCounts([]))).toBeUndefined();
    expect(publicOmission(spec.omitted[0]!)).toEqual({
      method: 'GET',
      path: '/customers',
      reason: 'cookie parameters are not supported',
    });
  });
});

describe('dead patterns that name an omitted operation', () => {
  // Item 4 of the issue: the suggestion used to point at another operation
  it('says so instead of suggesting a different operation, by operationId or tag', () => {
    const { filtered } = decide(['listCustomers', 'tag:Customers'], ['searchOrders']);
    expect(filtered.deadPatterns).toEqual([
      { raw: 'listCustomers', flag: 'allow', notExposed: true },
      { raw: 'tag:Customers', flag: 'allow', notExposed: true },
      { raw: 'searchOrders', flag: 'deny', notExposed: true },
    ]);
  });

  it('keeps the suggestion for a pattern that names nothing', () => {
    const { filtered } = decide(['listOrdrs'], []);
    expect(filtered.deadPatterns).toEqual([
      { raw: 'listOrdrs', flag: 'allow', suggestion: 'listOrders' },
    ]);
  });

  // Item 5 of the issue: SEARCH is declared, by an omitted operation
  it('accepts a method only an omitted operation declares', () => {
    const { filtered } = decide([], ['SEARCH /search']);
    expect(filtered.deadPatterns).toEqual([
      { raw: 'SEARCH /search', flag: 'deny', notExposed: true },
    ]);
    expect(() => decide([], ['PURGE /search'])).toThrow(
      'names PURGE, which is not a standard method and no operation in the spec declares',
    );
  });
});

// Review of #41: an OpenAPI 3.2 method that is not upper case is omitted,
// and keeps its operationId and tags for diagnostics, though no method
describe('an omitted method that is not upper case', () => {
  const document = {
    openapi: '3.2.0',
    info: { title: 'Shop', version: '1' },
    paths: {
      '/lookup': {
        get: { operationId: 'lookupItem', tags: ['Lookups'], responses: ok },
        additionalOperations: {
          search: { operationId: 'lookupItems', tags: ['Lookup'], responses: ok },
        },
      },
    },
  };

  it('is named by operationId or tag for every pattern flag', () => {
    const spec = normalizeSpec(document, '3.2');
    expect(spec.omitted.map((omission) => omission.method)).toEqual(['search']);
    const named = assignToolNames(spec.operations);
    const filtered = applyFilters(
      named,
      patterns('lookupItems'),
      patterns('tag:Lookup'),
      undefined,
      spec.omitted,
    );
    expect(filtered.deadPatterns).toEqual([
      { raw: 'lookupItems', flag: 'allow', notExposed: true },
      { raw: 'tag:Lookup', flag: 'deny', notExposed: true },
    ]);
    const tools = buildTools(named, { reservedHeaders: new Set(), openapiVersion: '3.2' });
    expect(
      applyOutputSchemaOptOut(tools.tools, patterns('lookupItems'), spec).deadPatterns,
    ).toEqual([{ raw: 'lookupItems', flag: 'omit-output-schema', notExposed: true }]);
    // It declares no method a `METHOD /path` pattern could name
    expect(() =>
      applyFilters(named, [], patterns('SEARCH /lookup'), undefined, spec.omitted),
    ).toThrow('names SEARCH, which is not a standard method');
  });
});
