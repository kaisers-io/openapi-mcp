import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/images/sniff.ts';
import { bytes, PNG_SIGNATURE, pngOf } from './helpers/images.ts';

const be16 = (value: number): number[] => [(value >> 8) & 255, value & 255];
const le16 = (value: number): number[] => [value & 255, (value >> 8) & 255];
const le24 = (value: number): number[] => [value & 255, (value >> 8) & 255, (value >> 16) & 255];

const jpegOf = (width: number, height: number): Uint8Array =>
  bytes(
    [0xff, 0xd8],
    // An APP0 segment first, which the walk must step over
    [0xff, 0xe0],
    be16(16),
    'JFIF',
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc0],
    be16(17),
    [8],
    be16(height),
    be16(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  );

const gifOf = (width: number, height: number): Uint8Array =>
  bytes('GIF89a', le16(width), le16(height), [0, 0, 0]);

const webpExtendedOf = (width: number, height: number): Uint8Array =>
  bytes(
    'RIFF',
    [30, 0, 0, 0],
    'WEBP',
    'VP8X',
    [10, 0, 0, 0],
    [0, 0, 0, 0],
    le24(width - 1),
    le24(height - 1),
  );

const webpLossyOf = (width: number, height: number): Uint8Array =>
  bytes(
    'RIFF',
    [30, 0, 0, 0],
    'WEBP',
    'VP8 ',
    [20, 0, 0, 0],
    [0, 0, 0],
    [0x9d, 0x01, 0x2a],
    le16(width),
    le16(height),
    [0, 0],
  );

const webpLosslessOf = (width: number, height: number): Uint8Array => {
  const w = width - 1;
  const h = height - 1;
  return bytes(
    'RIFF',
    [30, 0, 0, 0],
    'WEBP',
    'VP8L',
    [10, 0, 0, 0],
    [0x2f],
    [w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x3) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f],
    [0, 0, 0, 0, 0],
  );
};

describe('sniffImage (#14)', () => {
  it.each([
    ['PNG', pngOf(640, 480), 'image/png', 'png'],
    ['JPEG', jpegOf(1024, 768), 'image/jpeg', 'jpg'],
    ['GIF', gifOf(32, 16), 'image/gif', 'gif'],
    ['WebP (extended)', webpExtendedOf(3000, 2000), 'image/webp', 'webp'],
    ['WebP (lossy)', webpLossyOf(800, 600), 'image/webp', 'webp'],
    ['WebP (lossless)', webpLosslessOf(4000, 3000), 'image/webp', 'webp'],
  ])('recognises %s by its bytes, with its size', (_name, image, mediaType, extension) => {
    const kind = sniffImage(image);
    expect(kind?.mediaType).toBe(mediaType);
    expect(kind?.extension).toBe(extension);
    expect(kind?.width).toBeGreaterThan(0);
    expect(kind?.height).toBeGreaterThan(0);
  });

  it('reads the exact dimensions', () => {
    expect(sniffImage(pngOf(640, 480))).toMatchObject({ width: 640, height: 480 });
    expect(sniffImage(jpegOf(1024, 768))).toMatchObject({ width: 1024, height: 768 });
    expect(sniffImage(gifOf(32, 16))).toMatchObject({ width: 32, height: 16 });
    expect(sniffImage(webpExtendedOf(3000, 2000))).toMatchObject({ width: 3000, height: 2000 });
    expect(sniffImage(webpLossyOf(800, 600))).toMatchObject({ width: 800, height: 600 });
    expect(sniffImage(webpLosslessOf(4000, 3000))).toMatchObject({ width: 4000, height: 3000 });
  });

  it.each([
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')],
    ['JSON', bytes('{"image":"png"}')],
    ['an empty body', bytes()],
    ['a truncated PNG', pngOf(1, 1).slice(0, 20)],
    ['a PNG of width 0', pngOf(0, 10)],
    ['a JPEG without a frame', bytes([0xff, 0xd8, 0xff, 0xe0], be16(4), [0, 0], [0xff, 0xd9])],
    [
      'a JPEG with a broken segment length',
      bytes([0xff, 0xd8, 0xff, 0xe0], be16(1), [0, 0, 0, 0, 0, 0, 0, 0]),
    ],
    [
      'a RIFF that is not WebP',
      bytes(
        'RIFF',
        [30, 0, 0, 0],
        'WAVE',
        'fmt ',
        Array.from({ length: 20 }, () => 0),
      ),
    ],
  ])('refuses %s', (_name, body) => {
    expect(sniffImage(body)).toBeUndefined();
  });

  it('never throws on random bytes', () => {
    let state = 3;
    const nextByte = (): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % 256;
    };
    const prefixes = [
      PNG_SIGNATURE,
      [0xff, 0xd8, 0xff],
      [...'RIFF'].map((c) => c.codePointAt(0) ?? 0),
      [],
    ];
    for (let round = 0; round < 2000; round += 1) {
      const prefix = prefixes[round % prefixes.length] ?? [];
      const body = Uint8Array.from([
        ...prefix,
        ...Array.from({ length: nextByte() % 64 }, nextByte),
      ]);
      expect(() => sniffImage(body)).not.toThrow();
    }
  });

  it('steps over fill bytes and markers without a length before the frame', () => {
    const body = bytes(
      [0xff, 0xd8],
      [0xff, 0xff],
      [0xff, 0xd0],
      [0xff, 0x01],
      [0xff, 0xc2],
      [0, 17, 8, 0, 20, 0, 30],
      [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    );
    expect(sniffImage(body)).toMatchObject({ mediaType: 'image/jpeg', width: 30, height: 20 });
  });

  it('recognises a GIF87a and refuses a WebP chunk it does not know', () => {
    const filler = Array.from({ length: 20 }, () => 1);
    const unknownChunk = bytes('RIFF', [30, 0, 0, 0], 'WEBP', 'ALPH', filler);
    const losslessWithoutSignature = bytes(
      'RIFF',
      [30, 0, 0, 0],
      'WEBP',
      'VP8L',
      [10, 0, 0, 0],
      [0],
      filler,
    );
    expect(sniffImage(bytes('GIF87a', [5, 0, 6, 0], [0, 0, 0]))).toMatchObject({
      width: 5,
      height: 6,
    });
    expect(sniffImage(unknownChunk)).toBeUndefined();
    expect(sniffImage(losslessWithoutSignature)).toBeUndefined();
  });
});
