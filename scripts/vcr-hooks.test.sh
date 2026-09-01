#!/usr/bin/env bash
# Drive the prepare-commit-msg hook that action.yml embeds.
#
# The hook is what keeps a chair fix commit from carrying a model trailer that
# the fleet's pr-standards check rejects. Its own PR documented two near-misses
# during development (writing to a global hooksPath, and the hook file itself
# getting swept into a commit) -- this pins the part neither of those touched:
# which trailer lines actually get stripped.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fails=0

# Extract the hook from action.yml rather than copying it, so the test cannot
# drift from what the action writes.
python3 - "$(dirname "$HERE")/action.yml" "$WORK/hook.py" <<'PY'
import sys
lines = open(sys.argv[1]).read().splitlines()
start = next(i for i, line in enumerate(lines)
             if line.strip() == 'cat > "$VCR_HOOKS_DIR/prepare-commit-msg" <<\'VCR_HOOK_EOF\'') + 1
end = next(i for i in range(start, len(lines)) if lines[i].strip() == "VCR_HOOK_EOF")
indent = len(lines[start]) - len(lines[start].lstrip())
open(sys.argv[2], "w").write("\n".join(line[indent:] for line in lines[start:end]) + "\n")
PY

check() {
  local name="$1" input="$2" want="$3"
  printf '%s' "$input" > "$WORK/msg"
  python3 "$WORK/hook.py" "$WORK/msg"
  # $() strips ALL trailing newlines, on both sides, so a want/got pair that
  # differs only in how many trailing blank lines survived does not false-fail.
  local got
  got="$(cat "$WORK/msg")"
  want="$(printf '%s' "$want")"
  if [ "$got" = "$want" ]; then printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    printf '      want: %q\n      got:  %q\n' "$want" "$got"
    fails=$((fails + 1))
  fi
}

check 'strips a Claude trailer' \
  'fix: the thing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>' \
  'fix: the thing'

check 'keeps a human co-author' \
  'fix: the thing

Co-authored-by: Jane Human <jane@example.com>' \
  'fix: the thing

Co-authored-by: Jane Human <jane@example.com>'

check 'keeps vibecodereview, the standard exempts it by name' \
  'fix: the thing

Co-authored-by: vibecodereview <vibecodereview@users.noreply.github.com>' \
  'fix: the thing

Co-authored-by: vibecodereview <vibecodereview@users.noreply.github.com>'

# The exact three-trailer case from the PR body: one stripped, two kept.
check 'strips only the model trailer among several' \
  'fix: the thing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-authored-by: vibecodereview <vibecodereview@users.noreply.github.com>
Co-authored-by: Jane Human <jane@example.com>' \
  'fix: the thing

Co-authored-by: vibecodereview <vibecodereview@users.noreply.github.com>
Co-authored-by: Jane Human <jane@example.com>'

check 'matches case-insensitively' \
  'fix: the thing

co-authored-by: codex <bot@openai.com>' \
  'fix: the thing'

# GPT is a substring of names like "gptperson" -- the ban must not fire on a
# word it merely contains.
check 'does not strip a trailer that only contains the word as a substring' \
  'fix: the thing

Co-authored-by: Grace Optperson <gptperson@example.com>' \
  'fix: the thing

Co-authored-by: Grace Optperson <gptperson@example.com>'

# The fleet's pr-standards config explicitly bans a "pi" trailer alongside
# Claude, Codex, Gemini, Kimi, Muse, Copilot and Cursor.
check 'strips a Pi trailer' \
  'fix: the thing

Co-authored-by: pi <noreply@inflection.ai>' \
  'fix: the thing'

# Wired: the hook directory must come from git-dir, not the working tree, or
# it can collide with a tracked file and `git add -A` can ship it into the
# repo it is reviewing -- both near-misses during this PR's development.
grep -q 'git rev-parse --git-dir.*/vcr-hooks' "$(dirname "$HERE")/action.yml" \
  && printf 'ok    %s\n' 'hook directory is derived from git-dir, not the working tree' \
  || { printf 'FAIL  %s\n' 'hook directory is derived from git-dir, not the working tree'; fails=$((fails + 1)); }

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
