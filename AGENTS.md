# AGENTS.md — vibecodereview

Council PR-review tool. One engine (`scripts/council-review.mjs`) drives three
surfaces: a GitHub composite Action (`action.yml`), a CLI (`bin/vibecodereview.mjs`),
and an MCP server (`mcp/server.mjs`). Keep the engine the single source of truth —
never fork its provider/lens logic into the surfaces.

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
- Providers: `openai`, `gemini`, `moonshot`, `openrouter`. Add one by extending
  `PROVIDERS` + `DEFAULT_MODELS` in the engine only.
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

## Confidentiality

vibecodereview sends diffs to third-party model providers. Use it on **personal /
private repos**. Do not point it at proprietary or employer code.
