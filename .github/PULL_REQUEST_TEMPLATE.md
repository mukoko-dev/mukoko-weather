<!--
  Thanks for contributing! Please make sure you've read CONTRIBUTING.md
  before opening this PR:
  https://github.com/nyuchi/.github/blob/main/CONTRIBUTING.md

  Your PR title MUST follow Conventional Commits, e.g.:
    feat(ui): add dark-mode toggle to settings
    fix(auth): refresh token race condition
    docs: clarify SECURITY.md reporting steps
-->

## Summary

<!-- One or two sentences: what does this PR do and why? -->

## Linked issue(s)

<!-- Use "Closes #123" to auto-close an issue on merge. Use "Refs #123"
     for related-but-not-closing issues. Remove this section if N/A. -->

Closes #

## Type of change

<!-- Check all that apply. Must match your Conventional Commits type. -->

- [ ] `feat` — user-visible new feature
- [ ] `fix` — user-visible bug fix
- [ ] `perf` — performance improvement
- [ ] `refactor` — code change, no behaviour change
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `build` — build system, packaging, dependencies
- [ ] `ci` — CI configuration
- [ ] `chore` — maintenance
- [ ] `revert` — revert of a prior commit

## Breaking change?

- [ ] This PR introduces a breaking change.

<!-- If yes: describe what breaks, who is affected, and the migration
     path. Include the `BREAKING CHANGE:` footer in at least one commit. -->

## How has this been tested?

<!-- Describe the tests you ran. For UI changes, include screenshots or
     screen recordings of the golden path and any relevant edge cases. -->

## Checklist

<!-- All boxes must be ticked before a maintainer will merge. These mirror
     the requirements in CONTRIBUTING.md and NA-03 — they are not suggestions. -->

### Process

- [ ] My PR **title** follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
- [ ] All of my commits are **signed** and show "Verified" on GitHub
      (GPG or SSH). See
      [CONTRIBUTING.md § Signed commits](https://github.com/nyuchi/.github/blob/main/CONTRIBUTING.md#signed-commits-required).
- [ ] All of my commits have a **DCO sign-off** (`Signed-off-by:` trailer,
      added by `git commit -s`).
- [ ] My branch name follows `<type>/<short-kebab-description>` (see
      [CONTRIBUTING.md § Branch naming](https://github.com/nyuchi/.github/blob/main/CONTRIBUTING.md#branch-naming)).
- [ ] I have **rebased** onto the latest default branch; no merge commits
      from the base branch in this PR.
- [ ] I have added or updated **tests** covering the change (or explained
      below why tests aren't applicable).
- [ ] I have updated **documentation** (README, inline docs, changelog,
      migration notes) where relevant.
- [ ] I ran the repo's local checks (lint, typecheck, tests) and they pass.
- [ ] Any new **runtime dependencies** are justified in this PR description
      (name, version, license, why).
- [ ] If this is a breaking change, I have marked the box above and
      included a `BREAKING CHANGE:` footer in at least one commit.

### NA-03 merge blockers

<!-- These checks mirror the Quick Reference in NA-03 §§ 3–7.
     Tick only the boxes that are relevant to this PR. If none apply,
     check "N/A" and leave the others blank. -->

- [ ] **N/A** — this change does not touch schema, APIs, dependencies,
      cryptography, data placement, or smart-contract counts.
      _(If ticked, skip the remaining boxes in this section.)_
- [ ] **Secret hygiene** — I confirmed no API keys, tokens, `.env` contents,
      private keys, or credentials appear anywhere in the diff.
- [ ] **Prohibited dependencies** — this PR introduces no Flutter,
      Couchbase, Databricks, Cloudflare D1 or Capacitor dependency, no
      database connection outside the Nyuchi API, and no reference to a
      fixed 10-billion MXT supply cap.
- [ ] **Schema.org compliance** — new database tables, columns, or API fields
      map to Schema.org types, or the PR description justifies any deviation.
- [ ] **Locked counts respected** — no change to the platform's locked counts
      (17 mini-apps · 7 data layers · 7 covenants · 40 interest categories ·
      12 manifesto sections · 3 sources of truth) without Founder approval
      documented in the PR description. Nyuchi products are **not** a
      locked count (the Bundu Order) — do not re-add a count for them.
- [ ] **Frontier defaults** — for user-facing or infrastructure work:
      offline / local-first behaviour has been considered; any new
      cryptographic primitive has a documented post-quantum migration path;
      edge-native placement has been addressed.
- [ ] **New GitHub Actions** are pinned to a 40-character commit SHA
      (not a floating tag) per NA-03 §7.1.1.

## Screenshots / recordings

<!-- Optional. Drag-and-drop images or .mov/.mp4 files here. -->

## Additional notes

<!-- Optional. Anything reviewers should know before looking at the diff:
     deployment concerns, feature-flag state, follow-up PRs, etc. -->
