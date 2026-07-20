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

export const memoryCacheFs = (roots: readonly string[] = ['/cache']): MemoryCacheFs => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(roots);
  return {
    files,
    dirs,
    mkdirSecure: (path) => {
      for (const dir of ancestors(path)) {
        dirs.add(dir);
      }
      return Promise.resolve();
    },
    writeFileAtomic: (path, data) => {
      const parent = dirname(path);
      if (!dirs.has(parent)) {
        return Promise.reject(absenceError(parent));
      }
      files.set(path, data);
      return Promise.resolve();
    },
    readFileTextCapped: (path, maxBytes) => {
      const found = files.get(path);
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
      if (!dirs.has(path)) {
        return Promise.reject(absenceError(path));
      }
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
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
      for (const key of files.keys()) {
        if (key === path || key.startsWith(prefix)) {
          files.delete(key);
        }
      }
      for (const key of dirs) {
        if (key === path || key.startsWith(prefix)) {
          dirs.delete(key);
        }
      }
      return Promise.resolve();
    },
    pathExists: (path) => Promise.resolve(files.has(path) || dirs.has(path)),
    createExclusive: (path, data) => {
      // The real implementation opens with 'wx', which fails EEXIST — and
      // therefore resolves false — for an existing directory just as much as
      // an existing file. Refusing on files.has alone would let a store bug
      // that mishandles a directory at the target path pass against the fake.
      if (files.has(path) || dirs.has(path)) {
        return Promise.resolve(false);
      }
      const parent = dirname(path);
      if (!dirs.has(parent)) {
        return Promise.reject(absenceError(parent));
      }
      files.set(path, data);
      return Promise.resolve(true);
    },
    removeFile: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
  };
};
