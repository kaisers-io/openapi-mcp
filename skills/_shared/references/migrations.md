# Migrations

How to move a server entry from an older `openapi-mcp` version to a newer one. Details:
[CHANGELOG.md](https://github.com/kaisers-io/openapi-mcp/blob/main/CHANGELOG.md).

## Procedure

1. Read every section between the configured and the target version in the CHANGELOG at the
   target tag. The tables below cover the changes that touch a server entry.
2. Run the old and the new version with the entry's spec and filter options, each with a
   throwaway home (`HOME="$(mktemp -d)"`, Windows: `USERPROFILE`). The old version needs its
   old patterns:

   ```sh
   npx -y @kaisers-io/openapi-mcp@OLD --json tools --spec <spec> <filters>
   npx -y @kaisers-io/openapi-mcp@NEW --json tools --spec <spec> <filters> --strict-filters
   ```

3. Compare the tool names of the two runs and show the user what the update adds or removes.
   "Keep what it may do" means the same tool names. If the old version cannot run, say that
   you could not compare, instead of claiming the set is unchanged.
4. Apply the changes below, run `CLI --json check` with the new version, and show the new
   entry before writing it.
5. Give your answer a section "Changes without an error" with one line for every row of that
   table between the two versions, even when the tool names did not change:

   ```
   - 0.5.0, selectors ignore letter case: no effect here, the tool names are the same
   ```

## Changes the CLI reports

The new version stops with an error that names the replacement. Apply it.

| Version | Old | New |
|---|---|---|
| 0.7.1 | a spec URL with `--header-env` or `--basic-auth-env` and no `--base-url` | add `--base-url <API base URL>`; take it from the spec's `servers` and ask the user to confirm it |
| 0.7.1 | `--spec-header-env` with an `http://` spec URL to a host that is not loopback | an `https://` spec URL; `--allow-insecure-http` only if the spec has no other address and the user agrees |
| 0.7.0 | `--api execute=<source>` | another API name: `execute` is reserved, like `call` and `search` |
| 0.5.0 | `--deny "DELETE /**"` | `--deny "method:delete"` |
| 0.5.0 | `--allow "GET /orders/**"` | `--allow "route:GET /orders/**"` |
| 0.5.0 | `--allow "**"` | `--allow "operationId:*"` (the same operations); `path:/**` also exposes operations without an operationId |
| 0.5.0 | `--allow "read*"` | `--allow "operationId:read*"` |

## Changes without an error

These change behavior silently. Check each one that applies and tell the user.

| Version | Change | What to do |
|---|---|---|
| Unreleased | A response `pattern` that nests quantifiers or that RE2 cannot run no longer withholds the output schema. Only that keyword is left out; the field description ends with `Pattern (not enforced): <pattern>`. The server checks the other patterns with RE2. | Nothing in the config. `tools` no longer shows `outputSchemaWithheld` for such a tool. |
| 0.7.1 | An operation with a control or bidirectional-override character in a parameter or property name, `enum`, `const`, `pattern` or `format` of its input schema is no longer a tool. | Compare the tool names of both versions; `tools` names the operation under `notExposed`. The spec needs a change. |
| 0.7.1 | A tool gets no output schema and returns text when its response schema has such a character, or a `pattern` with more than 64 ways to split a match, such as `^([a-z0-9]{1,63}\.?){1,8}$`. | Nothing in the config. |
| 0.7.1 | `--allow-private-network` no longer admits link-local addresses (`169.254.0.0/16`, `fe80::/10`). Calls to them fail with `not allowed by the egress policy`. | No flag admits them. Ask the user for an address of the API outside these ranges. |
| 0.7.1 | A `_fields` selection larger than twice the response plus 64 KiB fails with an error. | Nothing in the config. The agent selects fewer fields. |
| 0.7.1 | A refreshed spec over the 64 MiB cache budget keeps the last accepted spec serving, with the `spec refresh failed` warning, instead of stopping the command. | Nothing in the config. Tell the user the spec no longer updates. |
| 0.7.1 | More results that echo a registered secret are withheld: a secret as a JSON number, in other JSON escapes (`\u0026`) or as markup entities (`&amp;`). | Nothing in the config. |
| 0.7.0 | Every tool mode lists one more tool, `execute_code`: it runs a short program the agent writes, over read-only operations only. Host permissions stored by tool name see a new tool. | Nothing in the config. `--no-execute` keeps the earlier tool list. |
| 0.7.0 | The 512-tool limit counts the tools that are built, not the operations the filters pass: an operation omitted as not supported no longer counts. | Nothing in the config. A filter set that failed with `exceeds the 512-tool budget` may start now; run `CLI --json check`. |
| 0.6.1 | A `HEAD` operation whose `GET` on the same path is not exposed is no longer a tool; its calls were always refused. | Nothing in the config; allow the `GET` too if the user needs the `HEAD`. |
| 0.6.0 | `--tool-mode auto` also picks `discover` when the tool definitions take more than 40,000 bytes. | Run `CLI --json check`; if it now reports `discover` and the user wants approval per tool, set `--tool-mode per-operation`. |
| 0.5.0 | Every selector ignores letter case. In `operationId:`, `name:` and `tag:` patterns, `*` also matches `/`. | Compare the tools of both versions; an `--allow` can expose more, a `--deny` can exclude more. |
| 0.5.0 | A redirect that leaves the API base URL, or goes to a path with no operation, is not followed. | If the API redirects to another host, for example for downloads, add `--allow-offsite-redirects` after the user agrees. |
| 0.5.0 | `describe_operation` leaves out the output schema unless the agent asks for it. | Nothing in the config. |
| 0.4.0 | Some generated tool names changed (only `A-Z a-z 0-9 _ -`; `repos.get` became `repos_get`). | Host permissions stored by tool name need approval again. |
| 0.4.0 | `--timeout` no longer covers API calls. | Move a raised `--timeout` meant for slow API calls to `--request-timeout`. |
| 0.4.0 | New limits: `--max-concurrency 16`, `--rate-limit 120/1m`. | Raise them only if calls fail with `overloaded` or `rate_limited`. |

Versions before 0.4.0 have no migration notes. Read their CHANGELOG sections.
