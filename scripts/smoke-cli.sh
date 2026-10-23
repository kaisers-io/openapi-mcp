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

# `serve` runs from a chunk the bin imports only when the action starts (issue
# kaisers-io/openapi-mcp-archive#91): start it over stdio and require an `initialize` answer, so a
# chunk missing from the tarball fails here.
node -e '
  const { spawn } = require("node:child_process");
  // On Windows the global bin is an npm `.cmd` shim, which Node only starts through a shell. With
  // `shell: true` an args array is joined unescaped (DEP0190 on Node 24), so the command goes in as
  // one string with every argument quoted; elsewhere the bin is spawned directly.
  const args = ["serve", "--spec", process.argv[1], "--base-url", "https://api.example.com"];
  const child = process.platform === "win32"
    ? spawn(args.reduce((command, arg) => `${command} "${arg}"`, "openapi-mcp"), { shell: true })
    : spawn("openapi-mcp", args);
  const timer = setTimeout(() => { console.error("serve smoke FAILED: no initialize answer"); child.kill(); process.exit(1); }, 15000);
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
    const line = out.split("\n")[0];
    if (!out.includes("\n")) return;
    clearTimeout(timer);
    const reply = JSON.parse(line);
    child.stdin.end();
    // Bump with the MCP SDK: LATEST_PROTOCOL_VERSION in @modelcontextprotocol/core
    if (reply.result?.protocolVersion !== "2025-11-25") {
      console.error("serve smoke FAILED:", line);
      process.exit(1);
    }
    console.log("serve smoke OK — initialize answered over stdio");
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }) + "\n");
' "$SPEC"
