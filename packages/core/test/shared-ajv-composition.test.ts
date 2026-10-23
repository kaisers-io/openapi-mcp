import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  buildTools,
  compileEnvelopeValidator,
  createEnvelopeCompiler,
  SYSTEM_HEADERS,
} from '../src/index.ts';
import type { EnvelopeValidator, NamedOperation } from '../src/index.ts';

// One shared Ajv context per snapshot (issue #42) must give every tool the
// same verdicts as a context of its own, for the output schemas the other
// stacks generate: default responses under --default-response-is-error
// (#117), the projection branch (#136), the inclusive response oneOf (#102)
// and an output schema withheld for an unsafe pattern (#39). The schema
// objects are shared between tools, as the dereferencer hands them out.

const pet: Record<string, unknown> = {
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id'],
};

const json = (schema: Record<string, unknown>) => ({
  description: 'ok',
  content: { 'application/json': { schema } },
});

const op = (toolName: string, responses: Record<string, unknown>): NamedOperation => ({
  toolName,
  operation: {
    method: 'get',
    path: `/${toolName}`,
    tags: [],
    deprecated: false,
    parameters: [],
    responses,
  },
});

const operations: NamedOperation[] = [
  // #117: only the documented 2xx form the schema under the option
  op('getPetOrDefault', { '200': json(pet), default: { description: 'error' } }),
  // The same schema object in a second tool
  op('getPet', { '200': json(pet), '201': json(pet) }),
  // #102: overlapping branches, so response mode must accept a value both match
  op('getEither', {
    '200': json({
      oneOf: [
        { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      ],
    }),
  }),
  // #39: nested quantifiers withhold the output schema
  op('getUnsafe', { '200': json({ type: 'string', pattern: '^(a+)+$' }) }),
];

const snapshot = buildSnapshot(
  buildTools(operations, {
    reservedHeaders: SYSTEM_HEADERS,
    openapiVersion: '3.1',
    defaultResponseIsError: true,
    projection: true,
  }),
  {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  },
);

const envelope = (status: number, rest: Record<string, unknown>) => ({
  status,
  contentType: 'application/json',
  ...rest,
});

const samples = [
  envelope(200, { data: { id: 1 } }),
  envelope(200, { data: { id: 1, name: 'x' } }),
  envelope(200, { data: { name: 'x' } }),
  envelope(200, { data: { id: 'x' } }),
  envelope(201, { data: { id: 1 } }),
  envelope(202, { data: { id: 1 } }),
  envelope(200, { projection: { '/id': 1 } }),
  envelope(200, { data: 'aaa' }),
  { status: 200 },
];

describe('shared envelope compiler × generated output schemas', () => {
  const compile = createEnvelopeCompiler();
  const shared = new Map(
    snapshot.operations.map((tool) => [tool.name, compile(tool.wireTool.outputSchema)]),
  );

  it('gives every tool the same verdicts as a fresh context per tool', () => {
    for (const tool of snapshot.operations) {
      const fresh = compileEnvelopeValidator(tool.wireTool.outputSchema);
      const mine = shared.get(tool.name);
      expect(mine === undefined).toBe(fresh === undefined);
      for (const sample of samples) {
        expect(mine?.(sample)).toBe(fresh?.(sample));
      }
    }
  });

  const verdicts = (name: string): boolean[] => {
    const validate = shared.get(name) as EnvelopeValidator;
    return samples.map((sample) => validate(sample));
  };

  it('validates the documented 2xx of a default-response tool and the projection branch', () => {
    expect(verdicts('getPetOrDefault')).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(verdicts('getPet')).toEqual([true, true, false, false, true, false, true, false, false]);
  });

  it('accepts a value that matches both branches of a response oneOf', () => {
    expect(verdicts('getEither')).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it('has no validator for a tool whose output schema was withheld', () => {
    expect(snapshot.operations.find((tool) => tool.name === 'getUnsafe')).toBeDefined();
    expect(shared.get('getUnsafe')).toBeUndefined();
  });
});
