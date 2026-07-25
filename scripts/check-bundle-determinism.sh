#!/usr/bin/env bash
set -euo pipefail
# Paths below are repo-root relative — make invocation from any subdirectory work.
cd "$(git rev-parse --show-toplevel)"

# `dist/openapi-mcp.mjs` is build output (gitignored, not committed) — there is nothing to diff it
# against. Instead, this proves the build itself is reproducible: build twice in a row and require
# byte-identical output (compared via sha256 through node so it is portable across CI's ubuntu/macos
# runners without depending on either `sha256sum` (Linux) or `shasum` (macOS)).
BUNDLE="packages/cli/dist/openapi-mcp.mjs"

hash_bundle() {
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
  ' "$BUNDLE"
}

pnpm build
FIRST="$(hash_bundle)"

rm -f "$BUNDLE"
pnpm build
SECOND="$(hash_bundle)"

if [ "$FIRST" != "$SECOND" ]; then
  echo "bundle build is not deterministic — two consecutive 'pnpm build' runs produced a" >&2
  echo "different $BUNDLE (sha256 $FIRST vs $SECOND)" >&2
  exit 1
fi

echo "bundle build is deterministic (sha256 $FIRST)"
