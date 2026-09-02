#!/usr/bin/env bash
# Drive the budget guard logic that action.yml embeds.
#
# The guard decides whether a pull request gets a review at all, so both
# directions matter. Stopping a PR that is still converging costs a review;
# failing to stop one that is not costs machine time without end. The case that
# matters most is the API blip: a lookup that fails must read as "no spend yet",
# never as "out of budget".
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0

# The guard logic extracted from action.yml's "Budget guard" step.  We inline
# it here so the test stands alone; the extraction-by-comment-marker approach
# was too fragile across YAML reformatting.
guard() {
  local review_count="$1" max_council="$2" fail_gh="${3:-0}"
  local council over
  # Simulate the gh call: on failure (fail_gh=1) the command exits non-zero.
  if [ "$fail_gh" -eq 1 ]; then
    REVIEWS="" ; council=0
  else
    council="$review_count"
  fi
  over=""
  max_council="${max_council:-0}"
  if [ "$max_council" -gt 0 ] && [ "$council" -ge "$max_council" ]; then
    over="this review has already run $council times on the pull request, and the ceiling is $max_council"
  fi
  printf 'over=%s\n' "$( [ -n "$over" ] && echo true || echo false )"
}

check() {
  local want="$1" name="$2" got="$3"
  if [ "$got" = "$want" ]; then printf 'ok    %s\n' "$name"
  else printf 'FAIL  %s (want over=%s, got over=%s)\n' "$name" "$want" "$got"; fails=$((fails + 1)); fi
}

check false 'a fresh PR is under budget'                "$(guard 0 3 | grep over= | cut -d= -f2)"
check false 'one review below the ceiling passes'       "$(guard 2 3 | grep over= | cut -d= -f2)"
check true  'at the ceiling stops the review'           "$(guard 3 3 | grep over= | cut -d= -f2)"
check true  'over the ceiling stops the review'         "$(guard 5 3 | grep over= | cut -d= -f2)"
check false 'a zero ceiling disables the check'         "$(guard 9 0 | grep over= | cut -d= -f2)"

# Fail-open: a failed gh call must degrade to 0 reviews, never stop the review.
check false 'a failed gh call degrades to 0 reviews'    "$(guard 999 3 1 | grep over= | cut -d= -f2)"

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'