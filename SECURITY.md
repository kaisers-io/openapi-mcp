# Security policy

## Reporting a vulnerability

Please report security issues through
[GitHub's private vulnerability reporting](https://github.com/kaisers-io/openapi-mcp/security/advisories/new).
That keeps the report private until a fix is available, and it does not require an email
exchange.

**Please do not open a public issue for a security problem.**

You can expect an initial response within a week. If a report is confirmed, the fix ships in a
patch release and the advisory is published once users have had a chance to upgrade. Reporters are
credited unless they ask not to be.

A useful report names the `openapi-mcp` version (`openapi-mcp --version`), the command line (with
secrets replaced by placeholders), and the smallest spec that reproduces the problem.

## Supported versions

Only the latest released version receives security fixes. `openapi-mcp` is pre-1.0 and moves
quickly; there are no long-term support branches. The README's host examples pin an exact version,
so upgrading after a fix means bumping that pin in your MCP host's configuration.

## The security model

[`docs/security.md`](docs/security.md) is the full threat model: what the tool defends by default,
what an operator opts into, and what stays the operator's responsibility. This page only sorts
reports into in scope and out of scope. A behaviour that `docs/security.md` documents as a limit is
not a vulnerability, but a way around a guarantee it states is.

## What is in scope

- **Credential leakage.** Secrets are read only from environment variables (`--header-env`,
  `--spec-header-env`, `--http-token-env`, `--upstream-oauth-client-*-env`) and pass through a
  central redactor. A secret, an upstream OAuth access token, or one of the encoded variants the
  redactor covers reaching argv, the spec cache, a log line, a tool schema, a tool result, an error
  message, `doctor` or `--json` output is in scope.
- **Egress (SSRF).** An origin taken from the spec (`servers`) or from a redirect reaching a
  loopback, link-local, private or cloud-metadata address without `--allow-private-network`; a
  cloud-metadata address reached even with it; a way around the per-connection DNS pinning; an
  authentication header forwarded across an origin change on redirect; or an operator credential
  sent over plain `http://` to a remote host without `--allow-insecure-http`.
- **The spec cache as a trust store.** A refreshed spec changing what a model can do (new tools,
  changed descriptions or input schemas, a method, path, base-URL or auth-scheme change) without
  `openapi-mcp cache promote` or `--trust-spec-updates`; a damaged or unverifiable cache entry being
  used instead of failing closed; another local user reading or planting cache entries, whether
  through the `0700`/`0600` modes on Linux and macOS or, on Windows, under a standard user profile
  whose inherited access control list the cache relies on.
- **Hostile spec text reaching the MCP client.** Spec-derived text that bypasses sanitisation
  (control or bidirectional-override characters) or the length caps on its way into a tool
  definition, spec text that reaches the server's `instructions`, or a spec that gets past the
  parsing budgets (YAML aliases, `$ref` depth and expansion, operation and tool counts) to exhaust
  CPU or memory.
- **Filtering.** An operation that the read-only default, `--allow` or `--deny` excludes becoming
  callable, directly or through `call_operation` in `--tool-mode discover`.
- **HTTP transport authentication.** Reaching a tool without a valid bearer token in the default
  `--http` mode, a way around the `Host`/`Origin` checks that guard against DNS rebinding, and,
  with `--http-auth oauth`, a JWT accepted despite a wrong signature, algorithm (`none`, `HS*`),
  issuer, audience, expiry or required scope, a key fetched outside the egress policy, or the
  client's access token being forwarded upstream.
- **Supply chain of the published package.** `@kaisers-io/openapi-mcp` ships a fixed file set (the
  bin stub, the bundle under `dist/`, `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md`),
  has no runtime dependencies and no install-time lifecycle script, and is published from
  `.github/workflows/release.yml` through npm Trusted Publishing with no long-lived token. An
  unexpected file or dependency in the tarball, an install script, or a mismatch between the
  published package and this repository is in scope.

## What is not in scope

**The spec source is trusted by design.** `openapi-mcp` interprets the document you point it at.
Sanitisation removes control characters and caps length, but it cannot tell a legitimate operation
description from a prompt-injection payload written in plain English. Treat spec text as untrusted
content in the model's context, and only point `--spec` at a source you trust. A report that a
spec you chose can put persuasive prose in front of a model describes this documented limit, not a
vulnerability.

Similarly out of scope:

- Behaviour an operator opts into: `--allow` exposing write operations, `--base-url` or
  `--allow-private-network` reaching private addresses, `--trust-spec-updates`,
  `--allow-insecure-http`, and one host approval of `call_operation` covering every exposed
  operation in `--tool-mode discover`.
- A secret passed through `--header` under a name outside the documented deny-list. The deny-list
  catches common names; `--header-env` is the channel for secrets.
- Limits `docs/security.md` states, such as the regular-expression heuristic for response
  schemas, the process-wide rate limit and concurrency cap shared by every OAuth caller, one
  upstream identity for every caller, and trace propagation being on by default.
- Anything that requires an attacker to already control the machine or the user account
  `openapi-mcp` runs as, including root, `SYSTEM` or an administrator reading the cache, and a
  home directory or `USERPROFILE` on a location whose permissions the operator widened.
- The behaviour of the upstream API, of the authorization server, or of the MCP host itself (how
  it displays tools or asks for approval).
- Vulnerabilities in dependencies that do not reach the shipped bundle. Report those upstream.
- Findings from automated scanners without a demonstrated impact on `openapi-mcp`.
