#!/usr/bin/env bash
# Count claude[bot] reviews on a pull request. Isolated from action.yml so the
# test can drive the exact code the action runs, the same as the removed
# fetch-runs-json.sh did for the old run-count check.
#
# gh's own --jq flag applies the filter per page, so a review count spread
# across pages would print one number per page instead of a total. Piping the
# raw --paginate output into `jq -s` (slurp) instead flattens every page into
# one array first, the same pattern the "Route the pull request to a person"
# step already uses for issue comments.
#
# A failed or malformed lookup fails open to 0, never blocking a review on an
# API blip.
set -uo pipefail

REPO="$1"
PR_NUM="$2"

RAW=$(gh api --paginate "repos/$REPO/pulls/$PR_NUM/reviews" \
  --method GET -f per_page=100 2>/dev/null) || RAW=""
printf '%s' "$RAW" | jq -s '[.[][]? | select(.user.login == "claude[bot]")] | length' 2>/dev/null \
  || echo 0
