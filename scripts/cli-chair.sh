#!/usr/bin/env bash
# Last-resort chair: the SAME chair prompt the Claude seats run, driven by a
# CLI seat on another vendor's subscription. Runs only after every Claude
# attempt failed. Tries Devin, then Cursor, and stops at the first seat that
# POSTS a review -- a seat that exits 0 with nothing posted counts as failed,
# the same evidence rule the result gate applies.
#
# Why CLI seats and not one HTTP completion: the old fallback was a single
# OpenRouter call, so one key's monthly cap removed the whole fallback
# (pooriaarab/clis#131, run 36781039423). A CLI seat is an agent with a shell,
# so it follows the full prompt: reads the files, pushes fixes when allowed,
# writes the verdicts file to $VCR_CHAIR_VERDICTS, and posts with `gh`.
#
# Grok is not a seat here. The Grok CLI signs in with a SuperGrok OIDC
# session (a 6-hour access token and a rotating refresh token), so a copy in
# CI would revoke the laptop login or die within hours.
#
# Each seat sees only its own credential. The other seat's key is unset for
# the run, and the Devin credentials file is deleted after its attempt.
#
# Env: VCR_PROMPT, GH_TOKEN, VCR_REPO, VCR_PR, VCR_STARTED_AT,
#      VCR_CHAIR_VERDICTS, DEVIN_CLI_KEY, CURSOR_API_KEY
set -uo pipefail

SEAT_TIMEOUT=900
DEVIN_MODEL=swe-2-max
CURSOR_MODEL=cursor-grok-4.6-high-fast
PROMPT_FILE="$RUNNER_TEMP/cli-chair-prompt.txt"
DEVIN_CREDS="$HOME/.local/share/devin/credentials.toml"
export PATH="$HOME/.local/bin:$PATH"

# Same logins as the result gate: `gh pr review` on the caller's token posts
# as github-actions[bot], or vibecodereview[bot] on an app token.
posted() {
  gh api "repos/$VCR_REPO/pulls/$VCR_PR/reviews" --paginate 2>/dev/null \
    | jq -s --arg t "$VCR_STARTED_AT" '[.[][] | select(.submitted_at >= $t and
        (.user.login == "github-actions[bot]" or .user.login == "vibecodereview[bot]"))] | length' 2>/dev/null \
    || echo 0
}

fetch_cli() {
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "$1" -o "$RUNNER_TEMP/install-$2.sh" \
    && bash "$RUNNER_TEMP/install-$2.sh" >/dev/null
}

devin_seat() {
  fetch_cli https://cli.devin.ai/install.sh devin || return 1
  mkdir -p "$(dirname "$DEVIN_CREDS")"
  (umask 077; printf 'windsurf_api_key = "%s"\n' "$DEVIN_CLI_KEY" > "$DEVIN_CREDS")
  env -u CURSOR_API_KEY -u DEVIN_CLI_KEY timeout "$SEAT_TIMEOUT" \
    devin -p --prompt-file "$PROMPT_FILE" --model "$DEVIN_MODEL" \
      --permission-mode dangerous --respect-workspace-trust false
  local rc=$?
  rm -f "$DEVIN_CREDS"
  return "$rc"
}

cursor_seat() {
  fetch_cli https://cursor.com/install cursor || return 1
  env -u DEVIN_CLI_KEY timeout "$SEAT_TIMEOUT" \
    cursor-agent -p -f --trust --model "$CURSOR_MODEL" --output-format text "$(cat "$PROMPT_FILE")"
}

if [ ${#VCR_PROMPT} -lt 200 ]; then
  echo "::error::cli chair: the chair prompt is empty; refusing to run a seat with nothing to do"
  exit 1
fi
printf '%s\n' "$VCR_PROMPT" > "$PROMPT_FILE"

tried=""
for seat in devin cursor; do
  case "$seat" in
    devin)  key="${DEVIN_CLI_KEY:-}" ;;
    cursor) key="${CURSOR_API_KEY:-}" ;;
  esac
  if [ -z "$key" ]; then
    echo "cli chair: $seat skipped (no credential passed)"
    continue
  fi
  tried="$tried $seat"
  # A seat that died mid-run can leave a verdicts file behind; the next seat
  # must not inherit it.
  rm -f "$VCR_CHAIR_VERDICTS"
  echo "::group::cli chair: $seat"
  case "$seat" in
    devin)  devin_seat ;;
    cursor) cursor_seat ;;
  esac
  rc=$?
  echo "::endgroup::"
  n="$(posted)"
  if [ "${n:-0}" -gt 0 ]; then
    echo "cli chair: $seat posted $n review(s) (exit $rc)"
    exit 0
  fi
  echo "cli chair: $seat posted no review (exit $rc)"
done

echo "::error::cli chair: no seat posted a review (tried:${tried:- none})"
exit 1
