// The cache's only contact with the filesystem. Core depends on this interface;
// the single real implementation lives in the CLI's realContext() so that
// realContext stays the only place touching node:fs.
export type CacheFs = {
  // Creates the directory and every missing parent at 0700, repairing the mode
  // on a directory that already exists
  mkdirSecure: (path: string) => Promise<void>;
  // Writes at 0600 via a temp file + rename, so the replace is atomic and the
  // mode is enforced even when the target already exists. It must also be
  // crash-durable before it resolves (temp fsynced before the rename, the
  // directory fsynced after it): the store's commit relies on one resolved
  // write being on disk before the next one starts.
  //
  // A rejection does NOT always mean the old content is intact. A failure
  // before the rename (create, write, file fsync, the rename itself) leaves
  // the previous target untouched. A failure after it (the directory fsync
  // reporting a real error such as EIO) rejects although the new content is
  // already in place: durability is unknown, and readers may see the new
  // content until a crash possibly reverts it. Callers must treat a rejection
  // as "state unknown", never as "nothing changed".
  writeFileAtomic: (path: string, data: string) => Promise<void>;
  // Cache files are untrusted input in the same way spec downloads are:
  // rejects with a validationError once maxBytes is exceeded, before the
  // contents are ever turned into a string
  readFileTextCapped: (path: string, maxBytes: number) => Promise<string>;
  // The same read, returning the raw bytes (kaisers-io/openapi-mcp-archive#88).
  // Optional: when present the store hashes these bytes directly instead of
  // decoding them and hashing the re-encoded text. Fail-closed behaviour is
  // identical either way: invalid UTF-8 changes the raw-byte hash just as
  // decoding to U+FFFD changed the re-encoded one.
  readFileBytesCapped?: (path: string, maxBytes: number) => Promise<Uint8Array>;
  readDirNames: (path: string) => Promise<readonly string[]>;
  removeDir: (path: string) => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
  // Exclusive create; resolves false when the path already exists. This is the
  // primitive the per-namespace writer lock is built on.
  createExclusive: (path: string, data: string) => Promise<boolean>;
  // Tolerates a missing path — removing an already-absent file is not an error
  removeFile: (path: string) => Promise<void>;
  // The file's last-modification time in epoch ms (lstat, never following a
  // symlink). Optional: only the collection of stale lock temps needs it, and
  // without it those are simply left in place
  // (kaisers-io/openapi-mcp-archive#88).
  modifiedAtMs?: (path: string) => Promise<number>;
  // The running process, for the writer lock
  // (kaisers-io/openapi-mcp-archive#65). Optional so a fake filesystem needs
  // none of it: without it the lock record carries no pid/hostname and a held
  // lock is reported after a single attempt.
  runtime?: CacheRuntime;
};

// Core takes no process globals: the lock's view of "this process" is
// injected here by the CLI's realContext, like the filesystem itself.
export type CacheRuntime = {
  pid: number;
  hostname: string;
  // Whether `pid` names a live process on THIS host (process.kill(pid, 0)).
  // Only meaningful for a record whose hostname matches ours.
  isProcessAlive: (pid: number) => boolean;
  // Backoff between lock acquisition attempts
  sleep: (ms: number) => Promise<void>;
  // How long a strict write may wait for the writer lock before reporting a
  // conflict; never less than the built-in ~2 s schedule (lockRetrySchedule).
  // The spec pipeline sets it from --timeout.
  lockWaitMs?: number;
};
