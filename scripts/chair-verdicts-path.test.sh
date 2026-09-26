#!/usr/bin/env bash
# Prove the council_start chair-verdicts path is checkout-root ($PWD), not
# RUNNER_TEMP or git-dir, and that a Write to that path succeeds in a fresh repo.
#
# Extracts the actual lines from action.yml (rather than hand-copying them) so
# a regression there -- e.g. reverting VCR_CHAIR_VERDICTS back to
# $RUNNER_TEMP -- fails this test instead of a duplicate silently passing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION_YML="$ROOT/action.yml"

ASSIGN_LINE="$(grep -m1 'VCR_CHAIR_VERDICTS="\$PWD/chair-verdicts.json"' "$ACTION_YML")"
ASSERT_LINE="$(grep -m1 'chair-verdicts-path.mjs" --assert' "$ACTION_YML")"
VERDICTS_LINE="$(grep -m1 "printf 'VCR_CHAIR_VERDICTS=" "$ACTION_YML")"
EXCLUDE_LINE="$(grep -m1 '/chair-verdicts\.json.*info/exclude' "$ACTION_YML")"

if [[ -z "$ASSIGN_LINE" || -z "$ASSERT_LINE" ]]; then
  echo "FAIL could not find chair-verdicts path guard in action.yml" >&2
  exit 1
fi
if [[ -z "$VERDICTS_LINE" ]]; then
  echo "FAIL could not find the VCR_CHAIR_VERDICTS printf line in action.yml" >&2
  exit 1
fi
if [[ -z "$EXCLUDE_LINE" ]]; then
  echo "FAIL could not find the chair-verdicts.json info/exclude line in action.yml" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
git init -q
git config user.email "path@test.example"
git config user.name "Path Test"
echo init > README.md
git add README.md
git commit -q -m init

export PWD="$WORK"
export GITHUB_ENV="$WORK/env.out"
eval "$ASSIGN_LINE"
if node "$ROOT/scripts/chair-verdicts-path.mjs" --assert "$VCR_CHAIR_VERDICTS"; then
  : "guard passed"
else
  echo "FAIL chair-verdicts-path guard must pass for untracked scratch path" >&2
  exit 1
fi
eval "$VERDICTS_LINE"
eval "$EXCLUDE_LINE"

# shellcheck disable=SC1090
source "$WORK/env.out"

case "$VCR_CHAIR_VERDICTS" in
  "$PWD/chair-verdicts.json") ;;
  *)
    echo "FAIL VCR_CHAIR_VERDICTS must be checkout-root, got: $VCR_CHAIR_VERDICTS" >&2
    exit 1
    ;;
esac

if [[ "$VCR_CHAIR_VERDICTS" == *"/.git/"* ]]; then
  echo "FAIL path must not live under .git/: $VCR_CHAIR_VERDICTS" >&2
  exit 1
fi

printf '{"verdict":"approve","dispositions":[]}\n' >"$VCR_CHAIR_VERDICTS"
if ! test -f "$VCR_CHAIR_VERDICTS"; then
  echo "FAIL Write to checkout-root verdict path did not create file" >&2
  exit 1
fi

if ! grep -qx '/chair-verdicts.json' "$(git rev-parse --git-dir)/info/exclude"; then
  echo "FAIL info/exclude missing /chair-verdicts.json" >&2
  exit 1
fi

if git ls-files --error-unmatch -- "$VCR_CHAIR_VERDICTS" >/dev/null 2>&1; then
  echo "FAIL scratch verdict file must not be git-tracked" >&2
  exit 1
fi

# Consumer PRs can track this path even when info/exclude hides it from status.
git add -f chair-verdicts.json
git commit -q -m "track verdicts"
if node "$ROOT/scripts/chair-verdicts-path.mjs" --assert "$VCR_CHAIR_VERDICTS"; then
  echo "FAIL chair-verdicts-path guard must fail when path is git-tracked" >&2
  exit 1
fi

echo "ok - checkout-root VCR_CHAIR_VERDICTS write and exclude"
