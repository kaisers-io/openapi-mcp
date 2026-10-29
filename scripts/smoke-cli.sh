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

# Windows: the same spec as an absolute drive path with backslashes (`C:\...\tmp.x`), the form a
# user writes in a host config. Git Bash would rewrite a POSIX path on its own, so `cygpath -w`
# gives the native spelling and MSYS_NO_PATHCONV keeps bash from touching it.
if command -v cygpath > /dev/null; then
  NATIVE="$(cygpath -w "$SPEC")"
  case "$NATIVE" in
    [A-Za-z]:\\*) ;;
    *) echo "drive path smoke FAILED: $NATIVE is not a drive path" >&2; exit 1 ;;
  esac
  if ! OUT="$(MSYS_NO_PATHCONV=1 openapi-mcp --json tools --spec "$NATIVE")"; then
    echo "drive path smoke FAILED: $OUT" >&2
    exit 1
  fi
  node -e '
    const o = JSON.parse(process.argv[1]);
    if (!o.ok || o.data.toolCount !== 1) {
      console.error("drive path smoke FAILED:", JSON.stringify(o));
      process.exit(1);
    }
    console.log("drive path smoke OK —", process.argv[2]);
  ' "$OUT" "$NATIVE"
fi

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

# execute_code (issue #60) runs scripts in a worker loaded from its own bundle entry
# (dist/execute-worker.mjs): run one script, so a worker file missing from the tarball, or one that
# does not load on this platform, fails here.
node -e '
  const { spawn } = require("node:child_process");
  const args = ["serve", "--spec", process.argv[1], "--base-url", "https://api.example.com", "--tool-mode", "discover"];
  const child = process.platform === "win32"
    ? spawn(args.reduce((command, arg) => `${command} "${arg}"`, "openapi-mcp"), { shell: true })
    : spawn("openapi-mcp", args);
  const timer = setTimeout(() => { console.error("execute smoke FAILED: no answer"); child.kill(); process.exit(1); }, 30000);
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
    for (const line of out.split("\n").slice(0, -1)) {
      const reply = JSON.parse(line);
      if (reply.id === 1) {
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/call", params: { name: "execute_code", arguments: { code: "return [1, 2, 3].reduce((a, b) => a + b);" } } });
      }
      if (reply.id === 2) {
        clearTimeout(timer);
        child.stdin.end();
        if (reply.result?.structuredContent?.result !== 6) {
          console.error("execute smoke FAILED:", line);
          process.exit(1);
        }
        console.log("execute smoke OK — a script ran in the bundled worker");
      }
    }
    out = out.slice(out.lastIndexOf("\n") + 1);
  });
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
' "$SPEC"
