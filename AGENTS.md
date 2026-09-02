# AGENTS.md — vibecodereview

Council PR-review tool. One engine (`scripts/council-review.mjs`) drives three
surfaces: a GitHub composite Action (`action.yml`), a CLI (`bin/vibecodereview.mjs`),
and an MCP server (`mcp/server.mjs`). Keep the engine the single source of truth —
never fork its provider/lens logic into the surfaces.

Read `.agents/brand.md` and `.agents/design.md` before public copy or interface work.

## Layout

- `scripts/council-review.mjs` — fans a diff out to council models (OpenAI-compatible
  `/chat/completions` per provider), one lens each, writes `council-findings.md`.
  Every failure is non-fatal; the script always exits 0. Has `--selfcheck`.
- `scripts/council-config.mjs` — the provider table, the lens descriptions, the
  default members, and the OpenRouter reroute map. Data only.
- `scripts/pr-context.mjs` — assembles the author's claim and the diff into one
  prompt, and decides what gets cut when they do not both fit.

  The two modules above are a SPLIT, not the fork the rule below forbids: each
  thing is defined exactly once and the engine imports it. They exist because
  `max-lines` caps a file at 300 and the budget is not negotiable. Add a member
  or a lens in `council-config.mjs`; add nothing to a surface.
- `action.yml` — shallow checkout → council fan-out (started in the background,
  collected just before the chair, so setup runs inside its latency) →
  `anthropics/claude-code-action@v1` (the chair: verifies, fixes, pushes, posts
  one review). The chair prompt is built ONCE into `VCR_CHAIR_PROMPT` and reused
  by every failover attempt — never paste it per attempt.
- `bin/vibecodereview.mjs` — `init` / `review` / `doctor` / `secrets`.
- `mcp/server.mjs` — zero-dep stdio JSON-RPC, one tool `council_review(diff)`.

## Rules

- Zero runtime deps. Node ≥20, global `fetch` only. Do not add npm dependencies.
- Providers: `openai`, `gemini`, `moonshot`, `openrouter`, `custom`, `claude`,
  `claude2`. The last two are subscription-backed: they shell the Claude Code
  CLI rather than POSTing, and add no npm dependency. Add one by extending
  `PROVIDERS` in `council-config.mjs` (+ `DEFAULT_MODELS` if it should be on by
  default).
- A member with no API key must skip with a note, never throw.
- The council uses a scope lens to verify atomicity and claim alignment. Set `PR_CONTEXT_FILE` to a file containing the author's claim (title, body, closed issues) to feed this lens.
- A composite action's `inputs:` block must contain NO `${{ }}` expressions — not in a default AND not in a description string; GitHub parses them and fails at 'Set up job'. Callers pass github_token explicitly.
- Secrets never land in git. CI secrets live in repo settings; local keys in env.
- After any engine change, run `node scripts/council-review.mjs --selfcheck`.
- The council fans out with `Promise.all`, so its wall time is `max(member)`, not
  the sum. The per-member timeout is therefore the council's worst case on EVERY
  run — treat it as a latency budget, not a safety net. Each member's latency is
  logged; tune `COUNCIL_TIMEOUT_MS` from those numbers.
- A chair attempt costs ~10s of setup before the model is even reached, so a dead
  token is not free. A chair that returns `is_error: true` with `num_turns: 1`,
  `total_cost_usd: 0` and an empty `modelUsage` never reached the model — that is
  an exhausted or invalid subscription, not a bad prompt. Fix the token.

## Releasing

Two tags per release, never one.

| Tag | Mutable | Who follows it |
|---|---|---|
| `vX.Y.Z` | never moved | anyone who pins a version, and rollback |
| `vX` | force-moved to the newest `vX.Y.Z` | the ~80 repos whose workflow says `@v1` |

    node bin/release.mjs 1.2.0            # dry run, prints the plan
    node bin/release.mjs 1.2.0 --apply    # create v1.2.0, move v1 to it
    gh release create v1.2.0 --notes "..."

The immutable tag is the point. Without it there is no way to say which version
a repo is on, and no way back except a SHA dug out of `git log`. This repo ran
that way until `v1.0.0` was cut retroactively at whatever `v1` happened to point
at, purely so a rollback target existed.

**Moving `vX` is a deployment to every repo that follows it.** Nothing else in
this repo reaches production; merging to `main` changes nothing for a consumer.
So treat the move as the release, say what it costs in the notes, and remember a
new council member costs a model call per PR in all of them.

## Confidentiality

vibecodereview sends diffs to third-party model providers. Use it on **personal /
private repos**. Do not point it at proprietary or employer code.

<!-- pr-standards:start -->

## Pull requests

One issue. One PR. One concern. Under 500 counted lines.

Open the issue first. No issue, no branch. The issue number ties the branch, the
title, the body and the merged commit to one agreed piece of work.

```text
branch:  vcr-<issue>-<slug>          vcr-142-fix-onboarding-drop-off
title:   [VCR-<issue>] <Subject>   [VCR-142] Fix onboarding drop-off
body:    Closes #142
         ## What / ## Why / ## How I verified
         Assisted-by: <agent>:<model>
```

Subject line: imperative mood, 10-50 characters, no trailing period, no emoji.
Write "Fix the drop-off", not "Fixed the drop-off".

Hard caps, failed by the `pr-standards` CI check: 500 counted lines, 40 counted
files, exactly one `Closes #`. Lockfiles, build output, snapshots, generated
code and migrations are not counted. There is no label that clears the cap and
no one to ask for one. Split the change.

Settings for this repo are in `.github/pr-standards.json`. The standard is at
https://github.com/pooriaarab/scripts/blob/main/pr-standards.md

<!-- pr-standards:end -->

<!-- cursor-cloud:start -->

## Cloud agents (Cursor)

This repo runs on [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent). Local
`.env.local` does **not** sync — mirror keys in **Dashboard → Cloud Agents → Secrets**.

| Secret type | Use for |
|---|---|
| Runtime Secret | API keys, passwords (hidden from chat/commits) |
| Environment Variable | Non-sensitive config (URLs, flags) |
| Build Secret | Private npm/docker registries during install only |

### Install & test

Install command lives in `.cursor/environment.json`. After dashboard setup:

1. **Environments** → link this repo → wait for **Build = Success**
2. **Secrets** → copy every key from your local `.env.local` / `.env.example`
3. Run the project's test/lint command before opening a PR (see below)

### Verify before PR

```bash
npm test
```

### Pull requests

Follow the fleet PR standard in this repo's `AGENTS.md` (`<!-- pr-standards:start -->` block).
Cloud agents need push access via Git integration and a successful environment Build.

Setup guide: https://github.com/pooriaarab/scripts/blob/main/cursor-cloud-rollout.md

<!-- cursor-cloud:end -->
