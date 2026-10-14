# vibecodereview

[![npm version](https://img.shields.io/npm/v/vibecodereview)](https://www.npmjs.com/package/vibecodereview) [![Downloads/month](https://img.shields.io/npm/dm/vibecodereview)](https://www.npmjs.com/package/vibecodereview) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/vibecodereview) · [Setup](#send-your-first-review) · [Commands](#runtime-surfaces) · [Compare](#compare) · [Trailer](https://getvibe.dev/vibecodereview)

vibecodereview is an open-source pull-request review tool for maintainers. A large language model (LLM) council reviews diffs through separate lenses. Its GitHub Action adds a chair that checks findings, can push fixes, and posts a review.

## Install

```bash
npm install -g vibecodereview
```

Node.js 20 or newer is required. The npm package has zero runtime dependencies. Local review requires Git; remote pull-request commands require authenticated `gh`.

## Send your first review

Export keys in your shell. The CLI does not load `.env` files automatically. Use a personal repository whose diff you are allowed to send to the configured providers.

```bash
export OPENROUTER_API_KEY='your-key'
vibecodereview doctor
vibecodereview review --base origin/main
```

Run this on a branch with a nonempty source diff against `origin/main`. Success prints council findings with member results. Check for `SKIP/ERR` or skipped-council notes before treating it as reviewed. `doctor` checks whether variables exist; it does not authenticate them.

## How it works

```text
Diff + optional PR claim -> routing and review weight -> applicable council members
                                                       |
                                  Markdown claims <----+
                                        |
GitHub Action only -> chair verifies -> optional fix commit -> one posted review
```

The Action's result gate and budget guards can fail even though the council script exits successfully.

## Why it exists

Maintainers can review one diff through distinct correctness, security, and other lenses with their own provider configuration. CodeRabbit and Devin Review also provide AI-assisted code review. vibecodereview exposes its council engine through a local CLI, a GitHub Action, and Model Context Protocol (MCP).

## Compare

Scope checked on 2026-10-14 against [CodeRabbit documentation](https://docs.coderabbit.ai/) and [Devin Review documentation](https://docs.devin.ai/work-with-devin/devin-review).

| Scope | vibecodereview | CodeRabbit | Devin Review |
|---|---|---|---|
| Review setup | Action inputs and environment | Product configuration | Product configuration |
| Review surface | Action, local CLI, stdio MCP | Pull requests, CLI, IDE | Pull-request review interface |
| Provider selection here | Explicit council roster | Consult product documentation | Consult product documentation |

## Coverage

| Integration | Status | Credential or configuration |
|---|---|---|
| OpenAI | implemented HTTP adapter | `OPENAI_API_KEY` |
| Google Gemini | implemented HTTP adapter | `GEMINI_API_KEY` |
| Moonshot AI / Kimi | implemented HTTP adapter | `MOONSHOT_API_KEY` |
| OpenRouter / DeepSeek / GLM | implemented HTTP adapter | `OPENROUTER_API_KEY` |
| Custom OpenAI-compatible endpoint | implemented HTTP adapter | `CUSTOM_BASE_URL`, `CUSTOM_API_KEY` |
| Anthropic Claude Code | implemented CLI seats | `CLAUDE_CODE_OAUTH_TOKEN` through `_4`, or explicit Anthropic key |
| GitHub | implemented Action and CLI operations | Workflow `github_token` or authenticated `gh` |
| Devin CLI | implemented chair fallback | `devin_cli_key` |
| Cursor CLI | implemented chair fallback | `cursor_api_key` |
| xAI Grok CLI | implemented chair fallback | `xai_api_key` |
| Vibetrace | optional trace delivery | `vibetrace_ingest_url`, optional token |

The provider registry defines nine built-in keys: five HTTP providers and `claude`, `claude2`, `claude3`, `claude4`. Additional numbered Claude tokens create more provider keys dynamically. Five default council members cover correctness, performance, security, maintainability, and scope. Mutation is a sixth, optional lens. Source and offline tests verify implementation paths. No live provider credentials were checked for this rewrite.

## Common use cases

1. GitHub maintainers: run council review and chair verification on owner-authored pull requests.
2. Node.js developers: inspect a local Git diff before pushing.
3. Agent builders: request `council_review` from a Claude Code MCP client.
4. Test authors: enable Claude's mutation lens to propose changes that tests should catch.
5. Multi-repository maintainers: use `review-prs` and authenticated `gh` to inspect open pull requests.

## Features

Features include [lens routing](#lens-routing), [chair verification](#github-action-setup), [budget controls](#delivery-and-behavior-limits), provider fallback, mutation proposals, and optional Vibetrace records.

## Runtime surfaces

`init [--dir .]` writes the workflow and overwrites an existing file. `review [--base <ref>]` prints findings for a tracked diff. `review-prs [--post] [--repo owner/repo]` reviews open PRs and optionally posts comments. `doctor` reports credential presence. `secrets [--repo owner/repo]` prints secret-setting commands without executing them.

The npm package exposes one CLI bin and one MCP tool: `council_review(diff)`. Run the MCP server with `npm run mcp` from its installation directory or `node /path/to/vibecodereview/mcp/server.mjs`.

## Delivery and behavior limits

- Diffs reach configured third-party model providers. Follow this repository's personal/private-code restriction; do not send employer code through personal provider accounts.
- The explicit `anthropic_api_key` input supports an organization-owned Anthropic account. Pass no other provider keys to keep model delivery on that account.
- Council findings are claims. A zero exit code from the council engine does not prove review coverage or defect absence.
- Input preparation caps the combined prompt at 180,000 characters and context at 8,000. Reports disclose truncation.
- HTTP member timeout defaults to 90 seconds; Claude CLI seats default to 240 seconds. Provider fallback can add another request.
- Eligible credential failures allow one OpenRouter reroute. Claude, Codex, and Grok identifiers are rejected on OpenRouter routes.
- `can_push_fixes` defaults to true. Set it to false for review without fix commits.
- `max_fix_cycles` and `max_council_runs` both default to 3. A review-budget stop fails the check and requests human attention.
- The generated workflow only runs for owner-authored PRs and excludes Markdown and `docs/` changes.
- To review prose, adjust workflow path exclusions and set Action input `review_prose: "true"`.
- The mutation lens proposes changes; it does not execute mutation testing. It skips diffs without added test lines.
- Fix commits trigger other pull-request workflows again. Use concurrency controls and budget for repeated CI runs.

### What a fix cycle costs

For five PR workflows and three chair fix commits:

```
1 human push        -> 5 workflow runs
3 chair fix commits -> 15 more
                       20 runs for one PR
```

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

### Lens routing

| Lens | File kinds |
| --- | --- |
| scope | always (every nontrivial delta before review weight) |
| correctness | source, test, CI, deps, agent instructions |
| security | source, CI, deps, agent instructions |
| maintainability | source, test, CI, agent instructions |
| performance | source, style (CSS/SCSS/Less/Sass) |

### Review weight

| Weight | When | Council |
| --- | --- | --- |
| chair | style-only (CSS/SCSS/Less/Sass) | none; chair reviews alone |
| light | tests and/or dependency manifests, no source | correctness plus security or maintainability |
| core | ordinary source | correctness and security |
| full | CI, agent instructions, high-risk paths (auth, payments, migrations, secrets), or an unparseable diff | whatever routing kept |

Set `VCR_LENS_ROUTING=off` or `VCR_REVIEW_WEIGHT=off` to disable the corresponding reduction. `PR_CONTEXT_FILE` supplies the author's claim to scope review. The chair still judges claim alignment when scope is dropped.

## Integration guides

### GitHub Action setup

```bash
npx vibecodereview init                        # writes .github/workflows/vibecodereview.yml
npx vibecodereview secrets --repo owner/name   # prints the gh commands to set the keys
```

Set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` for the normal chair path. Add council keys for the members you want. Commit the workflow and open an owner-authored source PR. Success posts a review from this run; inspect its coverage and check result.

Or wire the action directly:

```yaml
- uses: pooriaarab/vibecodereview@v1
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    claude_code_oauth_token_2: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_2 }}
    claude_code_oauth_token_3: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_3 }}
    claude_code_oauth_token_4: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_4 }}
    github_token: ${{ github.token }}
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
    moonshot_api_key: ${{ secrets.MOONSHOT_API_KEY }}
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    devin_cli_key: ${{ secrets.DEVIN_CLI_KEY }}
    cursor_api_key: ${{ secrets.CURSOR_API_KEY }}
    xai_api_key: ${{ secrets.XAI_API_KEY }}
    vibetrace_ingest_url: ${{ secrets.VIBETRACE_INGEST_URL }}
    vibetrace_ingest_token: ${{ secrets.VIBETRACE_INGEST_TOKEN }}
```

### Provider configuration

`council_models` accepts CSV rows in `provider|model|Name|lens` form. Local runs use `COUNCIL_MODELS`. `claude` through `claude4` run Claude Code CLI seats. Additional tokens numbered 5 and above add matching seats. The Action can try Devin, Cursor, then Grok chair fallbacks after Claude attempts fail, when those credentials are supplied.

### An Anthropic API key instead of seats

```yaml
- uses: pooriaarab/vibecodereview@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    github_token: ${{ github.token }}
    council_models: "claude|claude-opus-5|Opus 5|correctness,claude2|claude-sonnet-5|Sonnet 5|security"
```

Set `anthropic_api_key` and it is the auth for the chair and for every `claude*`
lens. No OAuth seat is consumed, the seat probe does not run, and the key wins
over any `claude_code_oauth_token` passed alongside it. The run logs which of
the two it chose, on a `claude auth:` line, before it spends anything.

The API-key path disables other CLI-chair fallbacks. A bare job-level `ANTHROPIC_API_KEY` is stripped from Claude calls. Locally, where there is no action to
read an input, the engine reads the name the action writes:
`VCR_ANTHROPIC_API_KEY`. `init` does not add the Anthropic input automatically; add it to the workflow when needed.

### Custom / OffRouter provider

```bash
export CUSTOM_BASE_URL=https://your-gateway.example/v1/chat/completions
export CUSTOM_API_KEY=...
export COUNCIL_MODELS="custom|<model>|Name|lens"
```

`CUSTOM_BASE_URL` is the complete `/chat/completions` endpoint URL.

### Review a local diff before you push

```bash
export OPENAI_API_KEY=... MOONSHOT_API_KEY=...   # whichever members you want
vibecodereview review --base origin/main
```

### Review open PRs across repos

```bash
vibecodereview review-prs owner/a owner/b        # print findings per open PR
vibecodereview review-prs --post --repo owner/a  # also comment on each PR
```

Needs an authenticated `gh`. One failing PR does not stop the batch.

### As an MCP tool

```bash
claude mcp add vibecodereview -- node /path/to/vibecodereview/mcp/server.mjs
```

Exposes one tool, `council_review(diff)`. Provider keys come from the server env.

### Set up across many repos

```bash
node bin/rollout.mjs --dry-run owner/a owner/b   # preview; changes nothing
node bin/rollout.mjs owner/a owner/b             # or REPOS="owner/a,owner/b"
```

### Releases

`bin/rollout.mjs` supports dry runs and opens setup PRs without merging. Review its target list and secret handling before use. Releases use immutable `vX.Y.Z` tags plus a moving `vX` tag. Moving `v1` updates Action consumers that follow it. `bin/release.mjs` prints a plan by default; `--apply` pushes release tags. It does not change the committed package version. The publish workflow derives the npm version from the triggering tag.

### What the chair's commits look like

Fix commits use `vibecodereview[bot]`. A commit hook removes model co-author trailers and preserves human co-authors. Optional `file_unfixed_findings` files unresolved candidates as triage issues; it defaults to false.

## Status

The source manifest is version 0.1.1; published versions are stamped from release tags. Check npm and pinned Action tags for deployed versions. Local tests do not establish live provider availability. Use [GitHub issues](https://github.com/pooriaarab/vibecodereview/issues) for support. Run `npm test` for the Node test suite and council selfcheck. CI also runs oxlint and duplicate-code checks.

## FAQ

### Which integrations are verified?

vibecodereview has implemented HTTP, CLI-seat, GitHub, and trace-delivery paths. This rewrite verifies source and offline tests, not live provider credentials.

### Does vibecodereview provide a managed review service?

vibecodereview runs through your configured Action runner or local process. You supply provider credentials and pay their costs.

### How is vibecodereview different from CodeRabbit?

vibecodereview exposes an explicit council roster and a chair workflow in its source. [CodeRabbit](https://docs.coderabbit.ai/) provides review workflows across pull requests, CLI, and IDE surfaces.

### How is vibecodereview different from Devin Review?

vibecodereview runs its council through your chosen provider configuration. [Devin Review](https://docs.devin.ai/work-with-devin/devin-review) provides its own pull-request review interface and workflow.

### Does vibecodereview always push fixes?

vibecodereview permits chair fix commits by default in the Action. Set `can_push_fixes: false` to disable them; local council review only prints findings.

### What happens when a provider key is missing?

vibecodereview can use a configured OpenRouter equivalent or record a skip. Missing council coverage does not mean the diff has no defects.

### Does a passing council script mean my PR was reviewed?

vibecodereview's council engine exits zero even on errors. Read coverage notes and the Action result gate before treating the run as completed review.

### Does the mutation lens run my tests?

vibecodereview's mutation lens proposes code changes that tests should catch. It does not apply those changes or measure mutation-test results.

## License

MIT.
