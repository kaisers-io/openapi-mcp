import { join } from 'node:path';
import {
  cacheNamespace,
  canonicalSourceOf,
  openManagedFolder,
  parseSpecSource,
  sweepUploads,
  usageError,
} from '@kaisers-io/openapi-mcp-core';
import type { Uploads } from '@kaisers-io/openapi-mcp-core';

// --uploads (#29): binary fields also take a file name from one folder per
// API, `~/.kaisers-io/openapi-mcp/uploads/<api>`, the same on every platform

// Files in the folder older than this go at startup
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

// Named like the spec cache entry (the spec source and --cache-key)
export const uploadDirOf = (homeDir: string, canonicalSource: string, cacheKey?: string): string =>
  join(homeDir, '.kaisers-io', 'openapi-mcp', 'uploads', cacheNamespace(canonicalSource, cacheKey));

// The folder for a spec source as given on the command line
export const defaultUploadDir = (
  homeDir: string,
  source: string,
  cwd: string,
  cacheKey?: string,
): string => uploadDirOf(homeDir, canonicalSourceOf(parseSpecSource(source, { cwd })), cacheKey);

export type UploadOptionsInput = {
  enabled: boolean;
  homeDir: string | undefined;
  source: string;
  cwd: string;
  cacheKey?: string;
  httpHost?: string;
  // The request body budget, which an upload counts against
  maxBytes: number;
  now: number;
};

export type ResolvedUploads = Uploads & { deleted: number };

export const resolveUploadOptions = async (
  input: UploadOptionsInput,
): Promise<ResolvedUploads | undefined> => {
  if (!input.enabled) {
    return undefined;
  }
  // A remote client could make this machine's files be sent
  if (input.httpHost !== undefined && !LOOPBACK_ADDRESSES.has(input.httpHost)) {
    throw usageError('--uploads cannot be used with a non-loopback --http-host');
  }
  if (input.homeDir === undefined || input.homeDir === '') {
    throw usageError('--uploads needs a home directory for its upload folder');
  }
  const dir = defaultUploadDir(input.homeDir, input.source, input.cwd, input.cacheKey);
  const folder = await openManagedFolder(dir, 'upload folder');
  const deleted = await sweepUploads(folder, UPLOAD_MAX_AGE_MS, input.now);
  return { folder, maxBytes: input.maxBytes, deleted };
};
