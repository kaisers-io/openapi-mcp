import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { RuntimeRedactor } from '../redact.ts';
import { NON_LATIN1_RE, trimSpaces } from './headers.ts';

// --header-file (#125): a credential header whose value is read from a file,
// so a token the user renews by hand works on the next call, without a
// restart. Each call compares the file's metadata with the last read and
// reads it again only when it changed; a 401 makes the next call read it
// again in any case. A call that got a 401 is not sent again (like
// client-go's token file): the user renews the token after the 401.
//
// Any failure fails the call closed with the path and the reason, never the
// value, and never with the last good value: the user changed the file.

export type HeaderFileResult = { ok: string } | { error: string };

export type HeaderFileSource = {
  readonly name: string;
  readonly path: string;
  // The current value: the cached one while the file is unchanged, else the
  // file read again (one read shared by concurrent calls)
  read: () => Promise<HeaderFileResult>;
  // A 401 answered a request sent with `value`: the next call reads the
  // file again even if its metadata looks unchanged. A late 401 for an older
  // value leaves a newer one alone.
  stale: (value: string) => void;
};

// oxlint-disable-next-line no-control-regex -- matching control characters is this regex's purpose (it rejects them)
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;
const isWindows = process.platform === 'win32';
// O_NOFOLLOW refuses a link at the name itself where the platform has it;
// Windows has neither flag, so the dev/ino comparison is what catches a link
// there
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The path as a JSON string: quoted, control characters escaped
export const displayPath = (path: string): string => JSON.stringify(path);

// What a change of the file changes: a rename brings a new inode, a write a
// new size or times
const identityOf = (stats: BigIntStats): string =>
  [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');

const problemOf = (stats: BigIntStats): string | undefined => {
  if (stats.isSymbolicLink()) {
    return 'is a symbolic link';
  }
  if (!stats.isFile()) {
    return 'is not a regular file';
  }
  if (stats.nlink !== 1n) {
    return 'has more than one link';
  }
  if (!isWindows && process.getuid !== undefined && stats.uid !== BigInt(process.getuid())) {
    return 'belongs to another user';
  }
  if (!isWindows && (stats.mode & 0o077n) !== 0n) {
    return 'can be read or written by other users (chmod 600 it)';
  }
  return undefined;
};

class HeaderFileError extends Error {
  override name = 'HeaderFileError';
}

const refuse = (reason: string): never => {
  throw new HeaderFileError(reason);
};

const decoder = new TextDecoder('utf-8', { fatal: true });

// The checks a --header-env value passes, on the decoded text without one
// trailing LF or CRLF
const valueOf = (bytes: Uint8Array, maxLength: number): string => {
  let text = '';
  try {
    text = decoder.decode(bytes);
  } catch {
    refuse('is not valid UTF-8');
  }
  // Spaces around the value are dropped, as the HTTP client drops them when it
  // sends the header: the value registered for redaction is the one sent
  const value = trimSpaces(text.replace(/\r?\n$/u, ''));
  if (value === '') {
    refuse('is empty');
  }
  if (CONTROL_CHAR_RE.test(value)) {
    refuse('contains control characters');
  }
  if (NON_LATIN1_RE.test(value)) {
    refuse('contains a character above U+00FF, which an HTTP header cannot carry');
  }
  if (value.length > maxLength) {
    refuse(`is over the ${String(maxLength)}-character header value budget`);
  }
  return value;
};

export type HeaderFileRead = { value: string; identity: string };

// One checked read: the path must name a regular file with one link, this
// user's and closed to others (POSIX), and the handle that is read must be
// the file that was checked and unchanged after the read. Throws a
// HeaderFileError whose message is the reason, never the content.
export const readHeaderFile = async (path: string, maxLength: number): Promise<HeaderFileRead> => {
  const named = await lstat(path, { bigint: true }).catch(() => refuse('is missing'));
  const problem = problemOf(named);
  if (problem !== undefined) {
    refuse(problem);
  }
  // Latin-1 characters take up to two bytes in UTF-8, and a line break two
  const maxBytes = maxLength * 2 + 2;
  if (named.size > BigInt(maxBytes)) {
    refuse(`is over the ${String(maxLength)}-character header value budget`);
  }
  const handle = await open(path, READ_FLAGS).catch(() => refuse('could not be opened'));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino || problemOf(opened) !== undefined) {
      refuse('changed while it was opened');
    }
    // One byte past the limit shows a file that grew after the check
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
      if (filled > maxBytes) {
        refuse(`is over the ${String(maxLength)}-character header value budget`);
      }
    }
    const after = await handle.stat({ bigint: true });
    if (identityOf(after) !== identityOf(opened) || BigInt(filled) !== after.size) {
      refuse('changed while it was read (write it to a temp file and rename it into place)');
    }
    return { value: valueOf(buffer.subarray(0, filled), maxLength), identity: identityOf(named) };
  } finally {
    await handle.close();
  }
};

export const describeHeaderFileError = (path: string, error: unknown): string =>
  `the header file ${displayPath(path)} ${error instanceof HeaderFileError ? error.message : 'could not be read'}`;

export const createHeaderFileSource = (config: {
  name: string;
  path: string;
  maxLength: number;
  redactor: RuntimeRedactor;
  now: () => number;
}): HeaderFileSource => {
  const { path } = config;
  // Distinguishes this source's registrations from every other's
  const owner = {};
  let cached: HeaderFileRead | undefined;
  let stale = false;
  let inFlight: Promise<HeaderFileResult> | undefined;

  const reload = async (): Promise<HeaderFileResult> => {
    // Taken now, so a 401 that arrives during this read marks the value for
    // the next call; given back when this read fails
    const wasStale = stale;
    stale = false;
    let next: HeaderFileRead;
    try {
      const current = await lstat(path, { bigint: true }).catch(() => refuse('is missing'));
      if (cached !== undefined && !wasStale && identityOf(current) === cached.identity) {
        return { ok: cached.value };
      }
      next = await readHeaderFile(path, config.maxLength);
    } catch (error) {
      stale ||= wasStale;
      return { error: describeHeaderFileError(path, error) };
    }
    if (next.value !== cached?.value) {
      try {
        // Current values never expire; a replaced one stays redacted until
        // the shared registry needs its slot
        config.redactor.registerRuntimeSecret(
          next.value,
          Number.POSITIVE_INFINITY,
          config.now(),
          owner,
        );
      } catch {
        // Unredactable, or the registry is full: never send it
        stale ||= wasStale;
        return {
          error: `the header file ${displayPath(path)} could not be registered for redaction`,
        };
      }
      if (cached !== undefined) {
        config.redactor.retireRuntimeSecret(cached.value, owner);
      }
    }
    cached = next;
    return { ok: next.value };
  };

  return {
    name: config.name,
    path,
    read: async () => {
      if (inFlight !== undefined) {
        return await inFlight;
      }
      inFlight = reload();
      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
      }
    },
    stale: (value) => {
      if (cached?.value === value) {
        stale = true;
      }
    },
  };
};
