# Contributing

Thanks for taking a look. `openapi-mcp` has a deliberately narrow scope: it turns an OpenAPI spec
into a strict, locally running MCP server, with no code generation and no config file of its own.
The most useful thing you can do before writing code is open an issue and describe the problem you
hit.

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
- **Linux or macOS.** Windows is a supported runtime for the published package, not a development
  platform: CI runs the test suite there, but the development scripts (benchmarks, smoke and
  release scripts) assume a POSIX shell.

```bash
git clone https://github.com/kaisers-io/openapi-mcp.git
cd openapi-mcp
pnpm install
pnpm build
node packages/cli/bin/openapi-mcp.mjs --help
```

`packages/cli/bin/openapi-mcp.mjs` is the committed launcher. It checks the platform and the Node
version, then loads the bundle from `dist/` when a build exists and the TypeScript source
otherwise, so an unbuilt checkout runs too. The test suite runs the CLI from source.

## Before you open a pull request

Run the full check. It must pass:

```bash
pnpm check        # lint + format check + typecheck + tests with coverage
pnpm test:real-specs  # --allow/--deny against the real GitHub, Stripe and DigitalOcean specs
```

If you changed what ends up in the bundle, also run `pnpm build` and
`bash scripts/check-bundle-determinism.sh`.

## What CI runs

`.github/workflows/` holds the gate. On a pull request:

- **`ci` / check**: `pnpm check` on Ubuntu, on the dev pin and on both Node floors (24.11.0 and
  22.19.0), and the same matrix on macOS.
- **`ci` / windows**: `pnpm test` on Windows, on every pull request and on `main`.
- **`ci` / filters-real-specs**: `pnpm test:real-specs` on Linux, macOS and Windows: the filters
  against the real GitHub, Stripe and DigitalOcean specs, downloaded from commit-pinned URLs and
  checked by sha256.
- **Coverage floors.** `pnpm check` runs the tests with coverage, including the lines that only run
  inside spawned `openapi-mcp` processes. `vitest.config.ts` sets an aggregate floor, a floor for
  every file, and stricter floors for the cache and the commands.
- **`ci` / bundle-determinism**: builds twice and requires byte-identical output.
- **`ci` / smoke**: packs the CLI, installs the tarball globally and runs
  `scripts/smoke-cli.sh` against the installed bundle, on Linux, macOS and Windows.
- **`ci` / versions**: `pnpm versions --check`. Every version site (the package version, the
  README and `docs/` pins, the `--json doctor` example) must agree, `CHANGELOG.md` must have one
  `## [Unreleased]` heading, and `packages/cli/CHANGELOG.md` must equal `CHANGELOG.md`.
- **`ci` / zizmor**: lints the workflows themselves.
- **`bench`**: builds your branch and its base in the same job and benchmarks both, interleaved
  (skipped for documentation-only changes). See [Benchmarks](#benchmarks).
- **`codeql`** on every pull request, and **`audit`** (`pnpm audit`) on pull requests that change
  dependencies.

## Things that will fail review

- **Loosening configuration to make a check pass.** `.oxlintrc.json`, the vitest configs, the
  coverage floors in `vitest.config.ts` and the benchmark rules in `scripts/bench/rules.ts` are the
  contract. If a rule is genuinely wrong, say so and argue the case. Do not turn it off, lower a
  floor or widen a threshold to get a green tick.
- **Editing version numbers by hand.** The released version appears in
  `packages/cli/package.json`, in the README host examples and in the documentation, and
  `pnpm versions --check` (the `ci` / versions job) fails when they disagree. Use
  `pnpm versions --set <version>`.
- **Changing only one changelog.** Record user-visible changes under `## [Unreleased]` in
  `CHANGELOG.md`, and copy the file to `packages/cli/CHANGELOG.md`. The two must stay
  byte-identical: the packaged copy is what npm users see, and `pnpm versions --check` fails when
  they differ.
- **Tests that assert on implementation details** rather than observable behaviour. The tool
  definitions, tool results, error messages and the `--json` envelope are contracts. The shape of
  a private helper is not.
- **A new test file that spawns the CLI without registering it** in
  `packages/cli/test/subprocess-budget.ts`. A guard test fails otherwise.

## Benchmarks

`pnpm bench` measures the built CLI (run `pnpm build` first) over stdio, offline: time until the
`initialize` response with an empty and with a warm spec cache, `tools/list` latency and size, peak
RSS and the heap still in use after a full garbage collection, sequential and parallel
`tools/call`s against a local mock upstream with a fixed 20 ms latency, the upstream connections
they open, and `--version` / `tools` timings. Fixtures are the petstore test spec plus synthetic
specs generated by `scripts/bench/fixtures.ts`; it prints a JSON report.

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
regress by more than the ratio in `scripts/bench/rules.ts` (25% for time, 15% for the post-GC live
heap) and by more than a small absolute floor. Peak RSS depends on garbage-collection timing, so
it is reported but not gated. `tools/list` bytes are machine-independent, so they are gated against
the committed `scripts/bench/baseline.json` instead, exactly: any difference, up or down, fails
until the baseline is updated. A percentage threshold would let a series of pull requests each add
a little without anyone accepting the total. When such a change is intended, update the baseline in
the same pull request with `pnpm bench:baseline` and say why in the description. The parallel batch
sends as many calls as `serve` admits at once (16), so it measures concurrent throughput; any
refused call fails the gate (`parallelErrors`).

## Documentation

`docs/configuration.md` documents every flag, and `docs/security.md` the security model. If you
change a flag, a default or an output, update the documentation in the same pull request. The
README's host examples pin an exact version, and `pnpm versions --check` holds every pin to the
version in `packages/cli/package.json`.

The agent skills under `skills/` describe the CLI for agents. Shared reference files live in
`skills/_shared/references/`; `pnpm skills:sync` copies them into each skill and writes each
skill's options file from `openapi-mcp --json help`. `pnpm check` runs `pnpm skills:check`, which
fails when a skill is out of date, links a missing docs heading, or breaks the writing and
secret rules in `scripts/skills/rules.ts`. If you change a flag or a behavior a skill describes,
update the skill in the same pull request.

`scripts/skills/evals/scenarios.json` describes how the skills must behave, and
`node scripts/skills/evals.ts <claude|codex> <model> [scenario...]` plays the scenarios against
an agent with this checkout's CLI (it needs the agent CLI and its login, so it is not part of CI).
When you change a skill's text, run the affected scenarios while you work and all of them with
at least two models before the pull request, and put the results in its description. Read the
transcript of a failed run (`transcript.txt` in the project the runner prints) before you change
the skill: a scenario or its check can be wrong too. The `skill-audit` workflow scans the skills
for injected instructions and exfiltration patterns.

## Releasing

The version lives in `packages/cli/package.json`. The READMEs, `docs/` and both changelogs repeat
it, and `pnpm versions --check` (run by CI on every pull request) fails when they disagree. Do not
edit version numbers by hand:

1. `pnpm versions --set x.y.z` on a branch. It refuses a version that is not newer than the
   current one, writes the version to every site and turns `## [Unreleased]` in `CHANGELOG.md`
   and `packages/cli/CHANGELOG.md` into `## [x.y.z] - <date>`. Review it with `git diff`.
2. Open a pull request and merge it.
3. Tag the merge commit on `main` as `vx.y.z` and push the tag. The `release` workflow checks
   that the tag, every version site and the changelog heading agree and that the version is newer
   than the one npm serves as `latest`. The `publish` job then waits for approval in the
   `npm-publish` environment, publishes to npm with a provenance attestation, and the `announce`
   job creates the GitHub release from the version's changelog section.
4. The `verify-published` job waits until npm serves the version, installs it from the registry
   on Linux, macOS and Windows, and runs `scripts/smoke-cli.sh` against it; on Windows that
   includes a spec given as an absolute drive path. A failure there cannot stop the release, which
   is already public: deprecate the version and ship a fix.

### What the release guards cover, and what they do not

A `v*` tag push is the only trigger, and every guard authorizing the release (the tag/version
match, the version and changelog checks, the version-regression check, the `origin/main` ancestor
check, the `needs` edges and the `id-token` grant) is content of the tagged tree, because GitHub
resolves a push-triggered workflow from the pushed ref. **A tag whose tree deletes a guard is never
subjected to it.** Every check in `release.yml` therefore constrains an honest release and nothing
else.

One gate lives outside the tagged tree, and it has two halves that must both be configured in
settings. A pull request cannot change either:

1. **A GitHub Environment named `npm-publish`**, which the `publish` job declares, with a
   **required reviewer** and **"Allow administrators to bypass configured protection rules"
   turned off** (it is on by default and lets an admin credential skip the approval). A
   deployment tag rule (`v*`) alone is not enough: it checks the ref's name, so an adversarial
   tag keeps `environment: npm-publish`, deletes `verify`, and satisfies it.

   This project has a single maintainer, who is the only required reviewer, with "Prevent
   self-review" **off**: with it on, nobody could approve a tag that maintainer pushes
   ([required reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)).
   In that setup the gate guarantees that every release needs an explicit approval by the
   maintainer, in the web UI or through the API. A workflow token, a collaborator who is not a
   reviewer, or a tag pushed from a compromised workflow cannot publish on its own. It does
   **not** protect against a stolen token of the maintainer with `repo` scope: that token can
   push the tag and approve the job itself through the REST API
   ([`pending_deployments`](https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run)).
   If more maintainers or release automation come later, the stronger setup is to push release
   tags from a separate identity that is not a reviewer (a bot account or a GitHub App) and turn
   "Prevent self-review" on, so the tag pusher and the approver are always different identities.
2. **The npm Trusted Publisher entry for `@kaisers-io/openapi-mcp` must name that environment**,
   next to the repository (`kaisers-io/openapi-mcp`) and the workflow filename (`release.yml`).
   npm binds the workflow by its filename, not its contents, so without the environment a tag that
   supplies its own workflow at that path mints the publish token regardless of what this
   repository's `release.yml` says.

**Check both, separately.** A failed publish proves nothing on its own, because an already
published version fails too. What has to be established is that a job in the environment waits
for an approval the tag pusher cannot give, that the approved identity authenticates, and that an
otherwise identical identity without the environment is refused.

List every trusted-publisher entry on the package, not only the one you edited. npm allows several
independent entries, and an older entry without the environment keeps that route open. Binding
the environment also means a commit whose `release.yml` predates it can no longer be released,
even though the ancestor check still allows tagging it.

The version-regression guard refuses a tag whose version is not strictly greater than the one npm
serves as `latest`, and refuses anything that is not a plain `x.y.z`, prereleases included: this
workflow publishes stable releases, and guessing an order for `1.0.0-rc.1` is how one goes out
under the wrong dist-tag. `pnpm versions --set` checks newness only against the checkout it runs
in; this guard checks the registry. npm 11 already rejects a lower version on the implicit tag, so
the guard is a stricter restatement that `--tag` and `--force` cannot bypass. It fails closed: a
lookup that errors stops the release, and only a registry that answers "not found" (E404) or
reports no version is treated as the first publication.

**Publishing requires the repository to be public.** `npm publish --provenance` signs an
attestation that names the source repository and records it in a public transparency log; from a
private repository that would point at a URL nobody can open. The `publish` job refuses unless the
push event reports the repository as public (`private` is exactly `false`), so a release tagged
while the repository is private stops before anything leaves the runner.

## Commits

Conventional commits (`feat:`, `fix:`, `perf:`, `docs:`, `test:`, `ci:`, `chore:`, with a scope
where it helps, such as `fix(core):`). The subject says what changed. The body says why,
especially when the reason is not obvious from the diff.
