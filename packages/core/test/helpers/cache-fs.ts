import { dirname } from 'node:path';
import { type CacheFs, validationError } from '../../src/index.ts';

export interface MemoryCacheFs extends CacheFs {
  files: Map<string, string>;
  dirs: Set<string>;
}

const ancestors = (path: string): readonly string[] => {
  const collected: string[] = [];
  let current = path;
  while (current !== dirname(current)) {
    collected.push(current);
    current = dirname(current);
  }
  return collected;
};

// Node attaches a `code` to filesystem errors and the store branches on it
// (isCacheAbsence). A fake that omits it silently changes every absence
// decision, so this models it (round-7 finding 4).
const absenceError = (path: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: 'ENOENT',
  });

// Every method below reads and writes through `self.files` / `self.dirs`
// rather than closing over the initial Map/Set bindings directly. That is
// deliberate: several Task 3 store tests simulate "a later, independent
// process observing the same on-disk state" by constructing a second
// `memoryCacheFs()` and reassigning its `files`/`dirs` properties to alias an
// existing instance's (`clean.files = fs.files`). A fake whose closures
// captured the original local bindings would silently keep operating on its
// own now-orphaned, empty Map/Set after such a reassignment — every write
// would land somewhere the test can no longer see, while reads of the
// aliased property would show a stale snapshot. Dereferencing through `self`
// on every call makes the property the single source of truth, so
// reassigning it actually redirects subsequent operations, matching what the
// tests assume.
export const memoryCacheFs = (roots: readonly string[] = ['/cache']): MemoryCacheFs => {
  const self: MemoryCacheFs = {
    files: new Map<string, string>(),
    dirs: new Set<string>(roots),
    mkdirSecure: (path) => {
      for (const dir of ancestors(path)) {
        self.dirs.add(dir);
      }
      return Promise.resolve();
    },
    writeFileAtomic: (path, data) => {
      const parent = dirname(path);
      if (!self.dirs.has(parent)) {
        return Promise.reject(absenceError(parent));
      }
      self.files.set(path, data);
      return Promise.resolve();
    },
    readFileTextCapped: (path, maxBytes) => {
      const found = self.files.get(path);
      if (found === undefined) {
        // Round-7 finding 4: the fake must be FAITHFUL to Node. Without a
        // `code`, isCacheAbsence answers false and every genuine-absence branch
        // in the store misclassifies — the promotion complement expected
        // conflict exit 5 and would have got validation exit 3.
        return Promise.reject(absenceError(path));
      }
      const byteLength = Buffer.byteLength(found, 'utf8');
      if (byteLength > maxBytes) {
        return Promise.reject(
          validationError(
            `cache file "${path}" is ${byteLength} bytes — exceeds the ${maxBytes}-byte budget`,
          ),
        );
      }
      return Promise.resolve(found);
    },
    readDirNames: (path) => {
      if (!self.dirs.has(path)) {
        return Promise.reject(absenceError(path));
      }
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of [...self.files.keys(), ...self.dirs]) {
        if (key.startsWith(prefix)) {
          const [head] = key.slice(prefix.length).split('/');
          if (head !== undefined) {
            names.add(head);
          }
        }
      }
      return Promise.resolve([...names]);
    },
    removeDir: (path) => {
      const prefix = `${path}/`;
      for (const key of self.files.keys()) {
        if (key === path || key.startsWith(prefix)) {
          self.files.delete(key);
        }
      }
      for (const key of self.dirs) {
        if (key === path || key.startsWith(prefix)) {
          self.dirs.delete(key);
        }
      }
      return Promise.resolve();
    },
    pathExists: (path) => Promise.resolve(self.files.has(path) || self.dirs.has(path)),
    createExclusive: (path, data) => {
      // The real implementation opens with 'wx', which fails EEXIST — and
      // therefore resolves false — for an existing directory just as much as
      // an existing file. Refusing on files.has alone would let a store bug
      // that mishandles a directory at the target path pass against the fake.
      if (self.files.has(path) || self.dirs.has(path)) {
        return Promise.resolve(false);
      }
      const parent = dirname(path);
      if (!self.dirs.has(parent)) {
        return Promise.reject(absenceError(parent));
      }
      self.files.set(path, data);
      return Promise.resolve(true);
    },
    removeFile: (path) => {
      self.files.delete(path);
      return Promise.resolve();
    },
  };
  return self;
};
