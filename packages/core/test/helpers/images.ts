// Image bytes for tests: only the headers sniffImage reads
export const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((char) => char.codePointAt(0) ?? 0) : part,
    ),
  );
export const be32 = (value: number): number[] => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const pngOf = (width: number, height: number): Uint8Array =>
  bytes(PNG_SIGNATURE, be32(13), 'IHDR', be32(width), be32(height), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
