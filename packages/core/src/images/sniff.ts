// What an upstream image is, read from its first bytes, never from its
// Content-Type (#14). Only PNG, JPEG, GIF and WebP are recognised; SVG and
// everything else are not images here. The dimensions come from the
// format's header, so a file whose header cannot be read is refused too.

export type ImageKind = {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  extension: 'png' | 'jpg' | 'gif' | 'webp';
  width: number;
  height: number;
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((value, index) => bytes[at + index] === value);

const ascii = (text: string): number[] => [...text].map((char) => char.codePointAt(0) ?? 0);

const u16be = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u16le = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number): number =>
  u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const u32be = (bytes: Uint8Array, at: number): number =>
  ((u16be(bytes, at) << 16) >>> 0) + u16be(bytes, at + 2);

const sized = (
  kind: Omit<ImageKind, 'width' | 'height'>,
  width: number,
  height: number,
): ImageKind | undefined => (width > 0 && height > 0 ? { ...kind, width, height } : undefined);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The IHDR chunk comes first and holds the size
const png = (bytes: Uint8Array): ImageKind | undefined =>
  startsWith(bytes, ascii('IHDR'), 12) && bytes.length >= 24
    ? sized({ mediaType: 'image/png', extension: 'png' }, u32be(bytes, 16), u32be(bytes, 20))
    : undefined;

const gif = (bytes: Uint8Array): ImageKind | undefined =>
  bytes.length >= 10
    ? sized({ mediaType: 'image/gif', extension: 'gif' }, u16le(bytes, 6), u16le(bytes, 8))
    : undefined;

// The first start-of-frame marker holds the size. Markers without a length
// (RST, SOI, TEM) and fill bytes are stepped over; the walk is bounded by
// the byte length.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const jpeg = (bytes: Uint8Array): ImageKind | undefined => {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return undefined;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
    } else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
    } else if (SOF.has(marker)) {
      return sized(
        { mediaType: 'image/jpeg', extension: 'jpg' },
        u16be(bytes, at + 7),
        u16be(bytes, at + 5),
      );
    } else {
      const length = u16be(bytes, at + 2);
      if (length < 2) {
        return undefined;
      }
      at += 2 + length;
    }
  }
  return undefined;
};

// A RIFF container whose first chunk is lossy (VP8), lossless (VP8L) or
// extended (VP8X); each stores the size differently
const webp = (bytes: Uint8Array): ImageKind | undefined => {
  if (!startsWith(bytes, ascii('WEBP'), 8) || bytes.length < 30) {
    return undefined;
  }
  const kind = { mediaType: 'image/webp', extension: 'webp' } as const;
  if (startsWith(bytes, ascii('VP8 '), 12)) {
    return sized(kind, u16le(bytes, 26) & 0x3f_ff, u16le(bytes, 28) & 0x3f_ff);
  }
  if (startsWith(bytes, ascii('VP8L'), 12) && bytes[20] === 0x2f) {
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return sized(
      kind,
      1 + (b1 | ((b2 & 0x3f) << 8)),
      1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    );
  }
  if (startsWith(bytes, ascii('VP8X'), 12)) {
    return sized(kind, 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  }
  return undefined;
};

export const sniffImage = (bytes: Uint8Array): ImageKind | undefined => {
  if (startsWith(bytes, PNG)) {
    return png(bytes);
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return jpeg(bytes);
  }
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return gif(bytes);
  }
  if (startsWith(bytes, ascii('RIFF'))) {
    return webp(bytes);
  }
  return undefined;
};
