#!/usr/bin/env bash
set -euo pipefail
# Paths below are repo-root relative — make invocation from any subdirectory work.
cd "$(git rev-parse --show-toplevel)"

# `dist/` is build output (gitignored, not committed) — there is nothing to diff it
# against. Instead, this proves the build itself is reproducible: build twice in a row and require
# byte-identical output (compared via sha256 through node so it is portable across CI's ubuntu/macos
# runners without depending on either `sha256sum` (Linux) or `shasum` (macOS)).
# The bundle is the entry plus the chunks its dynamic imports split off (issue #91): hash every
# file name and its bytes, so a renamed or changed chunk counts as non-determinism too.
BUNDLE="packages/cli/dist"

hash_bundle() {
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync, readdirSync } = require("node:fs");
    const hash = createHash("sha256");
    // Recursive, files only: a future subdirectory (source maps, assets) is hashed, not EISDIR
    const files = readdirSync(process.argv[1], { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath}/${entry.name}`.slice(process.argv[1].length + 1))
      .sort();
    for (const name of files) {
      hash.update(name).update("\0").update(readFileSync(`${process.argv[1]}/${name}`)).update("\0");
    }
    process.stdout.write(hash.digest("hex"));
  ' "$BUNDLE"
}

pnpm build
FIRST="$(hash_bundle)"

rm -rf "$BUNDLE"
pnpm build
SECOND="$(hash_bundle)"

if [ "$FIRST" != "$SECOND" ]; then
  echo "bundle build is not deterministic — two consecutive 'pnpm build' runs produced a" >&2
  echo "different $BUNDLE/ (sha256 $FIRST vs $SECOND)" >&2
  exit 1
fi

echo "bundle build is deterministic (sha256 $FIRST)"
