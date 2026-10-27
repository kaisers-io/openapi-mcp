# Spec updates and the cache

`openapi-mcp` keeps a copy of every OpenAPI description it has accepted, and it does not start
using a changed description until you approve it. This page explains how that cache works, how
a refresh is decided, and how you review and accept an update. Read it when you serve an API
whose description changes, or when a warning tells you a candidate is waiting. The exact flags
of the `cache` subcommands are in [configuration.md](configuration.md#cache).

## Where the cache lives

The server stores specs under `~/.kaisers-io/openapi-mcp/cache/<namespace>/` in your home
directory. `serve`, `check` and `tools` all read and write this cache. The namespace is a hash
of the spec source and, when you pass one, the `--cache-key`. The cache never holds credentials,
headers or a URL's query string. For display it keeps only the origin and path of the source.

If no home directory is available, the server fetches the spec fresh on every start and writes
nothing to disk, with a warning.

## When the server checks for a new version

A spec from a URL is used straight from the cache until its time to live (TTL) has expired.
After that the server re-validates it at the next start. `--ttl` sets the TTL; the default is
`1h` and the maximum is `365d`. The server re-validates with a conditional request (`ETag` or
`Last-Modified`). When the source supports these, an unchanged spec comes back as a short
`304 Not Modified` answer instead of the whole document.

A local file is read and hashed on every start, whatever the TTL. While its bytes match the
accepted version, the server uses the cached, already validated document instead of parsing the
file again.

A running server does not refresh its tool list. Restart it to pick up a newer spec.

If a refresh fails, because the network is down or the new document is invalid, the server keeps
serving the last accepted version and prints a warning that starts with
`spec refresh failed, serving the last known good accepted baseline`.

## How a changed spec is handled

The refresh is fail-closed. That means a change never takes effect on its own. The cache holds
two things per namespace:

- the *accepted baseline*, the version the server serves, and
- at most one *pending candidate*, a newer version waiting for your decision.

The first time the server sees a spec, it accepts it as the baseline. After that, a changed spec
is validated and stored as the candidate only. The server keeps serving the baseline and warns:

```text
openapi-mcp: warning: the spec source changed; the refreshed spec is stored as a candidate awaiting "openapi-mcp cache promote"
```

This holds for a URL and for a local file you edit. If the source later returns to the accepted
content, the server clears the candidate.

### Removed operations are withheld at once

The one change the server applies without waiting is a removal. While a candidate waits, every
accepted operation that the candidate no longer has is withheld, on every start. Removing a tool
can only narrow what a model may do, so this is the safe direction. The server lists the
withheld operations in a warning:

```text
openapi-mcp: warning: 1 operation(s) removed in the pending candidate spec are withheld until "openapi-mcp cache promote": GET /pets (listPets)
```

The `openapi_mcp_status` tool also counts them under `notExposedCounts.withheld` and lists them
in `omittedReasons`.

The server matches operations by method and path:

- Operations present in both versions keep their accepted definition.
- Path parameter names do not count. `/pets/{petId}` and `/pets/{id}` are the same operation.
- `servers` is not compared. A candidate that only moves the base path, say from `/v1` to `/v2`,
  withholds nothing, and the move waits for promotion like any other change.

Everything else waits for your decision: new tools, changed descriptions or input schemas,
changes to a method, path or base URL, and changes to an authentication scheme.

If the candidate would expose more operations under the current filters than the tool mode
allows (512 in `per-operation` mode, 4096 in `discover` and `auto`), the server warns, because
it would refuse to start after `cache promote`. See [tool-modes.md](tool-modes.md).

## Reviewing and accepting an update

```bash
openapi-mcp cache list                                  # list entries + opaque ids
openapi-mcp cache refresh --spec <url|file>              # force a refetch, write a candidate
openapi-mcp cache promote --spec <url|file>               # accept the candidate as baseline
openapi-mcp cache clear --spec <url|file>                 # drop a cache entry
openapi-mcp cache unlock --spec <url|file>                # remove a stale writer lock
```

`cache list` shows each entry with its id, its `--cache-key`, the accepted content hash and, when
one waits, the candidate hash marked `(pending promotion)`. Before you promote, review the new
description at its source. `openapi-mcp tools` with your usual flags shows what the server
exposes now, with the same warnings as `serve`, including the withheld operations.

`cache promote --hash <digest>` promotes only if the candidate still has that content hash. This
protects you from accepting a candidate that a concurrent refresh replaced after you reviewed it.

Pass the same `--spec` and `--cache-key` to the `cache` subcommands that the server uses.
Otherwise they address a different namespace. `cache clear` and `cache unlock` also accept the
entry id from `cache list` with `--id`.

If a cache entry is damaged, the server does not silently download the spec again, because that
would accept whatever the source serves now. It stops with an error that tells you to run
`openapi-mcp cache clear`, so a reset is always your deliberate choice.

## Accepting updates automatically

`--trust-spec-updates` accepts a refreshed spec directly instead of storing it as a candidate.
Use it for an API you own and control, not for a third-party one. It also works with
`cache refresh`.

## The cache key rule

`--cache-key <name>` is required for any spec fetched with `--spec-header-env`, that is, an
authenticated spec, unless you pass `--trust-spec-updates` instead. Passing neither is a startup
usage error (exit code 2):

```text
openapi-mcp: an authenticated spec source (--spec-header-env) requires an explicit cache decision: pass --cache-key <name> for a durable, credential-scoped baseline, or --trust-spec-updates to accept refreshed specs automatically without persisting a baseline
```

There are two reasons for the rule. Two host entries that fetch the same URL with different
credentials must never share cache state, and without a key the namespace depends only on the
URL. A durable baseline is also what makes the approval step mean something across restarts.

With `--trust-spec-updates` and no `--cache-key`, an authenticated spec bypasses the cache
completely for that run. The server fetches it fresh and writes nothing.

A cache key may contain letters, digits, `.`, `_` and `-`, up to 64 characters. Use one key per
API and credential, for example `petstore-prod`.
