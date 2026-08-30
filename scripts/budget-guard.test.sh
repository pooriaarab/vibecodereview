#!/usr/bin/env bash
# Drive the budget arithmetic that action.yml embeds.
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

# Extract the block from action.yml rather than copying it, so the test cannot
# drift from what the action runs.
python3 - "$(dirname "$HERE")/action.yml" "$WORK/guard.py" <<'PY'
import sys
lines = open(sys.argv[1]).read().splitlines()
start = next(i for i, line in enumerate(lines) if line.strip() == "printf '%s' \"$RUNS\" | python3 -c '") + 1
end = next(i for i in range(start, len(lines)) if lines[i].strip() == "'")
indent = len(lines[start]) - len(lines[start].lstrip())
open(sys.argv[2], "w").write("\n".join(line[indent:] for line in lines[start:end]) + "\n")
PY

fails=0
guard() {
  local runs="$1" max_council="$2" max_branch="$3"
  : > "$WORK/out"
  printf '%s' "$runs" | GITHUB_OUTPUT="$WORK/out" VCR_BRANCH=feature VCR_WORKFLOW=vibecodereview \
    VCR_MAX_COUNCIL="$max_council" VCR_MAX_BRANCH="$max_branch" python3 "$WORK/guard.py" >/dev/null 2>&1
  grep '^over=' "$WORK/out" | cut -d= -f2
}
check() {
  local want="$1" name="$2" got="$3"
  if [ "$got" = "$want" ]; then printf 'ok    %s\n' "$name"
  else printf 'FAIL  %s (want over=%s, got over=%s)\n' "$name" "$want" "$got"; fails=$((fails + 1)); fi
}

run() { printf '{"name":"%s","status":"completed","head_branch":"%s"}' "$1" "${2:-feature}"; }
many() {  # many <count> <name> [branch]
  local out="" i
  for i in $(seq "$1"); do [ -z "$out" ] || out="$out,"; out="$out$(run "$2" "${3:-feature}")"; done
  printf '{"workflow_runs":[%s]}' "$out"
}

check false 'a fresh branch is under budget'            "$(guard "$(many 1 vibecodereview)" 6 60)"
check false 'one run below the council ceiling passes'  "$(guard "$(many 5 vibecodereview)" 6 60)"
check true  'the council ceiling stops the review'      "$(guard "$(many 6 vibecodereview)" 6 60)"
check true  'the branch ceiling stops the review'       "$(guard "$(many 8 build)" 6 8)"
check false 'runs on another branch do not count'       "$(guard "$(many 9 vibecodereview other)" 6 60)"
check false 'a zero ceiling disables that check'        "$(guard "$(many 9 vibecodereview)" 0 0)"

# An API blip returns the empty list the action falls back to. Reading that as
# "out of budget" would stop every review in the fleet on one bad request.
check false 'an empty run list is not over budget'      "$(guard '{"workflow_runs":[]}' 6 60)"

# A run still in progress has not cost a full run yet, and counting it would
# stop the very review that is running.
check false 'an in-progress run does not count'         "$(guard '{"workflow_runs":[{"name":"vibecodereview","status":"in_progress","head_branch":"feature"},{"name":"vibecodereview","status":"in_progress","head_branch":"feature"},{"name":"vibecodereview","status":"in_progress","head_branch":"feature"},{"name":"vibecodereview","status":"in_progress","head_branch":"feature"},{"name":"vibecodereview","status":"in_progress","head_branch":"feature"},{"name":"vibecodereview","status":"in_progress","head_branch":"feature"}]}' 6 60)"

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
