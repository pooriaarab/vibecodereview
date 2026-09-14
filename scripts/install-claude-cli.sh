#!/usr/bin/env bash
# Ensure the Claude Code native binary is on PATH.
#
# Two callers need it and both die immediately without it:
# anthropics/claude-code-action (the chair) fails "native binary not found",
# and a claude*-provider council seat (scripts/claude-cli-seat.mjs) fails
# "spawn claude ENOENT". VCR-163 shipped only the second failure, because the
# chair's copy of this install ran after the council fan-out had already
# spawned every seat.
#
# Idempotent on purpose: action.yml now calls this from two step positions --
# once early, only when the resolved council roster has a CLI seat, and once
# later, unconditionally for the chair -- and the check-then-skip below is
# what keeps the second call in a job from downloading the binary twice, same
# as it already did for a caller workflow that installed it before this
# action even started.
set -euo pipefail
echo "$HOME/.local/bin" >> "$GITHUB_PATH"
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  echo "Claude Code CLI already present; skipping install."
else
  # Retry the download. Every later step -- the council fan-out, all three
  # chair attempts, the OpenRouter fallback -- runs after this one, so a
  # single connection reset here loses the whole review and none of those
  # fallbacks gets a turn. --retry-all-errors is the flag that makes a reset
  # retryable: on its own --retry covers transient HTTP statuses and
  # timeouts, and a reset is neither.
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    https://claude.ai/install.sh -o "$RUNNER_TEMP/install-claude.sh"
  bash "$RUNNER_TEMP/install-claude.sh"
fi
