# Vision — vibecodereview

## What this is

vibecodereview reviews a pull request with a council of AI models. Each model
reads the diff through its own lens: correctness, performance, security,
maintainability, scope, or test strength. Claude chairs the council. It checks
every finding against the code, drops the false positives, fixes what it can
confirm, pushes the fix as a commit on the pull request branch, and posts one
review. The check heals itself toward green. You can run the council as a
GitHub Action, as a CLI command, or through an MCP tool, and the CLI also
reviews a local diff before you push.

## Who it is for

Solo developers who maintain many personal repositories and review their own
pull requests. The tool sends diffs to third-party model providers, so the
confidentiality note limits it to personal and private repositories and
forbids proprietary or employer code. The first fleet is the maintainer's own:
about 80 repositories run the action pinned at `@v1`, and rollout scripts fan
new versions out to them. <!-- CHECK -->

## What good looks like

- Every pull request gets one review comment, and the chair has verified each
  finding against the code before posting it.
- A confirmed finding becomes a commit on the pull request branch without the
  author writing it. Fix cycles are capped at three by default.
- A missing key or a dead provider removes a member or skips the council step.
  It never fails the check, and the review script always exits 0.
- When `PR_CONTEXT_FILE` supplies the author's claim, the scope lens flags a
  diff that does not match the pull request title, body, or linked issues.

## Explicitly not this

- Adding an npm runtime dependency. The rule is zero runtime dependencies on
  Node 20 or later with global `fetch` only, and AGENTS.md says "Do not add
  npm dependencies."
- Copying provider or lens logic into `action.yml`, the CLI, or the MCP
  server. The engine is the single source of truth, and a member or lens is
  added only in `council-config.mjs`.
- Making a provider failure fail the check or block the pull request. A member
  without a key must skip with a note, never throw, and every failure is
  non-fatal.
- Running the mutations that the mutation lens proposes against a real test
  suite. The README keeps the lens at propose-only and calls execution a
  separate feature with a separate cost. <!-- CHECK -->
- Building for review of proprietary or employer code. The confidentiality
  section restricts the tool to personal and private repositories.

## How it pays for itself

No revenue appears anywhere in the repository. <!-- CHECK --> The package is
MIT-licensed and free on npm, and it is part of the Vibe Suite. It pays for
itself as an internal tool: it does the first-pass review the maintainer would
otherwise do alone across the fleet that follows the `@v1` tag. A new council
member costs one model call per pull request in every one of those repos. A
chair fix is a commit on the branch, so every other `pull_request` workflow in
a consumer repo re-runs, up to three cycles by default.

## The current bet

As of 2026-08-31, the bet is that the mutation lens, off by default today,
names real weak tests often enough to earn its model call on every
test-bearing diff, and it must prove that by 2026-11-30. <!-- CHECK -->
