# Working in this repository

Rules for coding agents (Claude Code and Codex read this file). [CONTRIBUTING.md](CONTRIBUTING.md)
is the source of truth for humans: requirements, what CI runs, review rules, releases. This file
adds what an agent needs to know on top and points to CONTRIBUTING.md instead of repeating it.

Claude Code (v2.1.277 or later) reads this file only while no `CLAUDE.md`, `.claude/CLAUDE.md`
or `CLAUDE.local.md` sits in the working directory or above it. If you keep one of those, import
this file from it: `@AGENTS.md` in a root `CLAUDE.md` or `CLAUDE.local.md`, `@../AGENTS.md` in
`.claude/CLAUDE.md` (imports resolve relative to the importing file). `/memory` lists the files a
session read.

## Finish every PR with a real test

`pnpm check` passing is not evidence that a feature works. A fixture only covers the shapes its
author thought of. Before you call a change done:

1. `pnpm build`, then drive the bundle through `packages/cli/bin/openapi-mcp.mjs`, not the
   TypeScript source.
2. Use a real public OpenAPI description: the commit-pinned, sha256-checked GitHub, Stripe and
   DigitalOcean specs in `scripts/bench/public-specs.ts` (`pnpm bench --suite public` downloads
   them), or another real spec the change is about.
3. Go through the paths agents and hosts use: `--json` (`tools`, `check`, `call --dry-run`,
   `doctor`) and MCP over stdio (`serve`, then `tools/list` and `tools/call`). Point `HOME` (or
   `USERPROFILE` on Windows) at a scratch directory, so the spec cache under
   `.kaisers-io/openapi-mcp/` starts empty and your own cache stays untouched.
4. Compare what openapi-mcp reports with ground truth computed from the spec itself, for example
   the operations per method and path read from the JSON, diffed against `tools --json`. Report
   the comparison, not just the output.
5. Run any command or host config that the CLI, the docs or a skill prints **verbatim**, as
   printed. Do not rebuild it from its parts: that hides exactly the quoting and placeholder bugs
   that matter.
6. Where the change touches the cache, exercise its lifecycle: `cache list`, `cache refresh`,
   `cache promote`, `cache clear --all`, then confirm that `cache list` and `doctor` show nothing
   left behind.

## Tests

- A test that pins a fix must fail when the fix is reverted. Revert, run, restore. A test that
  passes either way pins nothing.
- That check shows what the tests cannot tell apart. It never shows that code is dead: it is a
  reason to write a test, not to delete code.
- A test or script that runs the bundle must rebuild it first, unconditionally. The bin loads
  `dist/` whenever a build exists (see Known traps), so a stale build tests code that no longer
  exists, and the revert check above then passes against it.
- Assert the outcome, not the absence of an error. A command that failed outright is quiet too.
- Test through the real boundary when the behaviour belongs to it: a spawned CLI over MCP stdio
  (`packages/cli/test/cli-subprocess.ts`), a real local HTTP server.
- Register every new test file that spawns the CLI in `packages/cli/test/subprocess-budget.ts`.
- `pnpm check` before you push. Add `pnpm test:real-specs` when filters or spec handling change.
  The tool definitions, results, error messages and the `--json` envelope are contracts; assert
  on them, not on private helpers (CONTRIBUTING.md, "Things that will fail review").

## Skill evals

The skills under `skills/` have their own evals: `scripts/skills/evals/scenarios.json`, run by
`node scripts/skills/evals.ts <claude|codex> <model> [scenario...]` (CONTRIBUTING.md,
"Documentation").

- They are **local only and never run in CI**. They use the developer's own agent login, and every
  run costs money. Do not add them to a workflow, and do not start full runs without being asked.
- A change to a skill, or to CLI output a skill tells agents to read, runs the affected scenarios
  under Claude Code and Codex. The pull request reports the results.
- A failing run is not a verdict until you have read its transcript (`transcript.txt` in the
  project the runner prints). The scenario or its check can be wrong too.
- Run `pnpm build` first: the runner's `npx` shim runs the bin, which prefers `dist/`.
- After a change to a flag or a behaviour a skill describes, run `pnpm skills:sync` and update
  the skill in the same pull request. `pnpm skills:check` (part of `pnpm check`) fails otherwise.

## Claims about other tools

Check what an MCP host, the MCP SDK, pnpm, GitHub Actions, Dependabot or an OpenAPI or JSON
Schema rule actually does, against its current documentation or by running it, before you build
on it. Issue text and memory can be out of date: write down what you checked, and say so plainly
when a premise does not hold.

## Review findings

Verify every review finding against the code and reproduce it before you fix it. Say so plainly
when a finding does not hold, with the evidence; do not implement it to be agreeable.

## Design constraints

- **Spec text is untrusted** ([docs/security.md](docs/security.md), "Untrusted spec text").
  Anything from a spec that reaches a tool definition or human output goes through the
  sanitizer in `packages/core/src/spec/sanitize.ts`. Names and values passed on as they are
  (parameter names, `enum`, `pattern`) are never rewritten; they are validated.
- **No code generation and no config file of its own** (CONTRIBUTING.md, first paragraph).
- **Never loosen a check to make it pass**: `.oxlintrc.json`, the vitest configs and coverage
  floors, `scripts/bench/rules.ts` (CONTRIBUTING.md, "Things that will fail review"). An
  intended change to the `tools/list` size updates `scripts/bench/baseline.json` with
  `pnpm bench:baseline` and says why in the pull request (CONTRIBUTING.md, "Benchmarks").

## Lint limits that shape files

`.oxlintrc.json` enables the correctness, suspicious, pedantic, perf and style categories with
type-aware rules. Each rule that is off or reconfigured carries its reason next to it; read it
before you fight a rule, and argue a change there instead of disabling it inline. `max-lines`
applies to source files, with per-file waivers that state why; tests are exempt. Run `pnpm fmt`
before `pnpm check`. The formatter does not cover the root Markdown files, so keep their lines
at 100 columns by hand.

## Known traps

- **The bin runs a stale build.** `packages/cli/bin/openapi-mcp.mjs` loads `dist/` whenever it
  exists, and the TypeScript source only without a build. After a source change, rebuild before
  you run the bin. The test suites spawn the source and are not affected.
- **Two changelogs.** Edit `CHANGELOG.md` under `## [Unreleased]`, then copy it to
  `packages/cli/CHANGELOG.md`. The two must stay byte-identical. Only user-visible changes get an
  entry (CONTRIBUTING.md, "Things that will fail review").
- **Version numbers** change only through `pnpm versions --set <version>`, never by hand.
- **Schema library bumps** (`ajv`, `ajv-formats`, `ajv-draft-04`,
  `@seriousme/openapi-schema-validator`) need `node scripts/generate-validators.ts` in the same
  pull request.
- **Line endings.** `.gitattributes` forces LF. Do not commit CRLF fixtures.
- **Windows** is a supported runtime, not a development platform. CI tests it; the development
  scripts assume a POSIX shell.
- **Tool pins in workflows** that Dependabot cannot see are bumped by hand (CONTRIBUTING.md,
  "Tool pins bumped by hand").

## Commits, pull requests, issues

- The repository is public. Conventional commits (CONTRIBUTING.md, "Commits"). The commit body
  explains why. One topic per pull request.
- Describe the change and its reason, not how it was produced: no tool or agent attribution
  trailers.
- No paths under a home directory, no local configuration details, no tokens and no references to
  gitignored working notes in issues, pull requests, commits or the changelog. Issues must stand
  on their own.
- References like `kaisers-io/openapi-mcp-archive#N` point to a private tracker. New public text
  must not depend on them.
- Security problems follow [SECURITY.md](SECURITY.md), never a public issue. Nothing from a
  security audit goes into an issue, a pull request or a commit before the fix ships
  (CONTRIBUTING.md, "Security audit").
