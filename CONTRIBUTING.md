# Contributing

This page explains how to build, test and release `openapi-mcp`, and what a pull request needs
to pass review. `openapi-mcp` has a deliberately narrow scope: it turns an OpenAPI spec into a
strict MCP server that runs locally, with no code generation and no config file of its own.
Before you write code, open an issue and describe the problem you hit.

Security problems are the exception: report them privately, as [SECURITY.md](SECURITY.md)
describes, never in a public issue or pull request.

References of the form `kaisers-io/openapi-mcp-archive#N` in code comments, tests and the changelog
point to issues and pull requests in the project's earlier private tracker. Numbers in this
repository start again from one.

## Requirements

- **Node.js `^22.19.0 || >=24.11.0`** is the supported range for the published CLI (`engines` in
  every `package.json`). CI runs the full check on both floors, 22.19.0 and 24.11.0.
- **Node 24.22** for development (see `.node-version`). CI uses this pin for everything except the
  two floor runs.
- **pnpm 11 or newer.** `packageManager` in the root `package.json` pins the exact version. The
  published CLI has no pnpm requirement of its own.
- **Linux or macOS.** The published package supports Windows, but Windows is not a development
  platform. CI runs the test suite there, but the development scripts (benchmarks, smoke and
  release scripts) assume a POSIX shell.

```bash
git clone https://github.com/kaisers-io/openapi-mcp.git
cd openapi-mcp
pnpm install
pnpm build
node packages/cli/bin/openapi-mcp.mjs --help
```

`packages/cli/bin/openapi-mcp.mjs` is the committed launcher. It checks the platform and the Node
version. Then it loads the bundle from `dist/` when a build exists, and the TypeScript source
otherwise, so a checkout without a build runs too. The test suite runs the CLI from source.

## Before you open a pull request

Run the full check. It must pass:

```bash
pnpm check            # lint, format check, typecheck, skills check, tests with coverage
pnpm test:real-specs  # --allow and --deny against the real GitHub, Stripe and DigitalOcean specs
```

If you changed what ends up in the bundle, also run `pnpm build` and
`bash scripts/check-bundle-determinism.sh`.

## What CI runs

The workflows in `.github/workflows/` decide whether a pull request can merge. On a pull request
they run these jobs:

| Job | What it does |
|---|---|
| `ci` / check | `pnpm check` on Ubuntu and macOS, each on the dev pin and on both Node floors (24.11.0 and 22.19.0) |
| `ci` / windows | `pnpm test` on Windows, on every pull request and on `main` |
| `ci` / filters-real-specs | `pnpm test:real-specs` on Linux, macOS and Windows: the filters against the real GitHub, Stripe and DigitalOcean specs, downloaded from commit-pinned URLs and checked by sha256 |
| `ci` / bundle-determinism | builds twice and requires byte-identical output |
| `ci` / smoke | packs the CLI, installs the tarball globally and runs `scripts/smoke-cli.sh` against the installed bundle, on Linux, macOS and Windows |
| `ci` / inspector | lists and calls the tools of the built server with the official MCP Inspector CLI, in both protocol eras (`scripts/inspector/run.ts`) |
| `ci` / versions | `pnpm versions --check`: every version site (the package version, the README and `docs/` pins, the `--json doctor` example) must agree, `CHANGELOG.md` must have one `## [Unreleased]` heading, and `packages/cli/CHANGELOG.md` must equal `CHANGELOG.md` |
| `ci` / zizmor | lints the workflows themselves |
| `bench` | builds your branch and its base in the same job and benchmarks both, interleaved; skipped for documentation-only changes (see [Benchmarks](#benchmarks)) |
| `codeql` | code scanning, on every pull request |
| `skill-audit` | scans the skills for injected instructions and exfiltration patterns, on pull requests that change `skills/` or the root `package.json` |
| `audit` | `pnpm audit`, on pull requests that change dependencies (see [Dependency audit](#dependency-audit)) |

`pnpm check` runs the tests with coverage, including the lines that only run inside spawned
`openapi-mcp` processes. `vitest.config.ts` sets an aggregate floor, a floor for every file, and
stricter floors for the cache and the commands.

## Things that will fail review

- **Loosening configuration to make a check pass.** `.oxlintrc.json`, the vitest configs, the
  coverage floors in `vitest.config.ts` and the benchmark rules in `scripts/bench/rules.ts` are the
  contract. If a rule is wrong, say so and argue the case. Do not turn it off, lower a floor or
  widen a threshold to get a passing check.
- **Editing version numbers by hand.** The released version appears in
  `packages/cli/package.json`, in the README host examples and in the documentation, and
  `pnpm versions --check` (the `ci` / versions job) fails when they disagree. Use
  `pnpm versions --set <version>`.
- **Changing only one changelog.** Record user-visible changes under `## [Unreleased]` in
  `CHANGELOG.md`, and copy the file to `packages/cli/CHANGELOG.md`. The two must stay
  byte-identical: the packaged copy is what npm users see, and `pnpm versions --check` fails when
  they differ.
- **Tests that assert on implementation details** instead of observable behaviour. The tool
  definitions, tool results, error messages and the `--json` envelope are contracts. The shape of
  a private helper is not.
- **A new test file that spawns the CLI without registering it** in
  `packages/cli/test/subprocess-budget.ts`. A guard test fails otherwise.

## Benchmarks

`pnpm bench` measures the built CLI (run `pnpm build` first) over stdio, offline: time until the
`initialize` response with an empty and with a warm spec cache, `tools/list` latency and size, peak
RSS and the heap still in use after a full garbage collection, sequential and parallel
`tools/call`s against a local mock upstream with a fixed 20 ms latency, the upstream connections
they open, and the time `--version` and `tools` take. The fixtures are the petstore test spec
plus synthetic specs that `scripts/bench/fixtures.ts` generates. The command prints a JSON
report.

```bash
pnpm build
pnpm bench --runs 5 --out report.json                  # the CI suite (--suite ci)
pnpm bench --suite heavy                               # the full-size reproductions from the perf issues
pnpm bench --suite public                              # DigitalOcean, GitHub, Stripe (downloads once, pinned by commit + sha256)
# Compare two builds on the same machine, interleaved:
pnpm bench --cli head=packages/cli/bin/openapi-mcp.mjs --cli base=../main/packages/cli/bin/openapi-mcp.mjs --out ab.json
pnpm bench:compare ab.json --base base --baseline scripts/bench/baseline.json
```

The `bench` workflow fails a timing or memory metric only when both its median and its minimum
get worse by more than the ratio in `scripts/bench/rules.ts` (25% for time, 15% for the live heap
after garbage collection) and by more than a small absolute floor. Peak RSS depends on when
garbage collection runs, so the workflow reports it but does not fail on it.

The size of `tools/list` in bytes is the same on every machine, so the workflow compares it
exactly with the committed `scripts/bench/baseline.json` instead. Any difference, up or down,
fails until the baseline is updated. A percentage threshold would let a series of pull requests
each add a little without anyone accepting the total. When you intend such a change, update the
baseline in the same pull request with `pnpm bench:baseline` and say why in the description.

The parallel batch sends as many calls as `serve` admits at once (16), so it measures concurrent
throughput. Any refused call fails the gate (`parallelErrors`).

## Documentation

`docs/configuration.md` documents every flag, `docs/security.md` the security model, and the
other pages in `docs/` explain one task each. If you change a flag, a default or an output,
update the documentation in the same pull request. The README's host examples pin an exact
version, and `pnpm versions --check` holds every pin to the version in
`packages/cli/package.json`.

The agent skills under `skills/` describe the CLI for agents. Shared reference files live in
`skills/_shared/references/`. `pnpm skills:sync` copies them into each skill and writes each
skill's options file from `openapi-mcp --json help`. `pnpm check` runs `pnpm skills:check`, which
fails when a skill is out of date, links a missing docs heading, or breaks the writing and
secret rules in `scripts/skills/rules.ts`. If you change a flag or a behavior a skill describes,
update the skill in the same pull request.

`scripts/skills/evals/scenarios.json` describes how the skills must behave.
`node scripts/skills/evals.ts <claude|codex> <model> [scenario...]` plays the scenarios against
an agent with this checkout's CLI. It needs the agent CLI and its login, so it is not part of
CI. When you change a skill's text, run the affected scenarios while you work, and run all of
them with at least two models before the pull request. Put the results in its description.
Before you change the skill after a failed run, read the run's transcript (`transcript.txt` in
the project the runner prints): a scenario or its check can be wrong too. The `skill-audit`
workflow scans the skills for injected instructions and exfiltration patterns.

## Dependency audit

`pnpm audit --audit-level=high` checks the whole lockfile against the live advisory database. It
covers dev dependencies too, because the CLI bundles its runtime dependencies from them. The check
runs in `.github/workflows/audit.yml`:

- every week on `main` (Mondays, 06:17 UTC),
- on demand (Actions, then audit, then Run workflow),
- on pull requests that change `pnpm-lock.yaml`, `pnpm-workspace.yaml`, a `package.json` or
  `audit.yml` itself.

The audit is not part of `ci.yml` and must not be a required status check. Otherwise a new
advisory against an unrelated transitive package would turn every open pull request red without
any change in the pull request.

When a run fails:

1. **Read the advisory.** Check whether the vulnerable code can be reached here. Is it in the
   shipped bundle (`packages/cli/dist`), or only in dev tooling?
2. **Fix it by upgrading.** This is the normal case. Bump the direct dependency that pulls the
   vulnerable package in. If that is not possible yet, run `pnpm audit --fix update`, which
   resolves the lockfile again, or `pnpm audit --fix override`, which pins a fixed version
   through `overrides` in `pnpm-workspace.yaml`. Open a pull request. The audit runs on it
   because it changes the lockfile.
3. **Accept an advisory only with a record.** Accept it only when no fixed version exists and
   the vulnerable code cannot be reached. Add `--ignore GHSA-xxxx-xxxx-xxxx` to the audit step
   in `audit.yml`, with a comment that gives the reason and a review-by date. Remove the ignore
   once a fix ships, or when the date passes.
4. **Treat shipped code as a release blocker.** If the vulnerable code is in the shipped bundle
   and can be reached, fix it, then cut a patch release.

## Security audit

The source is audited with
[cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (#97). The
audit runs locally, by a maintainer, not in a workflow: Actions logs of a public repository can
be read by anyone, so a workflow would publish findings before they are fixed.

- **When.** Once a month, scoped to the diff between the last audited commit and `main`, and
  skipped when no source changed. A full run of the whole repository before each minor release.
- **How.** Target code runs only in a sandbox: a container with `--network none`, a read-only
  source mount and resource limits. Each confirmed finding is checked again by a model from a
  different vendor before it counts.
- **Results.** They stay outside the repository, in a private directory. A run records the
  audited commit there, so the next run knows its diff. Nothing from a run is posted to an
  issue, a pull request or a commit message before the fix is released.
- **Findings.** A confirmed finding is fixed in a patch release, as [SECURITY.md](SECURITY.md)
  describes. Commits, pull requests and the changelog describe the fix, not how to exploit the
  old behavior. Once other people depend on the package, a confirmed finding also gets a
  private security advisory before the fix release.
- **Summary.** After the fixes ship, the audit issue gets a short note: date, audited commit,
  and the number of records per verdict.

## Releasing

The version lives in `packages/cli/package.json`. The READMEs, `docs/` and both changelogs repeat
it, and `pnpm versions --check`, which CI runs on every pull request, fails when they disagree. Do
not edit version numbers by hand:

1. `pnpm versions --set x.y.z` on a branch. It refuses a version that is not newer than the
   current one, writes the version to every site and turns `## [Unreleased]` in `CHANGELOG.md`
   and `packages/cli/CHANGELOG.md` into `## [x.y.z] - <date>`. Review it with `git diff`.
2. Open a pull request and merge it.
3. Tag the merge commit on `main` as `vx.y.z` and push the tag. The `release` workflow checks
   that the tag, every version site and the changelog heading agree, and that the version is
   newer than the one npm serves as `latest`. The `publish` job then waits for approval in the
   `npm-publish` environment and publishes to npm with a provenance attestation. The `announce`
   job creates the GitHub release from the version's changelog section.
4. The `verify-published` job waits until npm serves the version, installs it from the registry
   on Linux, macOS and Windows, and runs `scripts/smoke-cli.sh` against it. On Windows that
   includes a spec given as an absolute drive path. A failure there cannot stop the release,
   which is already public. Deprecate the version and ship a fix.

### What the release guards cover, and what they do not

A `v*` tag push is the only trigger. Every guard that authorizes the release is part of the
tagged tree, because GitHub reads a push-triggered workflow from the pushed ref. Those guards are
the tag and version match, the version and changelog checks, the version-regression check, the
`origin/main` ancestor check, the `needs` edges and the `id-token` grant. **A tag whose tree
deletes a guard is never checked by it.** Every check in `release.yml` therefore constrains an
honest release and nothing else.

One gate lives outside the tagged tree, and it has two halves that must both be configured in
settings. A pull request cannot change either:

1. **A GitHub Environment named `npm-publish`**, which the `publish` job declares, with a
   required reviewer and with "Allow administrators to bypass configured protection rules"
   turned off. That setting is on by default and lets an admin credential skip the approval. A
   deployment tag rule (`v*`) alone is not enough, because it checks only the ref's name. A
   hostile tag can keep `environment: npm-publish`, delete `verify`, and still satisfy it.

   This project has a single maintainer, who is the only required reviewer, with "Prevent
   self-review" turned off. With it on, nobody could approve a tag that maintainer pushes
   ([required reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)).
   In that setup the gate guarantees that every release needs an explicit approval by the
   maintainer, in the web UI or through the API. A workflow token, a collaborator who is not a
   reviewer, or a tag pushed from a compromised workflow cannot publish on its own. The gate
   does **not** protect against a stolen token of the maintainer with `repo` scope. That token
   can push the tag and approve the job itself through the REST API
   ([`pending_deployments`](https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run)).
   If more maintainers or release automation come later, the stronger setup is to push release
   tags from a separate identity that is not a reviewer (a bot account or a GitHub App) and to
   turn "Prevent self-review" on. Then the tag pusher and the approver are always different
   identities.
2. **The npm Trusted Publisher entry for `@kaisers-io/openapi-mcp` must name that environment**,
   next to the repository (`kaisers-io/openapi-mcp`) and the workflow filename (`release.yml`).
   npm binds the workflow by its filename, not its contents. Without the environment, a tag that
   brings its own workflow at that path gets the publish token, whatever this repository's
   `release.yml` says.

**Check both, separately.** A failed publish proves nothing on its own, because publishing an
existing version fails too. You have to establish three things: a job in the environment waits
for an approval the tag pusher cannot give, the approved identity authenticates, and an otherwise
identical identity without the environment is refused.

List every trusted-publisher entry on the package, not only the one you edited. npm allows several
independent entries, and an older entry without the environment keeps that route open. Binding
the environment also means that a commit whose `release.yml` predates it can no longer be
released, even though the ancestor check still allows tagging it.

The version-regression guard refuses a tag whose version is not strictly greater than the one npm
serves as `latest`. It also refuses anything that is not a plain `x.y.z`, prereleases included.
This workflow publishes stable releases, and guessing an order for `1.0.0-rc.1` is how a release
goes out under the wrong dist-tag. `pnpm versions --set` checks newness only against the checkout
it runs in; this guard checks the registry. npm 11 already rejects a lower version on the implicit
tag, so the guard is a stricter version of that rule which `--tag` and `--force` cannot bypass.
It fails closed. A lookup that errors stops the release. The guard treats the release as the
first publication only when the registry answers "not found" (E404) or reports no version.

**Publishing requires the repository to be public.** `npm publish --provenance` signs an
attestation that names the source repository and records it in a public transparency log. From a
private repository, that attestation would point at a URL nobody can open. The `publish` job
refuses unless the push event reports the repository as public (`private` is exactly `false`).
A release tagged while the repository is private therefore stops before anything leaves the
runner.

## Commits

Use conventional commits: `feat:`, `fix:`, `perf:`, `docs:`, `test:`, `ci:` or `chore:`, with a
scope where it helps, such as `fix(core):`. The subject says what changed. The body says why,
especially when the reason is not obvious from the diff.
