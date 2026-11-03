import { array, assert, constantFrom, property } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeEntities } from '../src/server/execute/html-text.ts';
import { decodedForms } from '../src/server/execute/response-media.ts';

// The JSON escape decoding of the secret scan is a loop over indexOf. It
// must decode exactly as the regex it replaced, which stays here as the
// reference.

const SHORT_ESCAPES = String.raw`"\/bfnrt`;
const SHORT_DECODED = '"\\/\b\f\n\r\t';

const reference = (text: string): string =>
  text.replaceAll(/\\(?:u(?<hex>[0-9a-fA-F]{4})|(?<short>["\\/bfnrt]))/gu, (_escape, hex, short) =>
    hex === undefined
      ? (SHORT_DECODED[SHORT_ESCAPES.indexOf(short as string)] ?? '')
      : String.fromCodePoint(Number.parseInt(hex as string, 16)),
  );

// The JSON forms the reference yields: up to `levels` decodes, until one
// changes nothing
const referenceForms = (text: string, levels: number): string[] => {
  const forms: string[] = [];
  let current = text;
  while (forms.length < levels && current.includes('\\')) {
    const next = reference(current);
    if (next === current) {
      break;
    }
    forms.push(next);
    current = next;
  }
  return forms;
};

// Characters that start, continue or break an escape, plus surrogates. No
// `&` itself, but `\u0026` decodes to one, and then decodedForms appends
// the entity form of every form that has an `&`, after the JSON forms.
const PIECES = [
  '\\',
  '\\',
  'u',
  '0',
  '0',
  '2',
  '6',
  'd',
  'D',
  'F',
  'g',
  '"',
  '/',
  'b',
  'n',
  't',
  'x',
  'é',
  '\uD83D',
  '\uDE00',
];

describe('decodedForms — JSON escapes', () => {
  it('decodes as the regex alternation did, at every level', () => {
    const texts = array(constantFrom(...PIECES), { maxLength: 24 });
    const same = property(texts, (pieces) => {
      const text = pieces.join('');
      const json = referenceForms(text, 4);
      const entities = [text, ...json]
        .filter((form) => form.includes('&'))
        .map((form) => decodeEntities(form));
      expect(decodedForms(text, 4)).toStrictEqual([...json, ...entities]);
    });
    assert(same, { numRuns: 20_000 });
  });

  it.each([
    ['a trailing backslash', 'a\\', []],
    ['a short \\u', String.raw`a\u00`, []],
    ['\\u with a non-hex digit', String.raw`\u00g6`, []],
    ['five hex digits, of which four count', String.raw`\u00411`, ['A1']],
    ['an escaped ampersand, then its entity form', String.raw`\u0026`, ['&', '&']],
    ['an escaped backslash before u', String.raw`\\u0041`, [String.raw`\u0041`, 'A']],
    ['an invalid escape before a valid one', String.raw`\x\n`, ['\\x\n']],
    ['a surrogate pair', String.raw`\uD83D\uDE00`, ['😀']],
    ['a lone surrogate', String.raw`\uD83D!`, ['\uD83D!']],
    ['no escape at all', 'plain text', []],
  ])('handles %s', (_label, text, forms) => {
    expect(decodedForms(text)).toStrictEqual(forms);
  });

  it('stops after the given number of levels', () => {
    const fourDeep = String.raw`\\\\\\\\u0041`;
    expect(decodedForms(fourDeep).at(-1)).toBe(String.raw`\u0041`);
    expect(decodedForms(fourDeep, 4).at(-1)).toBe('A');
  });
});
