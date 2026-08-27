<p align="center"><img src="assets/logo.jpg" width="128" alt="vibecodereview logo"></p>

# vibecodereview

**A council of AI models reviews your PR — many models, one check.**

Each model reviews the diff through a different lens, so they catch different
things. Claude chairs: it verifies every claim against the code, drops false
positives, fixes what it can confirm, pushes the fix, and posts one review. The
check heals itself toward green.

Part of the **Vibe Suite**.

## Demo

A council of clay AI ninjas reviews a pull request — problem, deliberation,
verdict, self-healing fix.

▶ **[Watch the launch trailer](https://getvibe.dev/vibecodereview)** ·
[16:9](assets/vibecodereview-trailer-16x9.mp4) · [9:16](assets/vibecodereview-trailer-9x16.mp4)

## The council

| Member | Provider (called directly) | Secret | Lens |
| --- | --- | --- | --- |
| Chair | Claude (subscription OAuth) | `CLAUDE_CODE_OAUTH_TOKEN` | synthesis + conventions + tests + fixes |
| GPT / Codex | api.openai.com | `OPENAI_API_KEY` | correctness, silent failures |
| Gemini | generativelanguage.googleapis.com | `GEMINI_API_KEY` | performance, type design |
| Kimi | api.moonshot.ai | `MOONSHOT_API_KEY` | security |
| Grok / DeepSeek | openrouter.ai | `OPENROUTER_API_KEY` | maintainability, data integrity |

A member with no key drops out. No key at all → the council step is skipped, and
Claude still reviews alone. Nothing here blocks the PR on a provider outage.

## Use it in a repo

```bash
npx vibecodereview init          # writes .github/workflows/vibecodereview.yml
npx vibecodereview secrets --repo owner/name   # prints the gh commands to set keys
```

Set at least `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). Add provider
keys to grow the council. Set them on **private** repos.

Or wire the action directly:

```yaml
- uses: pooriaarab/vibecodereview@v1
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    github_token: ${{ github.token }}
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
    moonshot_api_key: ${{ secrets.MOONSHOT_API_KEY }}
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

Swap models without code: `council_models` input, or the `*_MODEL` env
overrides (`OPENROUTER_MODEL=deepseek/deepseek-v4-flash`, etc.).

### Custom / OffRouter provider

Point a council member at any OpenAI-compatible gateway: OpenRouter, a
self-hosted proxy, or a local OffRouter endpoint. (OffRouter is a local
router for coding agents; if it exposes an OpenAI-compatible
`/v1/chat/completions`, set `CUSTOM_BASE_URL` to it.)

```bash
export CUSTOM_BASE_URL=https://your-gateway.example/v1/chat/completions
export CUSTOM_API_KEY=...
export COUNCIL_MODELS="custom|<model>|Name|lens"
```

No `CUSTOM_BASE_URL` → the member skips with a note, same as a missing key.

### Claude subscription seats

Every other seat needs a metered API key, and those are what run dry — a repo
can sit at three-of-four members returning HTTP 429 while the posted summary
still lists four reviewers, so a PR looks multi-model reviewed when only the
chair ran.

A Claude Code OAuth token is not an API bearer, so it cannot hold a normal
seat. The `claude` and `claude2` providers shell the Claude Code CLI (already
installed for the chair) instead of POSTing, putting the cost on the
subscription. `claude2` lets a second subscription hold a real seat rather
than idling as the chair's failover token.

```yaml
council_models: >-
  claude|claude-opus-4-5|Claude Opus 4.5|correctness,
  claude2|claude-sonnet-4-5|Claude Sonnet 4.5|security,
  openrouter|google/gemini-3.1-pro-preview|Gemini 3.1 Pro|performance,
  openrouter|x-ai/grok-4.6|Grok 4.6|maintainability
```

The seats run with no tools, `--max-turns 1`, and a working directory outside
the PR checkout — `claude -p` skips the workspace-trust prompt and would
otherwise execute a repo-local `.claude/settings.json` hook with every secret
in the step's environment. Set `CLI_TIMEOUT_MS` to change their budget
(default 240000).

## Set up across many repos

`bin/rollout.mjs` rolls the action out to a fleet of repos. For each repo it
sets the 5 secrets from your environment and opens one PR that adds the
owner-gated workflow. It is idempotent: re-running re-sets secrets and
reuses the branch and PR. It never merges.

```bash
node bin/rollout.mjs --dry-run owner/a owner/b   # preview; changes nothing
node bin/rollout.mjs owner/a owner/b             # or REPOS="owner/a,owner/b"
```

Once the rollout PRs are green, merge them with `bin/merge-rollout.mjs`:

```bash
node bin/merge-rollout.mjs --lenient owner/a owner/b
```

It merges only PRs whose vibecodereview check passed. `--lenient` ignores
unrelated red CI on the repo (safe: a rollout PR only adds one file). It
never merges while the vibecodereview check is pending or failing.

## Review a local diff before you push

```bash
export OPENAI_API_KEY=... MOONSHOT_API_KEY=...   # whichever members you want
vibecodereview review --base origin/main
```

## Review open PRs across repos

```bash
vibecodereview review-prs owner/a owner/b        # print findings per open PR
vibecodereview review-prs --post --repo owner/a  # also comment on each PR
```

Needs an authenticated `gh`. One failing PR does not stop the batch.

## As an MCP tool

```bash
claude mcp add vibecodereview -- node /path/to/vibecodereview/mcp/server.mjs
```

Exposes one tool, `council_review(diff)`. Provider keys come from the server env.

## Notes

- Subscriptions (codex-personal, gemini-personal, muse) don't reach a CI runner —
  CI uses each provider's **API key**. Only Claude's OAuth token ports to CI.
- Rotate any key you paste into a chat or terminal history.
