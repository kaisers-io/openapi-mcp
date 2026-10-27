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
| 0.5.0 | `--deny "DELETE /**"` | `--deny "method:delete"` |
| 0.5.0 | `--allow "GET /orders/**"` | `--allow "route:GET /orders/**"` |
| 0.5.0 | `--allow "**"` | `--allow "operationId:*"` (the same operations); `path:/**` also exposes operations without an operationId |
| 0.5.0 | `--allow "read*"` | `--allow "operationId:read*"` |

## Changes without an error

These change behavior silently. Check each one that applies and tell the user.

| Version | Change | What to do |
|---|---|---|
| Unreleased | `--tool-mode auto` also picks `discover` when the tool definitions take more than 40,000 bytes. | Run `CLI --json check`; if it now reports `discover` and the user wants approval per tool, set `--tool-mode per-operation`. |
| 0.5.0 | Every selector ignores letter case. In `operationId:`, `name:` and `tag:` patterns, `*` also matches `/`. | Compare the tools of both versions; an `--allow` can expose more, a `--deny` can exclude more. |
| 0.5.0 | A redirect that leaves the API base URL, or goes to a path with no operation, is not followed. | If the API redirects to another host, for example for downloads, add `--allow-offsite-redirects` after the user agrees. |
| 0.5.0 | `describe_operation` leaves out the output schema unless the agent asks for it. | Nothing in the config. |
| 0.4.0 | Some generated tool names changed (only `A-Z a-z 0-9 _ -`; `repos.get` became `repos_get`). | Host permissions stored by tool name need approval again. |
| 0.4.0 | `--timeout` no longer covers API calls. | Move a raised `--timeout` meant for slow API calls to `--request-timeout`. |
| 0.4.0 | New limits: `--max-concurrency 16`, `--rate-limit 120/1m`. | Raise them only if calls fail with `overloaded` or `rate_limited`. |

Versions before 0.4.0 have no migration notes. Read their CHANGELOG sections.
