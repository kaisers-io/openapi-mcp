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
  readDirNames: (path: string) => Promise<readonly string[]>;
  removeDir: (path: string) => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
  // Exclusive create; resolves false when the path already exists. This is the
  // primitive the per-namespace writer lock is built on.
  createExclusive: (path: string, data: string) => Promise<boolean>;
  // Tolerates a missing path — removing an already-absent file is not an error
  removeFile: (path: string) => Promise<void>;
};
