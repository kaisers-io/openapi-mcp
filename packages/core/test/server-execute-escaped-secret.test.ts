import { describe, expect, it } from 'vitest';
import { BOUNDARY_WITHHELD_SUCCESS_TEXT } from '../src/server/withheld.ts';
import { compileEnvelopeValidator, createRedactor, mapResponse } from '../src/index.ts';
import type { MapResponseOptions, ToolCallOutcome } from '../src/index.ts';

// A secret an upstream echoes in another spelling than its own: escaped as
// JSON or as markup entities inside a JSON string or a header, or as a JSON
// number too long for a double. Every path that returns upstream data must
// withhold it, and must still return ordinary data that only looks alike.

const SECRET = 'dummy&pass<word>123';
const ENTITIES = 'dummy&amp;pass&lt;word&gt;123';
const U_ESCAPES = String.raw`dummy\u0026pass\u003cword\u003e123`;
// Long digit-only secrets: a JSON number echoing one parses to a rounded double
const PIN_20 = '98765432109876543211';
const PIN_22 = '9876543210987654321123';

const anyDataSchema = (): Record<string, unknown> => ({
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { const: 200 },
        contentType: { const: 'application/json' },
        data: {},
      },
      required: ['status', 'contentType', 'data'],
    },
  ],
});

type Path = 'structured' | 'structured _fields' | 'no-schema _fields' | 'text';

const map = (
  path: Path,
  body: string,
  secrets: readonly string[],
  extra: Partial<MapResponseOptions> = {},
): ToolCallOutcome => {
  const outputSchema = anyDataSchema();
  const schema = path.startsWith('structured')
    ? { outputSchema, validator: compileEnvelopeValidator(outputSchema) }
    : { outputSchema: undefined, validator: undefined };
  return mapResponse({
    outcome: {
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyBytes: new TextEncoder().encode(body),
      headers: {},
      url: 'https://api.example.test/',
    },
    ...schema,
    ...(path.endsWith('_fields') ? { fields: ['/note', '/pin'] } : {}),
    redactor: createRedactor(secrets),
    maxTextBytes: 4096,
    ...extra,
  });
};

const ALL_PATHS: Path[] = ['structured', 'structured _fields', 'no-schema _fields', 'text'];

// The text of a withheld result, '' for anything else
const withheld = (outcome: ToolCallOutcome): string =>
  outcome.isError && outcome.structuredContent === undefined && outcome.content.length === 1
    ? (outcome.content[0]?.text ?? '')
    : '';

describe('mapResponse — a secret echoed escaped in a JSON string', () => {
  const bodies: [string, string][] = [
    ['as markup entities', JSON.stringify({ note: `<p>key ${ENTITIES}</p>` })],
    ['as JSON escapes', `{"note":"key ${U_ESCAPES}"}`],
    // JSON in a JSON string: the escapes are themselves escaped once more
    ['as JSON escapes inside a JSON string', JSON.stringify({ note: `{"key":"${U_ESCAPES}"}` })],
    ['as entities written with JSON escapes', `{"note":"${ENTITIES.replaceAll('&', '\\u0026')}"}`],
  ];

  it.each(ALL_PATHS.flatMap((path) => bodies.map(([label, body]) => [label, path, body])))(
    'withholds it %s on the %s path',
    (_label, path, body) => {
      expect(withheld(map(path as Path, body, [SECRET]))).toBe(BOUNDARY_WITHHELD_SUCCESS_TEXT);
    },
  );

  it.each(ALL_PATHS)('returns ordinary escaped data on the %s path', (path) => {
    const body = JSON.stringify({ note: String.raw`a &amp; b &lt;i&gt; {"k":"\u0026"}` });
    expect(map(path, body, [SECRET]).isError).toBe(false);
  });
});

describe('mapResponse — a secret echoed escaped in a forwarded header', () => {
  const withHeaders = (path: Path, headers: Record<string, string>): ToolCallOutcome =>
    map(path, '', [SECRET], {
      baseUrl: 'https://api.example.test',
      outcome: {
        kind: 'response',
        status: 200,
        contentType: 'application/json',
        bodyBytes: new TextEncoder().encode('{"note":"ok"}'),
        headers,
        url: 'https://api.example.test/',
      },
    });

  it.each(['structured', 'text'] as const)('drops the header on the %s path', (path) => {
    const outcome = withHeaders(path, {
      'x-ratelimit-entity': ENTITIES,
      'x-ratelimit-uesc': U_ESCAPES,
      'x-ratelimit-remaining': '7',
    });
    expect(outcome.isError).toBe(false);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain('dummy');
    expect(text).toContain('x-ratelimit-remaining');
  });
});

describe('mapResponse — a long numeric secret echoed as a JSON number', () => {
  const echoes = [PIN_20, PIN_22].flatMap((pin) =>
    [
      `{"pin":${pin},"note":"x\\"y"}`,
      `{"pin":${pin},"note":"xy"}`,
      `{"pin":${pin.slice(0, 1)}.${pin.slice(1)}e${pin.length - 1}}`,
    ].flatMap((body) => ALL_PATHS.map((path) => [pin, body, path])),
  );

  it.each(echoes)('withholds %s in %s on the %s path', (pin, body, path) => {
    expect(withheld(map(path as Path, body, [pin]))).toBe(BOUNDARY_WITHHELD_SUCCESS_TEXT);
  });

  it('withholds a secret inside a longer number token on the full-body path', () => {
    const outcome = map('structured', `{"pin":12${PIN_20},"note":"x\\"y"}`, [PIN_20]);
    expect(withheld(outcome)).toBe(BOUNDARY_WITHHELD_SUCCESS_TEXT);
  });

  it.each(ALL_PATHS)('returns other long numbers on the %s path', (path) => {
    // Neighbours of the secret's double, and a long number of its own
    const body = '{"pin":98765432109876560000,"note":"x\\"y","big":12345678901234567890}';
    expect(map(path, body, [PIN_20]).isError).toBe(false);
  });
});
