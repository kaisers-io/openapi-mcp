import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildSnapshot,
  buildTools,
  createDispatcher,
  createMetaExecutor,
  executionUnavailable,
  SYSTEM_HEADERS,
  textOutcome,
  TRUNCATION_MARKER,
  type MetaSummary,
  type NamedOperation,
  type ServerSnapshot,
  type SnapshotTool,
  type ToolExecutor,
} from '../src/index.ts';

// A real buildTools fixture: an optional flattened body with a required `id`
// and an optional `note` — the same all-or-nothing shape the M3 obligation
// (post-merge #9) and the Task 5 mandatory InMemory test both drive through
// the wire path. Here it proves validation precedes the EXECUTOR directly.
const namedOp: NamedOperation = {
  toolName: 'createThing',
  operation: {
    method: 'post',
    path: '/things',
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { id: { type: 'string' }, note: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    },
    responses: { '201': { description: 'created' } },
  },
};

const buildTestSnapshot = (): ServerSnapshot => {
  const built = buildTools([namedOp], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

const alwaysPermitLimiter = () => ({ consume: () => true });
const noSignal = new AbortController().signal;

// A nested free-form property (OpenAPI `additionalProperties: {type:
// 'string'}`) — convertSchema maps this to `z.object({...}).catchall(...)`
// (packages/core/src/toolgen/schema.ts), so an invalid VALUE under a
// caller-chosen KEY produces a Zod issue whose `path` literally contains
// that attacker-controlled key (e.g. `['metadata', '<hostile key>']`).
// Proves the "dynamic key in path" redaction concern for real, not just in
// the abstract.
const namedOpWithCatchall: NamedOperation = {
  toolName: 'setMetadata',
  operation: {
    method: 'post',
    path: '/metadata',
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              metadata: {
                type: 'object',
                properties: {},
                additionalProperties: { type: 'string' },
              },
            },
            required: ['metadata'],
          },
        },
      },
    },
    responses: { '200': { description: 'ok' } },
  },
};

// A z.enum-backed field. NOTE, corrected against pinned Zod 4.4.3's actual
// behavior (verified directly: `z.object({ status: z.enum(['open',
// 'closed']) }).safeParse({ status: '<secret>' })`): the default
// `invalid_value` message for an enum mismatch is `Invalid option: expected
// one of "open"|"closed"` — it lists only the ALLOWED values and does NOT
// embed the caller's submitted (received) value at all. So the
// `.not.toContain(secret)` assertion below is NOT, by itself, a binding
// proof that `message` is excluded from the rendered output — it would
// stay green even if `redactedValidationOutcome` appended `issue.message`
// verbatim, since that message never contained the secret in the first
// place. It is kept anyway as a documented, non-binding defense-in-depth
// check (some OTHER Zod issue code, or a future Zod version, could embed a
// received value in its default message) — the actual BINDING guard that
// `message` is excluded is the exact-output test above
// (`redacts a validation failure to the EXACT permitted output`), whose
// exact-string equality assertion breaks the instant ANY extra text
// (regardless of what it contains) is appended. See falsification (c).
const namedOpWithEnum: NamedOperation = {
  toolName: 'setStatus',
  operation: {
    method: 'post',
    path: '/status',
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['open', 'closed'] } },
            required: ['status'],
          },
        },
      },
    },
    responses: { '200': { description: 'ok' } },
  },
};

const manyRequiredStringFieldsSchema = (count: number): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let index = 0; index < count; index += 1) {
    properties[`field${index}`] = { type: 'string' };
    required.push(`field${index}`);
  }
  return { type: 'object', properties, required };
};

const namedOpWithManyFields: NamedOperation = {
  toolName: 'setManyFields',
  operation: {
    method: 'post',
    path: '/many',
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: manyRequiredStringFieldsSchema(21) } },
    },
    responses: { '200': { description: 'ok' } },
  },
};

// A single, DEEPLY nested required-string chain — isolates the FINAL
// total-length cap (MAX_RENDERED_LENGTH) from the per-issue-COUNT cap
// (MAX_ISSUE_COUNT) above: this schema produces exactly ONE Zod issue (well
// under the 20-issue cap), but that one issue's own PATH traverses
// NESTED_DEPTH levels, each rendered at the full MAX_PATH_SEGMENT_LENGTH
// (40) — long enough, by itself, to blow the 2048-code-unit budget.
// Verified directly (not just hand-computed) against pinned Zod 4.4.3 +
// this plan's actual `buildTools`/`sanitizeSpecText`/`sanitizeDisplayText`
// during planning: NESTED_DEPTH=60 produces a raw rendered length of 2497
// code units, truncated to exactly 2048 ending in TRUNCATION_MARKER.
const NESTED_DEPTH = 60;
const nestedKey = (level: number): string => `lvl${level}_${'k'.repeat(36)}`; // >40 raw chars — every level renders at the capped 40-unit length regardless of its own digit count

const buildNestedSchema = (depth: number): Record<string, unknown> => {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = depth - 1; level >= 0; level -= 1) {
    const key = nestedKey(level);
    schema = { type: 'object', properties: { [key]: schema }, required: [key] };
  }
  return schema;
};

const buildNestedValue = (depth: number, leaf: unknown): unknown => {
  let value: unknown = leaf;
  for (let level = depth - 1; level >= 0; level -= 1) {
    value = { [nestedKey(level)]: value };
  }
  return value;
};

const namedOpWithDeeplyNested: NamedOperation = {
  toolName: 'setDeepNested',
  operation: {
    method: 'post',
    path: '/deep',
    tags: [],
    deprecated: false,
    parameters: [],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: buildNestedSchema(NESTED_DEPTH) } },
    },
    responses: { '200': { description: 'ok' } },
  },
};

const buildSnapshotFor = (op: NamedOperation): ServerSnapshot => {
  const built = buildTools([op], { reservedHeaders: SYSTEM_HEADERS, openapiVersion: '3.1' });
  return buildSnapshot(built, {
    spec: { title: 't', specVersion: '1', omitted: [] },
    contentHash: 'h',
    displaySource: 's',
    deadPatterns: [],
  });
};

// A hand-built snapshot whose inputSchema uses a Zod `.default(...)` — bypasses
// `buildTools`'s JSON-Schema-to-Zod conversion entirely (that pipeline treats a JSON
// Schema `default` keyword as inert display metadata only — see
// `packages/core/src/toolgen/schema.ts`'s `KNOWN_KEYWORDS` comment "Benign metadata (no
// validation effect)" — so it never produces a Zod schema whose parsed OUTPUT differs
// from its raw INPUT). This fixture is the only way to make the "forwards the PARSED
// data" test below actually BINDING: with a raw/parsed pair that are byte-for-byte
// identical (the old fixture), the test would stay green even if the dispatcher forwarded
// `request.arguments` instead of `parsed.data` (see FIX 2 in the Task 4 security review).
const buildTransformSnapshot = (): ServerSnapshot => {
  const inputSchema = z.object({ id: z.string(), flag: z.boolean().default(true) });
  const tool: SnapshotTool = {
    kind: 'upstream',
    name: 'transformThing',
    wireTool: {
      name: 'transformThing',
      description: 'test fixture: parsed output differs from raw input via a Zod default',
      inputSchema: { type: 'object' },
      annotations: {},
    },
    inputSchema,
  };
  const toolsByName: Record<string, SnapshotTool | undefined> = Object.create(null) as Record<
    string,
    SnapshotTool | undefined
  >;
  toolsByName[tool.name] = tool;
  const meta: MetaSummary = {
    specTitle: 't',
    specVersion: '1',
    displaySource: 's',
    toolCount: 1,
    omittedCount: 0,
    omittedReasons: [],
    acceptedContentHash: 'h',
    deadPatternCount: 0,
  };
  return { tools: [tool], toolsByName, meta };
};

describe('createDispatcher', () => {
  it('routes an unknown tool name to kind:"unknown-tool" WITHOUT consuming rate', async () => {
    const consume = vi.fn<(nowMs: number) => boolean>(() => true);
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: { consume },
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({ name: 'nope', arguments: {}, signal: noSignal });
    expect(result).toEqual({ kind: 'unknown-tool', name: 'nope' });
    expect(consume).not.toHaveBeenCalled();
  });

  it('consumes rate for a KNOWN tool even when the arguments are invalid', async () => {
    const consume = vi.fn<(nowMs: number) => boolean>(() => true);
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: { consume },
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    await dispatcher.call({
      name: 'createThing',
      arguments: { note: 'partial' },
      signal: noSignal,
    });
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('returns a redacted isError result when rate is exhausted, BEFORE any validation — temporally bound: {} is a VALID body, so if validation ran first it would reach the executor instead of ever seeing the rate-exhausted message', async () => {
    const executor = vi.fn<ToolExecutor>(() =>
      Promise.resolve(textOutcome('validation ran — this proves the order bug')),
    );
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: { consume: () => false },
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({ name: 'createThing', arguments: {}, signal: noSignal });
    expect(result).toEqual({
      kind: 'outcome',
      outcome: textOutcome('rate limit exceeded — too many tool calls; retry later', true),
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('the M3/M4 mandatory obligation: an invalid partial optional-body call NEVER reaches the executor', async () => {
    const executor = vi.fn<ToolExecutor>();
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'createThing',
      arguments: { note: 'partial' },
      signal: noSignal,
    });
    expect(result.kind).toBe('outcome');
    expect(result.kind === 'outcome' && result.outcome.isError).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });

  it('redacts a safeParseAsync REJECTION (a throwing getter on the caller-supplied arguments) instead of letting it escape unhandled — the executor must never be reached', async () => {
    // `safeParseAsync` does not just RESOLVE with `{ success: false }` on a bad shape — it
    // can also REJECT outright, e.g. when reading a declared property triggers a
    // caller-controlled throwing getter/Proxy trap. A naked (non-try/catch'd)
    // `await tool.inputSchema.safeParseAsync(...)` would let that raw, unredacted error
    // (which may itself carry a secret, per the getter below) escape straight out of
    // `dispatcher.call` — see FIX 1 in the Task 4 security review.
    const executor = vi.fn<ToolExecutor>();
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
    });
    const hostileArguments: Record<string, unknown> = {};
    Object.defineProperty(hostileArguments, 'id', {
      enumerable: true,
      get(): never {
        throw new Error('SECRET-VALUE-abc');
      },
    });
    const result = await dispatcher.call({
      name: 'createThing',
      arguments: hostileArguments,
      signal: noSignal,
    });
    expect(result.kind).toBe('outcome');
    expect(result.kind === 'outcome' && result.outcome.isError).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    expect(text).not.toContain('SECRET-VALUE-abc');
  });

  it('redacts a validation failure to the EXACT permitted output — path + code only, never `message`', async () => {
    // `id` itself is the INVALID field here (not `note`, which was always
    // valid in the old fixture — a secret in an already-valid field could
    // never leak via ANY redaction bug, which is why that version of this
    // test was vacuous). An exact-equality assertion on the whole rendered
    // string is itself the proof `message` is excluded: Zod 4's own
    // `invalid_type` message text ("Invalid input: expected string, received
    // number") is NOT a substring of the expected value below, so if the
    // implementation ever concatenated `issue.message` in, this assertion
    // fails immediately regardless of which exact wording Zod uses.
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'createThing',
      arguments: { id: 123 },
      signal: noSignal,
    });
    expect(result).toEqual({
      kind: 'outcome',
      outcome: textOutcome('invalid tool arguments:\nid: invalid_type', true),
    });
  });

  it("documents that an enum mismatch's own submitted value never appears in the output either — non-binding defense-in-depth; the exact-output test above is the BINDING redaction guard", async () => {
    const secret = 'super-secret-value-should-never-leak';
    const dispatcher = createDispatcher({
      snapshot: buildSnapshotFor(namedOpWithEnum),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'setStatus',
      arguments: { status: secret },
      signal: noSignal,
    });
    expect(result).toEqual({
      kind: 'outcome',
      outcome: textOutcome('invalid tool arguments:\nstatus: invalid_value', true),
    });
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    // NOTE: pinned Zod 4.4.3's default enum-mismatch message ("Invalid
    // option: expected one of ...") never embeds the received value, so
    // this assertion would ALSO stay green if `message` were appended to
    // the rendered output — it is not, by itself, proof that `message` is
    // excluded (see the fixture comment above and falsification (c)).
    expect(text).not.toContain(secret);
  });

  it('sanitizes and caps a DYNAMIC path segment (a caller-controlled key from a catchall/additionalProperties schema)', async () => {
    const RLO = String.fromCodePoint(0x202e); // Right-to-Left Override — never paste raw
    const hostileKey = `evilKey${RLO}Name`;
    const dispatcher = createDispatcher({
      snapshot: buildSnapshotFor(namedOpWithCatchall),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'setMetadata',
      arguments: { metadata: { [hostileKey]: 123 } }, // 123 is not a string — invalid
      signal: noSignal,
    });
    expect(result.kind).toBe('outcome');
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    expect(text).not.toContain(RLO);
    expect(text).toContain('metadata.evilKeyName'); // The key survives, sanitized — it is useful diagnostic text, not a secret
  });

  it('caps a DYNAMIC path segment at 40 UTF-16 CODE UNITS — the per-SEGMENT length cap, distinct from the hostile-character stripping proven above', async () => {
    // No control/bidi characters here at all — this key is long but
    // otherwise plain, isolating the LENGTH cap (MAX_PATH_SEGMENT_LENGTH)
    // from the sanitize-stripping the RLO test above already covers; a key
    // that were BOTH long AND hostile would leave it ambiguous which
    // mechanism produced a given assertion's outcome.
    const longKey = 'x'.repeat(60);
    const dispatcher = createDispatcher({
      snapshot: buildSnapshotFor(namedOpWithCatchall),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'setMetadata',
      arguments: { metadata: { [longKey]: 123 } }, // 123 is not a string — invalid
      signal: noSignal,
    });
    expect(result.kind).toBe('outcome');
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    expect(text).not.toContain(longKey); // The full 60-char key never survives verbatim
    expect(text).toContain(TRUNCATION_MARKER); // The cap actually fired — not merely stayed under budget by chance
    // Extract the rendered segment WITHOUT anchoring a regex on end-of-line
    // immediately after the code (a fragile pattern that a message-leak
    // sabotage — see falsification (c) — would incidentally break for
    // reasons unrelated to what THIS test checks): the segment is
    // everything between "metadata." and the next ": invalid_type".
    const prefix = 'metadata.';
    const codeMarker = ': invalid_type';
    const start = text.indexOf(prefix) + prefix.length;
    const end = text.indexOf(codeMarker, start);
    expect(text.slice(start, end)).toHaveLength(40); // MAX_PATH_SEGMENT_LENGTH, exactly
  });

  it("caps the FULLY-ASSEMBLED validation message at 2048 UTF-16 CODE UNITS as a WHOLE — belt-and-suspenders even when a single issue's own path is the culprit, not the issue COUNT", async () => {
    const dispatcher = createDispatcher({
      snapshot: buildSnapshotFor(namedOpWithDeeplyNested),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      // The deepest leaf must be a string; 123 (a number) trips exactly ONE
      // invalid_type issue whose PATH traverses all NESTED_DEPTH levels —
      // well under MAX_ISSUE_COUNT (20), isolating this cap from the
      // issue-count cap the next test exercises.
      name: 'setDeepNested',
      arguments: buildNestedValue(NESTED_DEPTH, 123),
      signal: noSignal,
    });
    expect(result.kind).toBe('outcome');
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    expect(text).toHaveLength(2048); // MAX_RENDERED_LENGTH, exactly — verified directly (not hand-derived) during planning
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true); // Proves truncation actually fired
  });

  it('caps a validation failure at 20 rendered issues total, noting the remainder by count only (never a 21st line)', async () => {
    const dispatcher = createDispatcher({
      snapshot: buildSnapshotFor(namedOpWithManyFields),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const args = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`field${index}`, index]),
    );
    const result = await dispatcher.call({
      name: 'setManyFields',
      arguments: args,
      signal: noSignal,
    });
    expect(result.kind).toBe('outcome');
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    // Each of the (up to 20) rendered issue lines is asserted end-to-end —
    // `^field\d+: invalid_type$` anchors on END-of-line immediately after
    // the code — which is exactly why the overflow suffix MUST be on its
    // own separate line rather than appended to the 20th issue line: were
    // it appended there instead, this line would no longer match (trailing
    // text after "invalid_type" breaks the `$` anchor), and `renderedLines`
    // would be 19, not 20 — the baseline could never pass. See the impl
    // comment in `redactedValidationOutcome`.
    const renderedLines = (text.match(/^field\d+: invalid_type$/gmu) ?? []).length;
    expect(renderedLines).toBe(20);
    expect(text).toMatch(/^\(\+1 more\)$/mu); // The overflow note, on its OWN line
    expect(text).not.toContain('field20:');
  });

  it('forwards the PARSED data (defaults/coercions applied) to the executor, not the raw arguments', async () => {
    // `buildTransformSnapshot`'s schema has a `flag` field defaulted to `true` and ABSENT
    // from the raw call arguments below — so `parsed.data` (`{ id: 'x', flag: true }`)
    // provably DIFFERS from `request.arguments` (`{ id: 'x' }`). This is what makes the
    // assertion binding: were the production code to forward `request.arguments` instead
    // of `parsed.data`, the executor would receive `{ id: 'x' }`, which does not equal
    // `{ id: 'x', flag: true }`, and this test would fail. See falsification below.
    const executor = vi.fn<ToolExecutor>(() => Promise.resolve(textOutcome('ok')));
    const dispatcher = createDispatcher({
      snapshot: buildTransformSnapshot(),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
    });
    await dispatcher.call({ name: 'transformThing', arguments: { id: 'x' }, signal: noSignal });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[1]).toEqual({ id: 'x', flag: true });
  });

  it('redacts a throw from the lookup/rate stage itself (deps.now()) instead of letting it escape raw — the outer boundary covers dependencies with no inner try/catch of their own', async () => {
    // `deps.now()` and `deps.limiter.consume()` run BEFORE the parse and
    // executor stages, which each already have their own inner try/catch.
    // Without an OUTER boundary spanning the whole method, a throw here
    // would propagate straight out of `dispatcher.call()` unhandled, and —
    // per the dispatcher's own "any un-redacted error" invariant — could
    // carry an injected dependency's raw message (built at runtime, never
    // pasted, per the escape discipline) all the way to the client.
    const secret = `SECRET-NOW-${String(Date.now())}`;
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: alwaysPermitLimiter(),
      now: () => {
        throw new Error(secret);
      },
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'createThing',
      arguments: { id: 'x' },
      signal: noSignal,
    });
    expect(result).toEqual({
      kind: 'outcome',
      outcome: textOutcome('tool call failed unexpectedly', true),
    });
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    expect(text).not.toContain(secret);
  });

  it('redacts a throw from the rate limiter itself (deps.limiter.consume()) the same way', async () => {
    const secret = `SECRET-CONSUME-${String(Date.now())}`;
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: {
        consume: () => {
          throw new Error(secret);
        },
      },
      now: () => 0,
      executor: executionUnavailable,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'createThing',
      arguments: { id: 'x' },
      signal: noSignal,
    });
    expect(result).toEqual({
      kind: 'outcome',
      outcome: textOutcome('tool call failed unexpectedly', true),
    });
    const text = result.kind === 'outcome' ? (result.outcome.content[0]?.text ?? '') : '';
    expect(text).not.toContain(secret);
  });

  it('redacts an unexpected executor throw to a stable generic message', async () => {
    const executor = vi.fn<ToolExecutor>(() => {
      throw new Error('leaking an internal upstream secret token abc123');
    });
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'createThing',
      arguments: { id: 'x' },
      signal: noSignal,
    });
    expect(result).toEqual({
      kind: 'outcome',
      outcome: textOutcome('tool execution failed unexpectedly', true),
    });
  });

  it('routes the meta tool through metaExecutor, never through the upstream executor', async () => {
    const executor = vi.fn<ToolExecutor>();
    const dispatcher = createDispatcher({
      snapshot: buildTestSnapshot(),
      limiter: alwaysPermitLimiter(),
      now: () => 0,
      executor,
      metaExecutor: createMetaExecutor(),
    });
    const result = await dispatcher.call({
      name: 'openapi_mcp_status',
      arguments: {},
      signal: noSignal,
    });
    expect(result.kind).toBe('outcome');
    expect(result.kind === 'outcome' && result.outcome.isError).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe('executionUnavailable', () => {
  it('is a stable "execution lands in M5" isError for every upstream tool call', async () => {
    const outcome = await executionUnavailable(
      buildTestSnapshot().toolsByName['createThing']!,
      { id: 'x' },
      noSignal,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.text).toMatch(/M5/u);
  });
});
