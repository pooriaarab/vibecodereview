---
name: vibecodereview
description: Review a code diff with a council of AI models before pushing or merging. Use when the user wants a multi-model review of local changes, a PR, or a diff — "council review", "review my diff", "what would the models flag", "second opinion on this PR". Runs correctness, performance, security, and maintainability lenses in parallel and returns findings.
---

# vibecodereview — council diff review

Send a diff to several models at once, each reviewing through a different lens,
then read back the combined findings. Catches what one reviewer misses.

## Review the working diff

```bash
vibecodereview review --base origin/main
```

Or a specific diff file via the engine directly:

```bash
node scripts/council-review.mjs <diff-file> <out.md> && cat <out.md>
```

## Keys

Set the provider keys for the members you want (any subset). Missing key → that
member is skipped, not an error:

- `OPENAI_API_KEY` — correctness
- `GEMINI_API_KEY` — performance
- `MOONSHOT_API_KEY` — security
- `OPENROUTER_API_KEY` — maintainability (Grok / DeepSeek)

## Set it up in a repo (CI)

```bash
vibecodereview init                      # writes .github/workflows/vibecodereview.yml
vibecodereview secrets --repo owner/name # prints the gh secret commands
```

The CI chair (Claude via `CLAUDE_CODE_OAUTH_TOKEN`) verifies each finding, fixes
confirmed issues, pushes, and posts one review.

## Rules

- Findings are co-reviewer input, not ground truth. Verify each against the code
  before acting; discard false positives.
- Personal / private repos only — diffs go to third-party providers.
