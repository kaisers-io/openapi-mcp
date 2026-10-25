import type { Redactor } from '../redact.ts';

// Whether image bytes contain a registered secret verbatim (#14). Bytes are
// read twice: as latin1, which maps every byte to one character, so an
// ASCII secret is found byte for byte; and as UTF-8, for a secret with
// other characters in a text chunk. Image metadata can still carry data in
// other encodings; that limit is documented.
export const imageHasSecret = (redactor: Redactor, bytes: Uint8Array): boolean => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    return (
      redactor.scanForSecret(buffer.toString('latin1')) ||
      redactor.scanForSecret(buffer.toString('utf8'))
    );
  } catch {
    // A scan that fails counts as a hit: the result is withheld
    return true;
  }
};
