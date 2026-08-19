# vibecodereview

**A council of AI models reviews your PR — many models, one check.**

Each model reviews the diff through a different lens, so they catch different
things. Claude chairs: it verifies every claim against the code, drops false
positives, fixes what it can confirm, pushes the fix, and posts one review. The
check heals itself toward green.

Part of the **Vibe Suite**.

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

## Review a local diff before you push

```bash
export OPENAI_API_KEY=... MOONSHOT_API_KEY=...   # whichever members you want
vibecodereview review --base origin/main
```

## As an MCP tool

```bash
claude mcp add vibecodereview -- node /path/to/vibecodereview/mcp/server.mjs
```

Exposes one tool, `council_review(diff)`. Provider keys come from the server env.

## Notes

- Subscriptions (codex-personal, gemini-personal, muse) don't reach a CI runner —
  CI uses each provider's **API key**. Only Claude's OAuth token ports to CI.
- Rotate any key you paste into a chat or terminal history.
