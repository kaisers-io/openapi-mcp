import { readUpload } from '../../files/upload.ts';
import type { ManagedFolder } from '../../files/folder.ts';
import { sniffImage } from '../../images/sniff.ts';
import { parseMediaType, RAW_IMAGE_TYPES } from '../../toolgen/media-type.ts';
import type { RequestMapper } from '../../toolgen/layout.ts';

// --upload-dir (#29): the server reads a file the agent named and sends its
// bytes, where the tool's binary field would otherwise take base64.
export type Uploads = { folder: ManagedFolder; maxBytes: number };

const isFileReference = (value: unknown): value is { file: string } =>
  value !== null &&
  typeof value === 'object' &&
  Object.keys(value).length === 1 &&
  typeof (value as { file?: unknown }).file === 'string';

// The arguments with every file reference replaced by the file's bytes as
// base64, the form the request builder already takes. A file whose bytes do
// not match a declared image type is refused: the operation said what it
// accepts, and this narrows what a misled agent can send.
export const resolveUploads = async (
  data: Record<string, unknown>,
  mapper: RequestMapper,
  uploads: Uploads,
): Promise<{ ok: Record<string, unknown> } | { error: string }> => {
  const resolved: Record<string, unknown> = { ...data };
  for (const [name, mapping] of Object.entries(mapper.fields)) {
    const value = data[name];
    if (mapping.destination === 'body' && mapping.upload === true && isFileReference(value)) {
      let bytes: Uint8Array;
      try {
        bytes = await readUpload(uploads.folder, value.file, uploads.maxBytes);
      } catch (error) {
        return { error: `upload ${error instanceof Error ? error.message : 'failed'}` };
      }
      const declared =
        mapping.partContentType ??
        (mapping.bodyPath.length === 0 ? mapper.bodyContentType : undefined);
      const essence = declared === undefined ? undefined : parseMediaType(declared)?.essence;
      if (
        essence !== undefined &&
        RAW_IMAGE_TYPES.has(essence) &&
        sniffImage(bytes)?.mediaType !== essence
      ) {
        return { error: `upload "${value.file}" is not the declared ${essence}` };
      }
      resolved[name] = Buffer.from(bytes).toString('base64');
    }
  }
  return { ok: resolved };
};
