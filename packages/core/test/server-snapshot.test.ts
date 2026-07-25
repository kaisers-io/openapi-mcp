import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildSnapshot,
  buildTools,
  META_TOOL_NAME,
  SYSTEM_HEADERS,
  type BuildToolsResult,
  type DeadPattern,
  type NamedOperation,
  type SnapshotTool,
} from '../src/index.ts';

const RLO = String.fromCodePoint(0x202e); // Right-to-Left Override — never paste raw

// Task 6's build-time path-template consistency guard omits an operation
// whose `{...}` placeholders don't exactly match its path parameters — derive
// a matching required path parameter per placeholder so this fixture keeps
// building a REPRESENTABLE operation regardless of which path it is given.
const pathParams = (path: string): Record<string, unknown>[] =>
  [...path.matchAll(/\{(?<name>[^{}]+)\}/gu)].map((match) => ({
    name: match.groups?.['name'],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

const namedOp = (toolName: string, path: string): NamedOperation => ({
  toolName,
  operation: {
    method: 'get',
    path,
    tags: [],
    summary: 'A thing',
    deprecated: false,
    parameters: pathParams(path),
    responses: { '200': { content: { 'application/json': { schema: { type: 'string' } } } } },
  },
});

interface PipelineOverrides {
  spec?: {
    title?: string;
    specVersion?: string;
    omitted?: readonly { method: string; path: string; reason: string }[];
  };
  contentHash?: string;
  candidateContentHash?: string;
  displaySource?: string;
  deadPatterns?: readonly DeadPattern[];
}

// Spec.omitted defaults to [] — the normalization-level omission source
// (cookie parameters, OPTIONS/TRACE, webhooks, ...) merged alongside
// buildTools' own `built.omitted` (toolgen-level: unrepresentable schemas,
// reserved-header conflicts) into ONE meta.omittedReasons list.
const pipelineOf = (overrides: PipelineOverrides = {}) => ({
  spec: {
    title: overrides.spec?.title ?? 'Petstore',
    specVersion: overrides.spec?.specVersion ?? '1.0.0',
    omitted: overrides.spec?.omitted ?? [],
  },
  contentHash: overrides.contentHash ?? 'accepted-hash',
  ...(overrides.candidateContentHash === undefined
    ? {}
    : { candidateContentHash: overrides.candidateContentHash }),
  displaySource: overrides.displaySource ?? 'https://example.test/openapi.json',
  deadPatterns: overrides.deadPatterns ?? [],
});

describe('buildSnapshot', () => {
  it('builds an ordered tool list with the meta tool present and unique names', () => {
    const built = buildTools([namedOp('getThing', '/things/{id}')], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    const snapshot = buildSnapshot(built, pipelineOf());
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([META_TOOL_NAME, 'getThing']);
    expect(snapshot.toolsByName[META_TOOL_NAME]?.kind).toBe('meta');
    expect(snapshot.toolsByName['getThing']?.kind).toBe('upstream');
  });

  it('asserts every wire input/output schema is object-rooted', () => {
    const built = buildTools([namedOp('getThing', '/things/{id}')], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    const snapshot = buildSnapshot(built, pipelineOf());
    for (const tool of snapshot.tools) {
      expect(tool.wireTool.inputSchema['type']).toBe('object');
      if (tool.wireTool.outputSchema !== undefined) {
        expect(tool.wireTool.outputSchema['type']).toBe('object');
      }
    }
  });

  it('throws on a duplicate tool name (a generated tool colliding with the meta tool name)', () => {
    const built = buildTools([namedOp(META_TOOL_NAME, '/status')], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    expect(() => buildSnapshot(built, pipelineOf())).toThrow(/duplicate tool name/u);
  });

  it('reports ONLY the accepted content hash — a pending candidate hash never threads through', () => {
    const built: BuildToolsResult = { tools: [], omitted: [] };
    const snapshot = buildSnapshot(
      built,
      pipelineOf({ contentHash: 'accepted-123', candidateContentHash: 'candidate-deadbeef' }),
    );
    expect(snapshot.meta.acceptedContentHash).toBe('accepted-123');
    expect(JSON.stringify(snapshot.meta)).not.toContain('candidate-deadbeef');
  });

  it('is stable across a later mutation of the caller-owned buildTools/pipeline inputs', () => {
    const built = buildTools([namedOp('getThing', '/things/{id}')], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    const mutableOmitted = [...built.omitted];
    const snapshot = buildSnapshot({ tools: built.tools, omitted: mutableOmitted }, pipelineOf());
    const toolCountBefore = snapshot.tools.length;
    const omittedCountBefore = snapshot.meta.omittedCount;
    // Simulate the caller (e.g. a later `cache promote` in the SAME process,
    // which this design forbids at runtime, but the snapshot must not care)
    // mutating the arrays it handed to buildSnapshot.
    mutableOmitted.push({ method: 'POST', path: '/x', reason: 'injected after the fact' });
    expect(snapshot.tools).toHaveLength(toolCountBefore);
    expect(snapshot.meta.omittedCount).toBe(omittedCountBefore);
  });

  it('deep-freezes the whole snapshot graph — nested mutation is rejected at runtime, not only the outer tools array', () => {
    const built = buildTools([namedOp('getThing', '/things/{id}')], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    const snapshot = buildSnapshot(built, pipelineOf());
    // Cast past the `readonly` TYPE guard (a compile-time-only protection) to
    // exercise the RUNTIME guard (Object.freeze): ESM modules run in strict
    // mode, so assigning to a frozen object's property throws a TypeError —
    // it does not silently no-op.
    expect(() => {
      (snapshot.meta as { toolCount: number }).toolCount = 0;
    }).toThrow(TypeError);
    const upstreamTool = snapshot.tools[1] as SnapshotTool;
    expect(() => {
      (upstreamTool.wireTool as { name: string }).name = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (snapshot as unknown as { tools: unknown[] }).tools.push(upstreamTool);
    }).toThrow(TypeError);
    expect(snapshot.meta.toolCount).toBe(1);
    expect(upstreamTool.wireTool.name).toBe('getThing');
  });

  it('makes the toolsByName lookup itself runtime-immutable — a post-build mutation attempt never becomes routable', () => {
    const built = buildTools([namedOp('getThing', '/things/{id}')], {
      reservedHeaders: SYSTEM_HEADERS,
      openapiVersion: '3.1',
    });
    const snapshot = buildSnapshot(built, pipelineOf());
    const writable = snapshot.toolsByName as Record<string, SnapshotTool | undefined>;
    // Assembled rather than pasted as a literal, and deliberately a
    // prototype-flavored key (`__proto__`) — the most adversarial name a
    // null-prototype record can be handed, exercising the "ordinary own key,
    // no pollution hazard" claim from snapshot.ts's buildSnapshot comment.
    const evilName = ['_', '_', 'proto', '_', '_'].join('');
    const forgedTool: SnapshotTool = {
      kind: 'upstream',
      name: evilName,
      wireTool: {
        name: evilName,
        description: 'forged',
        inputSchema: { type: 'object' },
        annotations: {},
      },
      inputSchema: z.strictObject({}),
    };
    // Attempt 1: introduce a brand-new routable name. On a real `Map` this
    // `.set`-equivalent (direct property assignment) would succeed silently;
    // on the frozen null-proto record it throws (strict-mode ESM) — either
    // way, assert the OUTCOME that actually matters: no new name is routable.
    expect(() => {
      writable[evilName] = forgedTool;
    }).toThrow(TypeError);
    expect(Object.hasOwn(snapshot.toolsByName, evilName)).toBe(false);
    expect(snapshot.toolsByName[evilName]).toBeUndefined();
    // Attempt 2: replace an EXISTING entry's tool.
    const originalGetThing = snapshot.toolsByName['getThing'];
    expect(() => {
      writable['getThing'] = forgedTool;
    }).toThrow(TypeError);
    expect(snapshot.toolsByName['getThing']).toBe(originalGetThing);
    expect(snapshot.toolsByName['getThing']?.name).toBe('getThing');
  });

  it('sanitizes and caps the omission path/reason and the displaySource copied into the meta summary (hostile control/bidi text never survives)', () => {
    const hostile = `bad${RLO}order`;
    const built: BuildToolsResult = {
      tools: [],
      omitted: [
        { method: 'GET', path: `/things/${hostile}`, reason: `unrepresentable: ${hostile}` },
      ],
    };
    const snapshot = buildSnapshot(
      built,
      pipelineOf({ displaySource: `/local/${hostile}/openapi.json` }),
    );
    const [reported] = snapshot.meta.omittedReasons;
    expect(reported?.path).not.toContain(RLO);
    expect(reported?.reason).not.toContain(RLO);
    expect(snapshot.meta.displaySource).not.toContain(RLO);
    expect(reported?.path).toBe('/things/badorder');
    expect(reported?.reason).toBe('unrepresentable: badorder');
  });

  it("merges BOTH omission sources — buildTools' own omissions AND the pipeline/normalization omissions (e.g. a dropped cookie parameter) — into one list and one count", () => {
    const built: BuildToolsResult = {
      tools: [],
      omitted: [{ method: 'POST', path: '/things', reason: 'unrepresentable request body' }],
    };
    const snapshot = buildSnapshot(
      built,
      pipelineOf({
        spec: {
          omitted: [
            { method: 'GET', path: '/things/{id}', reason: 'cookie parameters are not supported' },
          ],
        },
      }),
    );
    expect(snapshot.meta.omittedCount).toBe(2);
    expect(snapshot.meta.omittedReasons.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining([
        'unrepresentable request body',
        'cookie parameters are not supported',
      ]),
    );
  });
});
