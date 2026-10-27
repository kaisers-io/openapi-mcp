# Several APIs

One server can serve up to 32 APIs. Details:
[docs/configuration.md, Several APIs](https://github.com/kaisers-io/openapi-mcp/blob/main/docs/configuration.md#several-apis).

## One server or several

Recommend one server entry per API and environment when the APIs belong to different accounts
or when the user wants to switch one off on its own. Recommend one server with `--api` when the
agent uses the APIs together and the user wants one entry.

## Syntax

- `--api <name>=<source>` declares an API. Names are lower case, start with a letter, use
  `a-z`, `0-9` and `-`, and are at most 32 characters. `openapi`, `search`, `describe` and
  `call` are reserved.
- Every per-API option starts with the name: `--allow shop=tag:Orders`,
  `--header-env shop=Authorization=SHOP_TOKEN`, `--base-url shop=https://shop.example.test`.
- Switches use `--enable <name>=<switch>`, for example `--enable shop=allow-private-network`.
- A `--deny` without a name applies to every API.
- `--spec` and `--api` cannot be combined.
- Tool names become `<api>_<name>`. Patterns with `name:` still use the API's own names.

`CLI --json help` marks each option with `perApi`: `prefix` needs the name, `prefix-or-all`
works with or without it, `enable` is a switch.

## Checks

`CLI --json check` fails when two APIs have overlapping base URLs, or load the same spec with
the same `--cache-key`. Give each API its own `--cache-key` then.

Credentials stay with their API: a header of one API is never sent to another one's base URL.
