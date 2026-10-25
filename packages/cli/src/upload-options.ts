import { join, resolve } from 'node:path';
import {
  cacheNamespace,
  canonicalSourceOf,
  openManagedFolder,
  parseSpecSource,
  sweepUploads,
  usageError,
} from '@kaisers-io/openapi-mcp-core';
import type { Uploads } from '@kaisers-io/openapi-mcp-core';

// --upload-dir (#29)

// Files in the default folder older than this go at startup
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

// `~/.kaisers-io/openapi-mcp/uploads/<api>`, named like the spec cache entry
export const uploadDirOf = (homeDir: string, canonicalSource: string, cacheKey?: string): string =>
  join(homeDir, '.kaisers-io', 'openapi-mcp', 'uploads', cacheNamespace(canonicalSource, cacheKey));

// The default folder for a spec source as given on the command line
export const defaultUploadDir = (
  homeDir: string,
  source: string,
  cwd: string,
  cacheKey?: string,
): string => uploadDirOf(homeDir, canonicalSourceOf(parseSpecSource(source, { cwd })), cacheKey);

export type UploadOptionsInput = {
  // Injectable for tests; the running platform otherwise
  platform?: NodeJS.Platform;
  // The flag: absent, given without a value (the default folder), or a folder
  uploadDir: string | true | undefined;
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
  if (input.uploadDir === undefined) {
    return undefined;
  }
  // A remote client could make this machine's files be sent
  if (input.httpHost !== undefined && !LOOPBACK_ADDRESSES.has(input.httpHost)) {
    throw usageError('--upload-dir cannot be used with a non-loopback --http-host');
  }
  const managed = input.uploadDir === true;
  let dir: string;
  if (managed) {
    if (input.homeDir === undefined || input.homeDir === '') {
      throw usageError('--upload-dir without a folder needs a home directory');
    }
    dir = defaultUploadDir(input.homeDir, input.source, input.cwd, input.cacheKey);
  } else {
    // On Windows a folder's privacy comes from the ACL it inherits, which is
    // private under the user profile; a folder elsewhere may let other users
    // put files in it that would then be sent, and Node cannot check that
    if ((input.platform ?? process.platform) === 'win32') {
      throw usageError(
        '--upload-dir <folder> is not supported on Windows; use --upload-dir without a folder (a private folder under your user profile)',
      );
    }
    dir = resolve(input.cwd, input.uploadDir as string);
  }
  const folder = await openManagedFolder(dir, 'upload folder', managed);
  // Only the folder this server manages is cleaned: a folder the operator
  // chose may hold their originals
  const deleted = managed ? await sweepUploads(folder, UPLOAD_MAX_AGE_MS, input.now) : 0;
  return { folder, maxBytes: input.maxBytes, deleted };
};
