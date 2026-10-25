import type { PinnedOutcome } from '../../http/pinned-dispatcher.ts';
import { imageHasSecret } from '../../images/scan.ts';
import { sniffImage } from '../../images/sniff.ts';
import type { ImageStore } from '../../images/store.ts';
import { textOutcome } from '../result.ts';
import type { ToolCallOutcome } from '../result.ts';
import { withheldSuccess } from '../withheld.ts';
import { mediaEssence } from './response-media.ts';

// `--image-responses` (#14): an upstream image as an MCP image block
// (`inline`) or as a saved file whose path is returned (`file`, a few
// tokens instead of the image's).
export type ImageResponses = { mode: 'inline' } | { mode: 'file'; store: ImageStore };

// Hosts refuse larger images as model input
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 8000;

type Response = Extract<PinnedOutcome, { kind: 'response' }>;

// A 2xx whose Content-Type is an image, for a tool without an output schema
// (an image result carries no structured content, which a declared output
// schema would require). Whether it really is one is decided by its bytes.
export const isImageResponse = (
  outcome: PinnedOutcome,
  hasOutputSchema: boolean,
): outcome is Response =>
  outcome.kind === 'response' &&
  outcome.status >= 200 &&
  outcome.status < 300 &&
  !hasOutputSchema &&
  mediaEssence(outcome.contentType)?.startsWith('image/') === true;

const failed = (status: number, reason: string): ToolCallOutcome =>
  textOutcome(`upstream response for status ${String(status)} ${reason}`, true);

export const imageOutcome = async (
  outcome: Response,
  images: ImageResponses,
  redactor: Parameters<typeof imageHasSecret>[0],
): Promise<ToolCallOutcome> => {
  const { status, bodyBytes } = outcome;
  if (bodyBytes.byteLength > IMAGE_MAX_BYTES) {
    return failed(status, `is an image over the ${String(IMAGE_MAX_BYTES)}-byte image limit`);
  }
  const kind = sniffImage(bodyBytes);
  if (kind === undefined) {
    return failed(status, 'is not a PNG, JPEG, GIF or WebP image');
  }
  if (kind.width > IMAGE_MAX_SIDE || kind.height > IMAGE_MAX_SIDE) {
    return failed(status, `is an image over ${String(IMAGE_MAX_SIDE)} pixels per side`);
  }
  if (imageHasSecret(redactor, bodyBytes)) {
    return withheldSuccess();
  }
  const facts = `${kind.mediaType}, ${String(kind.width)}x${String(kind.height)}, ${String(bodyBytes.byteLength)} bytes`;
  if (images.mode === 'inline') {
    return {
      isError: false,
      content: [
        { type: 'text', text: `image ${facts}` },
        {
          type: 'image',
          data: Buffer.from(bodyBytes).toString('base64'),
          mimeType: kind.mediaType,
        },
      ],
    };
  }
  try {
    const path = await images.store.save(bodyBytes, kind);
    return textOutcome(`image ${facts}, saved to ${path}`, false);
  } catch (error) {
    const { code } = error as { code?: unknown };
    return failed(
      status,
      `is an image that could not be saved${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }
};
