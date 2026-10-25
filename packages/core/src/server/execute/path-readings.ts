// The readings an upstream may give the same path (issue #40). The first is
// the path as written; it alone decides which operation a request is. The
// others model what common servers do before routing, so that no request
// reaches an excluded operation on any of them: percent-decoding (also twice,
// as IIS can), `\` as a separator, merged repeated slashes (NGINX's default),
// `;parameters` cut from a segment (Tomcat, Spring: `..;/`), then dot
// segments resolved. They can only add a refusal, so an id such as
// `group%2Fproject` still reaches its own operation.
const SEPARATOR_RE = /[\\/]/u;
const HEX_PAIR_RE = /^[\dA-Fa-f]{2}$/u;
const encoder = new TextEncoder();
// Decodes byte by byte, as NGINX does: a sequence that is not valid UTF-8
// becomes U+FFFD instead of stopping the decoding, so `%FF%2F..` still
// yields its separator and dot segment
const decodeBytes = (text: string): string => {
  // Nothing to decode: the text reads as itself. A lone surrogate becomes
  // U+FFFD and a leading U+FEFF is dropped below, so those take the slow path
  if (!text.includes('%') && text.isWellFormed() && !text.startsWith('\uFEFF')) {
    return text;
  }
  const bytes: number[] = [];
  let index = 0;
  while (index < text.length) {
    const hex = text.slice(index + 1, index + 3);
    if (text[index] === '%' && HEX_PAIR_RE.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
    } else {
      const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
      bytes.push(...encoder.encode(char));
      index += char.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};
const withoutParameters = (segment: string): string => segment.split(';', 1)[0] ?? segment;
// Dot segments resolved and repeated slashes merged, in either order: a
// server that merges first reads `/a//../b` as `/b`, one that resolves `..`
// first (RFC 3986 §5.2.4) as `/a/b`
const normalized = (
  segments: readonly string[],
  cutParameters: boolean,
  mergeFirst: boolean,
): string => {
  const kept: string[] = [];
  const parts = segments.slice(1).map((part) => (cutParameters ? withoutParameters(part) : part));
  for (const segment of parts) {
    if (segment === '..') {
      kept.pop();
    } else if (segment !== '.' && !(mergeFirst && segment === '')) {
      kept.push(segment);
    }
  }
  return `/${kept.filter((segment) => segment !== '').join('/')}`;
};
export const pathReadings = (path: string): readonly string[] => {
  const decoded = decodeBytes(path);
  const splits = [
    path.split(SEPARATOR_RE),
    path.split(SEPARATOR_RE).map((segment) => decodeBytes(segment)),
    decoded.split(SEPARATOR_RE),
    decodeBytes(decoded).split(SEPARATOR_RE),
  ];
  const variants = [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const;
  return [
    ...new Set([
      path,
      ...variants.flatMap(([cut, mergeFirst]) =>
        splits.map((segments) => normalized(segments, cut, mergeFirst)),
      ),
    ]),
  ];
};

// One path segment of a template: literal text and `{param}` placeholders
export type Token = { literal: string } | { param: true };
type Segment = readonly Token[];

const isParam = (token: Token): boolean => 'param' in token;

// Adjacent literals are one, and so are adjacent placeholders (each matches
// one or more characters)
const compact = (tokens: readonly Token[]): Token[] => {
  const merged: Token[] = [];
  for (const token of tokens) {
    const last = merged.at(-1);
    if (last !== undefined && 'literal' in last && 'literal' in token) {
      merged[merged.length - 1] = { literal: `${last.literal}${token.literal}` };
    } else if (last === undefined || !isParam(last) || !isParam(token)) {
      merged.push(token);
    }
  }
  return merged;
};

// Up to the first `;` of the segment's literal text
const withoutSegmentParameters = (segment: Segment): Token[] => {
  const cut = segment.findIndex((token) => 'literal' in token && token.literal.includes(';'));
  if (cut === -1) {
    return [...segment];
  }
  const token = segment[cut];
  const kept = token !== undefined && 'literal' in token ? token.literal.split(';', 1)[0] : '';
  return [...segment.slice(0, cut), { literal: kept ?? '' }];
};

const isEmpty = (segment: Segment): boolean =>
  segment.every((token) => 'literal' in token && token.literal === '');
const dotSegment = (segment: Segment): string | undefined => {
  const [only] = segment;
  return segment.length === 1 && only !== undefined && 'literal' in only ? only.literal : undefined;
};

// The same readings for a template, done on its tokens: decoding turns only
// literal text into text (an encoded `%7Bx%7D` stays literal, never becomes a
// placeholder), and a decoded separator splits the segment
const readTemplate = (
  segments: readonly Segment[],
  piecesOf: (text: string) => string[],
  cutParameters: boolean,
  mergeFirst: boolean,
): Segment[] => {
  const split = segments.flatMap((segment) => {
    const parts: Token[][] = [[]];
    for (const token of segment) {
      if ('param' in token) {
        parts.at(-1)?.push(token);
      } else {
        const [first = '', ...rest] = piecesOf(token.literal);
        parts.at(-1)?.push({ literal: first });
        parts.push(...rest.map((text) => [{ literal: text }]));
      }
    }
    return parts.map((part) => compact(cutParameters ? withoutSegmentParameters(part) : part));
  });
  const kept: Segment[] = [];
  for (const segment of split) {
    const dots = dotSegment(segment);
    if (dots === '..') {
      kept.pop();
    } else if (dots !== '.' && !(mergeFirst && isEmpty(segment))) {
      kept.push(segment);
    }
  }
  return kept.filter((segment) => !isEmpty(segment));
};

export const templateReadings = (segments: readonly Segment[]): Segment[][] => {
  const decoders = [
    (text: string) => text,
    (text: string) => decodeBytes(text),
    (text: string) => decodeBytes(decodeBytes(text)),
  ];
  // Decoded before splitting (an encoded separator splits), and split before
  // decoding (an encoded `%2e%2e` is a dot segment), as for request paths.
  // Each literal is split once per splitter, not once per cut/merge variant
  const splitters = decoders
    .flatMap((decode) => [
      (text: string) => decode(text).split(SEPARATOR_RE),
      (text: string) => text.split(SEPARATOR_RE).map((piece) => decode(piece)),
    ])
    .map((split) => {
      const pieces = new Map<string, string[]>();
      return (text: string): string[] => {
        const known = pieces.get(text) ?? split(text);
        pieces.set(text, known);
        return known;
      };
    });
  const readings = splitters.flatMap((piecesOf) =>
    [false, true].flatMap((cutParameters) =>
      [false, true].map((mergeFirst) =>
        readTemplate(segments, piecesOf, cutParameters, mergeFirst),
      ),
    ),
  );
  // Keyed by their tokens, so equal readings count once
  return [...new Map(readings.map((reading) => [JSON.stringify(reading), reading])).values()];
};
