import { describe, expect, it } from 'vitest';
import {
  compileEnvelopeValidator,
  createRedactor,
  mapResponse,
  TRUNCATION_MARKER,
} from '../src/index.ts';
import type {
  EnvelopeValidator,
  MapResponseOptions,
  PinnedErrorReason,
  PinnedOutcome,
  Redactor,
  ToolCallOutcome,
} from '../src/index.ts';

const encoder = new TextEncoder();

// Mirrors toolgen/output-schema.ts's generated oneOf shape closely enough to
// exercise the real Ajv2020 compile/validate path (research
// m5-response-envelope.md Q2 — empirically verified to compile/validate
// cleanly under this exact shape).
const sampleOutputSchema = (): Record<string, unknown> => ({
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { const: 200 },
        contentType: { const: 'application/json' },
        data: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      required: ['status', 'contentType', 'data'],
      additionalProperties: false,
    },
  ],
});

const noSecrets = (): Redactor => createRedactor([]);

const response = (
  status: number,
  contentType: string | undefined,
  body: string | Uint8Array,
): PinnedOutcome => ({
  kind: 'response',
  status,
  ...(contentType === undefined ? {} : { contentType }),
  bodyBytes: typeof body === 'string' ? encoder.encode(body) : body,
});

const errorOutcome = (reason: PinnedErrorReason, detail?: string): PinnedOutcome => ({
  kind: 'error',
  reason,
  ...(detail === undefined ? {} : { detail }),
});

const defaultOpts = (overrides: Partial<MapResponseOptions>): MapResponseOptions => ({
  outcome: response(200, 'application/json', '{}'),
  validator: undefined,
  outputSchema: undefined,
  redactor: noSecrets(),
  maxTextBytes: 4096,
  ...overrides,
});

const isError = (outcome: ToolCallOutcome): string => {
  expect(outcome.isError).toBe(true);
  expect(outcome.structuredContent).toBeUndefined();
  const [block] = outcome.content;
  expect(block?.type).toBe('text');
  return block?.text ?? '';
};

describe('compileEnvelopeValidator', () => {
  it('returns undefined for an undefined outputSchema', () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- outputSchema is a required (non-optional) parameter; dropping the argument changes call arity and fails to type-check (TS2554)
    expect(compileEnvelopeValidator(undefined)).toBeUndefined();
  });

  it('eagerly compiles a valid oneOf outputSchema into a working validator', () => {
    const validate = compileEnvelopeValidator(sampleOutputSchema()) as EnvelopeValidator;
    expect(validate({ status: 200, contentType: 'application/json', data: { id: 1 } })).toBe(true);
    expect(validate({ status: 200, contentType: 'application/json', data: { id: 'x' } })).toBe(
      false,
    );
    expect(validate({ status: 201, contentType: 'application/json', data: { id: 1 } })).toBe(false);
  });

  it('throws at compile time for an incompatible schema (fail fast at startup, not first call)', () => {
    expect(() => compileEnvelopeValidator({ type: 'object', oneOf: 'not-an-array' })).toThrow();
  });
});

describe('mapResponse — PinnedOutcome errors', () => {
  const reasons: readonly PinnedErrorReason[] = [
    'timeout',
    'cancelled',
    'egress',
    'too-large',
    'redirect-loop',
    'redirect-write-method',
    'redirect-invalid',
    'network',
  ];

  it.each(reasons)(
    'maps PinnedOutcome error reason "%s" to a fixed isError, never the raw detail',
    (reason) => {
      const secretDetail = 'super-secret-internal-hostname-should-never-leak';
      const outcome = errorOutcome(reason, secretDetail);
      const text = isError(mapResponse(defaultOpts({ outcome })));
      expect(text).not.toContain(secretDetail);
      expect(text.length).toBeGreaterThan(0);
    },
  );
});

describe('mapResponse — HTTP error status (>=400)', () => {
  it('401 drops the body entirely and names the envVarHint', () => {
    const outcome = response(401, 'text/plain', 'invalid credentials: sk-abcdef1234567890');
    const text = isError(mapResponse(defaultOpts({ outcome, envVarHint: 'API_TOKEN' })));
    expect(text).toContain('401');
    expect(text).toContain('API_TOKEN');
    expect(text).not.toContain('sk-abcdef1234567890');
  });

  it('403 drops the body entirely and names the envVarHint', () => {
    const outcome = response(403, 'text/plain', 'forbidden, token abc');
    const text = isError(mapResponse(defaultOpts({ outcome, envVarHint: 'API_TOKEN' })));
    expect(text).toContain('403');
    expect(text).toContain('API_TOKEN');
    expect(text).not.toContain('forbidden, token abc');
  });

  it('401 with no envVarHint omits the hint clause', () => {
    const outcome = response(401, 'text/plain', 'nope');
    const text = isError(mapResponse(defaultOpts({ outcome })));
    expect(text).toContain('401');
    expect(text).not.toContain('nope');
  });

  it('500 with a body returns a byte-capped, sanitized, redacted excerpt', () => {
    const secret = 'sk-live-1234567890abcdef';
    const outcome = response(500, 'text/plain', `boom: ${secret} happened`);
    const redactor = createRedactor([secret]);
    const text = isError(mapResponse(defaultOpts({ outcome, redactor })));
    expect(text).toContain('500');
    expect(text).toContain('boom:');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(secret);
  });

  it('a non-401/403 error with an empty body reports only the status', () => {
    const outcome = response(502, 'text/plain', '');
    const text = isError(mapResponse(defaultOpts({ outcome })));
    expect(text).toContain('502');
  });

  it('an error body that is not valid UTF-8 is reported generically (fatal decode, no excerpt)', () => {
    const outcome = response(500, 'text/plain', new Uint8Array([0xff, 0xfe, 0xfd]));
    const text = isError(mapResponse(defaultOpts({ outcome })));
    // Exact match: a lenient (non-fatal) decode would instead succeed and
    // append a replacement-character excerpt after a ": " suffix.
    expect(text).toBe('upstream request failed with status 500');
  });

  it('redacts a secret BEFORE truncating so it never leaks a straddling fragment', () => {
    const secret = 'sk-boundary-secret-0123456789';
    // SanitizeSpecText's cut point for a DISPLAY_TEXT_MAX (8192) excerpt is
    // (8192 - TRUNCATION_MARKER.length) = 8180 characters. Padding of 8170
    // 'x' chars puts the secret's first 10 characters INSIDE that cut point
    // and its last 20 characters past it — a genuine straddle. If truncation
    // ran before redaction, the surviving "sk-boundar" prefix would leak.
    const padding = 'x'.repeat(8170);
    const body = `${padding}${secret}`;
    const outcome = response(500, 'text/plain', body);
    const redactor = createRedactor([secret]);
    const text = isError(mapResponse(defaultOpts({ outcome, redactor })));
    expect(text).toContain('[redacted]');
    // No fragment of the raw secret survives either
    for (let cut = 4; cut < secret.length; cut += 1) {
      expect(text).not.toContain(secret.slice(0, cut));
    }
  });

  // The escaped-JSON-secret leak the no-outputSchema SUCCESS-path test below
  // guards against — a secret escaped as `\/` bypassing a redactor built from
  // the raw secret — applies equally on the 4xx/5xx error path: mapHttpError
  // redacts the raw body text, so it must catch the escaped form there too.
  it('a 500 application/json body with a secret escaped as `\\/` never leaks via the error path', () => {
    const secret = 'ab/cd/ef/gh'; // Registered secret containing `/`
    const escapedSecret = 'ab\\/cd\\/ef\\/gh'; // Runtime value: ab\/cd\/ef\/gh (literal backslashes)
    const body = `{"error":"${escapedSecret}"}`;
    const outcome = response(500, 'application/json', body);
    const redactor = createRedactor([secret]);
    const text = isError(mapResponse(defaultOpts({ outcome, redactor })));
    expect(text).toBe('upstream request failed with status 500');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(escapedSecret);
  });

  it('drops the excerpt entirely if scanForSecret finds residue after redaction', () => {
    const outcome = response(500, 'text/plain', 'harmless body text');
    const forcedResidue: Redactor = {
      redactString: (value) => value,
      redactJson: (value) => value,
      scanForSecret: () => true,
    };
    const text = isError(mapResponse(defaultOpts({ outcome, redactor: forcedResidue })));
    expect(text).toBe('upstream request failed with status 500');
  });
});

describe('mapResponse — no outputSchema (validator undefined)', () => {
  it('a secret-free JSON body within cap is returned as plain text', () => {
    const outcome = response(200, 'application/json', '{"id":1}');
    const result = mapResponse(
      defaultOpts({ outcome, redactor: createRedactor(['unrelated-secret']) }),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toBe('{"id":1}');
  });

  // The "a secret anywhere downgrades to a generic isError, never a
  // redacted-but-successful body" policy — already applied to the
  // outputSchema path (mapSchemaSuccess) — now extends to the
  // no-outputSchema JSON path too. A JSON success body is parsed and its
  // STRUCTURE scanned before any string-level redaction is attempted; a hit
  // there means outright rejection, never a redact-and-serve. (Supersedes
  // the previous behavior of redacting the secret in place and returning it
  // as successful text — that behavior was itself the gap: it could only
  // ever match the secret's exact raw-text encoding, never a JSON-escaped
  // one; see the escaped-secret test below.)
  it('a JSON body containing a registered secret is rejected outright, never redacted-and-served', () => {
    const secret = 'tok-abcdefghij0123456789';
    const outcome = response(200, 'application/json', `{"token":"${secret}"}`);
    const redactor = createRedactor([secret]);
    const result = mapResponse(defaultOpts({ outcome, redactor }));
    const text = isError(result);
    expect(text).toBe('the upstream response could not be returned safely');
    expect(text).not.toContain(secret);
  });

  // Covers the "parse failed" branch: a body whose Content-Type
  // claims JSON but is not actually valid JSON has no structure to scan, so
  // it falls through to the existing redacted-text handling unchanged.
  it('a JSON-labeled body that is not valid JSON falls through to the redacted-text path', () => {
    const outcome = response(200, 'application/json', 'not-json {');
    const result = mapResponse(defaultOpts({ outcome }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('not-json {');
  });

  // The scanForSecret contract (redact.ts) says a pathologically deep body
  // throws rather than looping forever. scanSafely must catch that and fail
  // closed to a generic isError from WITHIN mapResponse (keeping it locally
  // fail-closed), not let it escape to the dispatcher's outer catch.
  // Simulated here via a redactor whose scanForSecret throws, standing in
  // for a genuine deep-recursion overflow.
  it('a scanForSecret throw (e.g. pathological recursion depth) fails closed to a generic isError', () => {
    const outcome = response(200, 'application/json', '{"a":1}');
    const throwingScan: Redactor = {
      redactString: (value) => value,
      redactJson: (value) => value,
      scanForSecret: () => {
        throw new RangeError('Maximum call stack size exceeded');
      },
    };
    const text = isError(mapResponse(defaultOpts({ outcome, redactor: throwingScan })));
    expect(text).toBe('the upstream response could not be returned safely');
  });

  it('a text/* body within cap is returned as redacted plain text', () => {
    const outcome = response(200, 'text/plain; charset=utf-8', 'hello world');
    const result = mapResponse(defaultOpts({ outcome }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('hello world');
  });

  it('a body over maxTextBytes is truncated with an explicit marker', () => {
    const outcome = response(200, 'text/plain', 'a'.repeat(100));
    const result = mapResponse(defaultOpts({ outcome, maxTextBytes: 10 }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.content[0]?.text.length).toBeLessThan(100);
  });

  it('truncates on a valid UTF-8 boundary rather than splitting a multi-byte codepoint', () => {
    // Each "é" is 2 bytes in UTF-8. maxTextBytes=19 -> budget (19 - the
    // 14-byte marker) = 5 bytes, landing 1 byte into the first "é" (after the
    // 4-byte "aaaa" prefix) — a genuine split that forces the retry loop to
    // step back one byte before it finds a clean boundary.
    const outcome = response(200, 'text/plain', `aaaa${'é'.repeat(20)}`);
    const result = mapResponse(defaultOpts({ outcome, maxTextBytes: 19 }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe(`aaaa${TRUNCATION_MARKER}`);
    // Must decode cleanly (no lone surrogate / replacement artifacts).
    expect(() => encoder.encode(result.content[0]?.text ?? '')).not.toThrow();
  });

  it('redacts a secret straddling the truncation boundary before cutting it', () => {
    const secret = 'tok-straddle-secret-0123456789'; // 31 ASCII bytes
    const body = `${'x'.repeat(5)}${secret}${'y'.repeat(5)}`;
    const redactor = createRedactor([secret]);
    const outcome = response(200, 'text/plain', body);
    // TruncateUtf8's budget is (maxTextBytes - TRUNCATION_MARKER byte length
    // [14]). maxTextBytes=34 -> budget=20 bytes, landing 15 bytes into the
    // secret (after the 5-byte "x" prefix) — a genuine straddle. A naive
    // truncate-then-redact would leave the surviving "tok-straddle-se"
    // prefix in the output.
    const result = mapResponse(defaultOpts({ outcome, redactor, maxTextBytes: 34 }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('[redacted]');
    for (let cut = 4; cut < secret.length; cut += 1) {
      expect(result.content[0]?.text).not.toContain(secret.slice(0, cut));
    }
  });

  it('a binary/unknown media type is reported as an isError naming the media type', () => {
    const outcome = response(200, 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const text = isError(mapResponse(defaultOpts({ outcome })));
    expect(text).toContain('image/png');
  });

  // The unsupported-media-type message interpolates the upstream-controlled
  // Content-Type essence. A hostile upstream can echo a registered secret
  // through its own Content-Type header, so that essence must be redacted
  // (not merely sanitize-truncated) before it reaches this error text.
  // Secret is lowercase because mediaEssence() lowercases the observed
  // essence before it ever reaches this message.
  it('an unsupported Content-Type whose essence contains a registered secret is redacted, not echoed', () => {
    const secret = 'leaked-secret-value';
    const outcome = response(200, `application/x-${secret}-blob`, new Uint8Array([0x01]));
    const redactor = createRedactor([secret]);
    const text = isError(mapResponse(defaultOpts({ outcome, redactor })));
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(secret);
  });

  it('a missing Content-Type on a body-bearing success falls back to plain text', () => {
    const outcome = response(200, undefined, 'no content-type here');
    const result = mapResponse(defaultOpts({ outcome }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('no content-type here');
  });

  it('an empty/204 body produces an empty text outcome', () => {
    const outcome = response(204, undefined, '');
    const result = mapResponse(defaultOpts({ outcome }));
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('');
  });

  it('a body that is not valid UTF-8 is reported as an isError (fatal decode, not silent replacement)', () => {
    const outcome = response(200, 'text/plain', new Uint8Array([0xff, 0xfe, 0xfd]));
    const text = isError(mapResponse(defaultOpts({ outcome })));
    expect(text).toBe('upstream response body was not valid UTF-8 text');
  });

  it('drops to a generic isError if scanForSecret finds residue after redaction+truncation', () => {
    const outcome = response(200, 'text/plain', 'harmless');
    const forcedResidue: Redactor = {
      redactString: (value) => value,
      redactJson: (value) => value,
      scanForSecret: () => true,
    };
    const text = isError(mapResponse(defaultOpts({ outcome, redactor: forcedResidue })));
    expect(text).toBe('the upstream response could not be returned safely');
  });

  // The old no-outputSchema JSON path did STRING-only redaction on the raw
  // body text, never parsing it — so a secret present in the JSON STRUCTURE
  // but escaped differently in its serialized form evaded both redactString
  // and the final scanForSecret
  // (both operating on the raw text). Concrete case: a secret containing
  // '/' (present in base64 and HTTP Basic-auth creds); PHP's json_encode
  // (and other encoders) render '/' as '\/', so the raw wire body reads
  // `sk...\/...` while every redactor needle is the unescaped
  // `sk.../...` — neither raw-text pass ever matches it. Parsing the JSON
  // and scanning the resulting STRUCTURE compares against the actual
  // decoded string value (JSON.parse un-escapes `\/` back to `/`), which is
  // what a string-only pass structurally cannot do. The escaped body is
  // built literally here (a JS string with an explicit doubled backslash,
  // `'\\/'`, so the runtime string value is a single literal backslash
  // followed by a slash) rather than via a real server or JSON.stringify
  // (Node's JSON.stringify does not escape '/', so it could not produce
  // this fixture).
  it('a JSON body with a secret escaped as `\\/` (PHP-style json_encode) never leaks via the no-outputSchema path', () => {
    const secret = 'ab/cd/ef/gh'; // Contains '/', the load-bearing property of this case
    const escapedSecret = 'ab\\/cd\\/ef\\/gh'; // Runtime value: ab\/cd\/ef\/gh (literal backslashes)
    const body = `{"token":"${escapedSecret}"}`;
    const redactor = createRedactor([secret]);
    const outcome = response(200, 'application/json', body);
    const text = isError(mapResponse(defaultOpts({ outcome, redactor })));
    expect(text).toBe('the upstream response could not be returned safely');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(escapedSecret);
  });
});

describe('mapResponse — outputSchema present (validator defined)', () => {
  const buildOpts = (overrides: Partial<MapResponseOptions>): MapResponseOptions => {
    const outputSchema = sampleOutputSchema();
    const validator = compileEnvelopeValidator(outputSchema) as EnvelopeValidator;
    return defaultOpts({ outputSchema, validator, ...overrides });
  };

  it('a matching JSON success validates into a structuredOutcome with the serialized envelope as text', () => {
    const outcome = response(200, 'application/json; charset=utf-8', '{"id":1}');
    const result = mapResponse(buildOpts({ outcome }));
    expect(result.isError).toBe(false);
    const envelope = { status: 200, contentType: 'application/json', data: { id: 1 } };
    expect(result.structuredContent).toEqual(envelope);
    expect(result.content[0]?.text).toBe(JSON.stringify(envelope));
  });

  it('a response whose data violates the branch shape is isError with no structuredContent', () => {
    const outcome = response(200, 'application/json', '{"id":"not-a-number"}');
    const result = mapResponse(buildOpts({ outcome }));
    const text = isError(result);
    expect(text).toContain('200');
    expect(text).not.toContain('not-a-number');
  });

  it('content-type matching NO declared branch is isError', () => {
    const outcome = response(200, 'application/xml', '<x/>');
    const text = isError(mapResponse(buildOpts({ outcome })));
    expect(text).toContain('application/xml');
  });

  // Same upstream-controlled-essence redaction as the no-outputSchema
  // unsupported-media-type message, for the outputSchema branch-mismatch
  // message.
  it('a mismatched Content-Type essence containing a registered secret is redacted, not echoed', () => {
    const secret = 'leaked-secret-value';
    const outcome = response(200, `application/x-${secret}-blob`, '{}');
    const redactor = createRedactor([secret]);
    const text = isError(mapResponse(buildOpts({ outcome, redactor })));
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(secret);
  });

  it('a missing Content-Type on a body-bearing success is isError, naming it as missing', () => {
    const outcome = response(200, undefined, '{"id":1}');
    const text = isError(mapResponse(buildOpts({ outcome })));
    expect(text).toContain('(missing)');
  });

  it('a status not among the declared branches is isError', () => {
    const outcome = response(201, 'application/json', '{"id":1}');
    const text = isError(mapResponse(buildOpts({ outcome })));
    expect(text).toContain('201');
  });

  // The never-called stub proves the malformed-schema branch below is
  // rejected by branchesOf's own guards BEFORE the validator is ever reached
  // — these are defensive, fail-closed reads of a hand-built/malformed
  // outputSchema (the toolgen-generated shape never violates them).
  const neverCalled: EnvelopeValidator = () => {
    throw new Error('validator must not be called when no branch matches');
  };

  it('a malformed outputSchema whose oneOf is not an array matches no branch', () => {
    const outcome = response(200, 'application/json', '{"id":1}');
    const outputSchema = { type: 'object', oneOf: 'not-an-array' };
    const text = isError(
      mapResponse(defaultOpts({ outcome, outputSchema, validator: neverCalled })),
    );
    expect(text).toContain('200');
  });

  it('a oneOf entry with no properties object matches no branch', () => {
    const outcome = response(200, 'application/json', '{"id":1}');
    const outputSchema = { type: 'object', oneOf: [{ type: 'object' }] };
    const text = isError(
      mapResponse(defaultOpts({ outcome, outputSchema, validator: neverCalled })),
    );
    expect(text).toContain('200');
  });

  it('a oneOf entry whose status/contentType are not const-object records matches no branch', () => {
    const outcome = response(200, 'application/json', '{"id":1}');
    const outputSchema = {
      type: 'object',
      oneOf: [{ type: 'object', properties: { status: 200, contentType: 'application/json' } }],
    };
    const text = isError(
      mapResponse(defaultOpts({ outcome, outputSchema, validator: neverCalled })),
    );
    expect(text).toContain('200');
  });

  it('a oneOf entry whose status/contentType const values have the wrong types matches no branch', () => {
    const outcome = response(200, 'application/json', '{"id":1}');
    const outputSchema = {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: { status: { const: '200' }, contentType: { const: 123 } },
        },
      ],
    };
    const text = isError(
      mapResponse(defaultOpts({ outcome, outputSchema, validator: neverCalled })),
    );
    expect(text).toContain('200');
  });

  it('an empty/204 body cannot form a valid envelope and is isError', () => {
    const outcome = response(200, 'application/json', '');
    const text = isError(mapResponse(buildOpts({ outcome })));
    expect(text).toContain('200');
  });

  it('a body that is not valid JSON is isError', () => {
    const outcome = response(200, 'application/json', 'not json {');
    const text = isError(mapResponse(buildOpts({ outcome })));
    expect(text).toContain('200');
  });

  it('a body that is not valid UTF-8 is isError (fatal decode)', () => {
    const outcome = response(200, 'application/json', new Uint8Array([0xff, 0xfe, 0xfd]));
    const text = isError(mapResponse(buildOpts({ outcome })));
    // Exact match: a lenient (non-fatal) decode would instead succeed and
    // fail later at JSON.parse with a DIFFERENT ("was not valid JSON") message.
    expect(text).toBe('upstream response body was not valid UTF-8 text');
  });

  it('REDACT-then-SCAN: a secret in the structured data is a generic isError, never returned', () => {
    const secret = 'sk-structured-data-secret-0123456789';
    const outcome = response(200, 'application/json', `{"id":1,"note":"${secret}"}`);
    // The sample schema's `data` has additionalProperties:false and no "note"
    // field, so this would ALSO fail shape validation — use a schema whose
    // data is permissive, to prove the scanForSecret gate fires BEFORE (and
    // independently of) the ajv validation gate.
    const permissiveSchema: Record<string, unknown> = {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            status: { const: 200 },
            contentType: { const: 'application/json' },
            data: { type: 'object' },
          },
          required: ['status', 'contentType', 'data'],
          additionalProperties: false,
        },
      ],
    };
    const validator = compileEnvelopeValidator(permissiveSchema) as EnvelopeValidator;
    const redactor = createRedactor([secret]);
    const result = mapResponse(
      defaultOpts({ outcome, outputSchema: permissiveSchema, validator, redactor }),
    );
    const text = isError(result);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('[redacted]'); // Never a redacted-but-successful shape either
  });

  it('a validator defined with no outputSchema (contract violation) fails closed', () => {
    const outcome = response(200, 'application/json', '{"id":1}');
    const validator = compileEnvelopeValidator(sampleOutputSchema()) as EnvelopeValidator;
    const text = isError(mapResponse(defaultOpts({ outcome, validator, outputSchema: undefined })));
    expect(text.length).toBeGreaterThan(0);
  });
});
