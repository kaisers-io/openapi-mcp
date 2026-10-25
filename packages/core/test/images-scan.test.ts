import { describe, expect, it } from 'vitest';
import { imageHasSecret } from '../src/images/scan.ts';
import { createRedactor } from '../src/redact.ts';

describe('imageHasSecret (#14)', () => {
  const redactor = createRedactor(['example-token-not-a-secret', 'pässwört-example-123']);

  it('finds an ASCII secret byte for byte, and a non-ASCII one as UTF-8', () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    const ascii = Uint8Array.from([0x89, ...encode('example-token-not-a-secret'), 0xff]);
    expect(imageHasSecret(redactor, ascii)).toBe(true);
    expect(imageHasSecret(redactor, encode('chunk pässwört-example-123 end'))).toBe(true);
    expect(imageHasSecret(redactor, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]))).toBe(
      false,
    );
  });

  it('counts a scan that fails as a hit', () => {
    const failing = {
      ...redactor,
      scanForSecret: () => {
        throw new Error('scan failed');
      },
    };
    expect(imageHasSecret(failing, Uint8Array.from([1, 2, 3]))).toBe(true);
  });
});
