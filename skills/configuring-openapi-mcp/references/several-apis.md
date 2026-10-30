# Several APIs

One server can serve up to 32 APIs. Details:
[docs/several-apis.md](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/several-apis.md).

## One server or several

Recommend one server entry per API and environment when the APIs belong to different accounts
or when the user wants to switch one off on its own. Recommend one server with `--api` when the
agent uses the APIs together and the user wants one entry.

## Syntax

- `--api <name>=<source>` declares an API. Names are lower case, start with a letter, use
  `a-z`, `0-9` and `-`, and are at most 32 characters. `openapi`, `search`, `describe`,
  `call` and `execute` are reserved.
- Every per-API option starts with the name: `--allow shop=tag:Orders`,
  `--header-env shop=Authorization=SHOP_TOKEN`, `--base-url shop=https://shop.example.test`.
- Switches use `--enable <name>=<switch>`, for example `--enable shop=allow-private-network`.
- A `--deny` without a name applies to every API.
- `--spec` and `--api` cannot be combined, and `--enable` needs `--api`.
- A per-API value without a declared `<name>=` fails with `does not start with the name of an
  API`. A per-API scalar such as `--base-url` is given once per API.
- A switch without a name, such as `--allow-private-network`, fails with
  `cannot be used with --api`: it must name the API that needs it.
- Tool names become `<api>_<name>`. Patterns with `name:` still use the API's own names. Names
  over 50 characters cause a warning, since hosts add their own prefix and accept 64; shorter
  API names or `--tool-mode discover` avoid it.

`CLI --json help` marks each option with `perApi`: `prefix` needs the name, `prefix-or-all`
works with or without it, `enable` is a switch.

## Checks

`CLI --json check` fails when two APIs have overlapping base URLs (one base path inside the
other on the same host), or load the same spec with the same `--cache-key`. Give each API its
own `--cache-key` or `--base-url` then. It also fails when all APIs together have more than 64
secrets or more than 512 tools under `per-operation` (4,096 under `discover`). One
`--rate-limit` and one `--max-concurrency` cover all APIs of a server.

Credentials stay with their API: a header of one API is never sent to another one's base URL.

One `execute_code` program can read from every API of the server, for example orders from one
and the matching customers from another. Each call keeps its own API's credentials and filters.
