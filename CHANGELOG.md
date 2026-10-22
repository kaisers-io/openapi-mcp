# Changelog

## Unreleased

### Performance

- **Faster starts after the first run, slower first run (#76).** The OpenAPI meta-schema
  validators are precompiled, and the CLI now enables Node's V8 compile cache in
  `~/.kaisers-io/openapi-mcp/compile-cache/` (created `0700`). Every later start is faster,
  e.g. `--version` 220 → 149 ms and `tools --spec petstore.json` 413 → 199 ms. The **first**
  run per user writes the cache and is slower (`--version` about 191 → 237 ms). MCP hosts
  that start the server in a fresh container or CI job, with no persistent home directory,
  pay that first-run cost on every start. `NODE_DISABLE_COMPILE_CACHE=1` turns the cache off.
