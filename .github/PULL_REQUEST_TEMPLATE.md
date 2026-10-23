<!--
Thanks for the pull request. The checklist below is what a maintainer would otherwise
have to verify by hand; ticking it honestly is the fastest path to a merge.
Security fixes do not belong in a public pull request: see SECURITY.md.
-->

## What changes

<!-- One or two sentences. The diff shows what; this should say why. -->

## Why

<!--
If this fixes an issue, link it. If the reason is not obvious from the diff, say a race
condition or a platform difference or something that only shows up under load, explain it
here rather than in a code comment.
-->

## Verification

<!-- Paste the tail of the run, not a claim that it passed. -->

```
$ pnpm check

```

## Checklist

- [ ] `pnpm check` passes locally (lint, format, typecheck, tests with coverage)
- [ ] No configuration was loosened to make a check pass (lint rules, coverage floors,
      benchmark rules)
- [ ] Behaviour changes are covered by a test that fails without the change
- [ ] If a flag, a default or an output changed, `docs/configuration.md` (and the README, if it
      shows it) was updated to match
- [ ] If this changes `tools/list` size on purpose, `scripts/bench/baseline.json` was regenerated
      with `pnpm bench:baseline` and the reason is stated below
- [ ] If this touches paths, the cache's filesystem code, the bin stub or process handling, the
      pull request carries the `ci:windows` label (or asks a maintainer to add it)
- [ ] If this is user-facing, `CHANGELOG.md` and `packages/cli/CHANGELOG.md` were updated
      identically, under `## [Unreleased]`
- [ ] Version numbers were not edited by hand (use `pnpm versions --set <version>`), and
      `pnpm versions --check` passes

## Notes for the reviewer

<!--
Anything you are unsure about, decisions you made that could reasonably have gone the
other way, or parts that deserve a closer look.
-->
