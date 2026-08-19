# AGENTS.md — vibecodereview

Council PR-review tool. One engine (`scripts/council-review.mjs`) drives three
surfaces: a GitHub composite Action (`action.yml`), a CLI (`bin/vibecodereview.mjs`),
and an MCP server (`mcp/server.mjs`). Keep the engine the single source of truth —
never fork its provider/lens logic into the surfaces.

## Layout

- `scripts/council-review.mjs` — fans a diff out to council models (OpenAI-compatible
  `/chat/completions` per provider), one lens each, writes `council-findings.md`.
  Every failure is non-fatal; the script always exits 0. Has `--selfcheck`.
- `action.yml` — checkout → council fan-out → `anthropics/claude-code-action@v1`
  (the chair: verifies, fixes, pushes, posts one review).
- `bin/vibecodereview.mjs` — `init` / `review` / `doctor` / `secrets`.
- `mcp/server.mjs` — zero-dep stdio JSON-RPC, one tool `council_review(diff)`.

## Rules

- Zero runtime deps. Node ≥20, global `fetch` only. Do not add npm dependencies.
- Providers: `openai`, `gemini`, `moonshot`, `openrouter`. Add one by extending
  `PROVIDERS` + `DEFAULT_MODELS` in the engine only.
- A member with no API key must skip with a note, never throw.
- Secrets never land in git. CI secrets live in repo settings; local keys in env.
- After any engine change, run `node scripts/council-review.mjs --selfcheck`.

## Confidentiality

vibecodereview sends diffs to third-party model providers. Use it on **personal /
private repos**. Do not point it at proprietary or employer code.
