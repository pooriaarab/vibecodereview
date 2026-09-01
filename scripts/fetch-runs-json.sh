#!/usr/bin/env bash
# Fetch one valid Actions runs document. API errors and malformed responses
# fail open to an empty list, so the review still runs.
set -uo pipefail

OUT="$1"
REPO="$2"
BRANCH="$3"

if ! gh api "repos/$REPO/actions/runs" --method GET \
  -f branch="$BRANCH" -f per_page=100 > "$OUT" 2>/dev/null; then
  printf '%s' '{"workflow_runs":[]}' > "$OUT"
  exit 0
fi

if ! python3 - "$OUT" 2>/dev/null <<'PY'
import json, sys

with open(sys.argv[1]) as source:
    data = json.load(source)
if not isinstance(data, dict) or not isinstance(data.get("workflow_runs"), list):
    raise SystemExit(1)
PY
then
  printf '%s' '{"workflow_runs":[]}' > "$OUT"
fi
