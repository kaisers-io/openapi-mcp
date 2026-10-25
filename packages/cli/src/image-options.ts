import { join } from 'node:path';
import {
  cacheNamespace,
  canonicalSourceOf,
  parseSpecSource,
  createImageStore,
  IMAGE_MAX_BYTES,
  parseByteSize,
  usageError,
} from '@kaisers-io/openapi-mcp-core';
import type { ImageResponses } from '@kaisers-io/openapi-mcp-core';

// --image-responses and --image-dir-max-bytes (#14)

export const IMAGE_RESPONSE_MODES = ['off', 'inline', 'file'] as const;
type ImageResponseMode = (typeof IMAGE_RESPONSE_MODES)[number];

export const DEFAULT_IMAGE_DIR_MAX_BYTES = '100MB';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

export const parseImageResponseMode = (raw: string): ImageResponseMode => {
  const mode = IMAGE_RESPONSE_MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw usageError(`--image-responses "${raw}" is not one of ${IMAGE_RESPONSE_MODES.join(', ')}`);
  }
  return mode;
};

const parseImageDirMaxBytes = (raw: string): number => {
  const bytes = parseByteSize(raw);
  if (bytes < IMAGE_MAX_BYTES) {
    throw usageError(
      `--image-dir-max-bytes "${raw}" is below the ${String(IMAGE_MAX_BYTES)}-byte size of one image`,
    );
  }
  return bytes;
};

// `~/.kaisers-io/openapi-mcp/images/<api>`: one folder per API, named like
// its spec cache entry (the spec source and --cache-key)
export const imageDirOf = (homeDir: string, canonicalSource: string, cacheKey?: string): string =>
  join(homeDir, '.kaisers-io', 'openapi-mcp', 'images', cacheNamespace(canonicalSource, cacheKey));

export type ImageOptionsInput = {
  mode: string;
  dirMaxBytes: string;
  homeDir: string | undefined;
  // The spec source as given, resolved like the spec cache resolves it
  source: string;
  cwd: string;
  cacheKey?: string;
  // The --http bind address, when serving over HTTP
  httpHost?: string;
};

export const resolveImageResponses = async (
  input: ImageOptionsInput,
): Promise<ImageResponses | undefined> => {
  const mode = parseImageResponseMode(input.mode);
  const maxBytes = parseImageDirMaxBytes(input.dirMaxBytes);
  if (mode === 'off') {
    return undefined;
  }
  if (mode === 'inline') {
    return { mode };
  }
  // A path on this machine means nothing to a client elsewhere
  if (input.httpHost !== undefined && !LOOPBACK_ADDRESSES.has(input.httpHost)) {
    throw usageError('--image-responses file cannot be used with a non-loopback --http-host');
  }
  if (input.homeDir === undefined || input.homeDir === '') {
    throw usageError('--image-responses file needs a home directory for its image folder');
  }
  const canonicalSource = canonicalSourceOf(parseSpecSource(input.source, { cwd: input.cwd }));
  const store = await createImageStore(
    imageDirOf(input.homeDir, canonicalSource, input.cacheKey),
    maxBytes,
  );
  return { mode, store };
};
