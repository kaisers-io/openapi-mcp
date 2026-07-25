#!/usr/bin/env bash
set -euo pipefail
# Deep smoke of the globally-installed `openapi-mcp` (the MINIFIED bundle): the bin stub loads
# dist/openapi-mcp.mjs — the only code in the published tarball — so this exercises the SHIPPED
# minified artifact, which the unit suite (run against TypeScript source) never touches. Assumes
# `openapi-mcp` is already on PATH (each caller installs the packed tarball its own way first).

openapi-mcp --version
openapi-mcp --json doctor

# `tools --spec` drives the full spec pipeline (load, validate, normalize, tool generation) through
# the minified bundle — the deepest offline smoke short of starting a server.
SPEC="$(mktemp)"
cat > "$SPEC" <<'JSON'
{
  "openapi": "3.1.0",
  "info": { "title": "Smoke", "version": "1.0.0" },
  "servers": [{ "url": "https://api.example.com" }],
  "paths": {
    "/ping": {
      "get": { "operationId": "getPing", "summary": "ping", "responses": { "200": { "description": "ok" } } }
    }
  }
}
JSON
OUT="$(openapi-mcp --json tools --spec "$SPEC")"
node -e '
  const o = JSON.parse(process.argv[1]);
  if (!o.ok || o.data.toolCount !== 1 || !o.data.tools.some((t) => t.name === "getPing")) {
    console.error("tools smoke FAILED:", JSON.stringify(o));
    process.exit(1);
  }
  console.log("tools smoke OK — generated:", o.data.tools.map((t) => t.name).join(", "));
' "$OUT"
