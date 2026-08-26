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

## What a fix cycle costs

When the chair pushes a fix, that is a real commit on the PR branch, so GitHub
raises a `synchronize` event. Every *other* workflow in the repo that triggers on
`pull_request` runs again. The cost does not show up against this action — it
shows up as extra runs of your test, lint, build and e2e workflows.

The arithmetic, for a repo with five `pull_request` workflows and the default
`max_fix_cycles: 3`:

```
1 human push        -> 5 workflow runs
3 chair fix commits -> 15 more
                       20 runs for one PR
```

Two things to set, especially if agents open most of your PRs:

- **Lower `max_fix_cycles`** to 1 or 2 on high-volume repos. Fixes past the
  second pass are usually the chair arguing with itself, and each one costs a
  full pipeline.
- **Give every `pull_request` workflow a `concurrency` group** so a fix commit
  cancels the run it superseded instead of stacking beside it. `init` already
  writes one into `vibecodereview.yml`; hand-written workflows often lack it.

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

Use `cancel-in-progress: true` for test, lint and scan workflows. Leave it
`false`, or omit the group, on anything that deploys or runs migrations —
cancelling those midway is worse than queueing.

Set `can_push_fixes: false` to get review comments with no commits at all, which
costs one pipeline per PR.

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
