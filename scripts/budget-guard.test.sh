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
WORKFLOW_PATH=".github/workflows/vibecodereview.yml"
guard() {
  local runs="$1" max_council="$2" max_branch="$3"
  : > "$WORK/out"
  printf '%s' "$runs" | GITHUB_OUTPUT="$WORK/out" VCR_BRANCH=feature VCR_REPO=o/r \
    VCR_WORKFLOW_REF="o/r/$WORKFLOW_PATH@refs/heads/feature" \
    VCR_MAX_COUNCIL="$max_council" VCR_MAX_BRANCH="$max_branch" python3 "$WORK/guard.py" >/dev/null 2>&1
  grep '^over=' "$WORK/out" | cut -d= -f2
}
check() {
  local want="$1" name="$2" got="$3"
  if [ "$got" = "$want" ]; then printf 'ok    %s\n' "$name"
  else printf 'FAIL  %s (want over=%s, got over=%s)\n' "$name" "$want" "$got"; fails=$((fails + 1)); fi
}

# Identify by path rather than by github.workflow's display name, which is not
# unique in a repo — a second workflow file with the same `name:` must not
# count toward this workflow's ceiling.
run() { printf '{"path":"%s","status":"completed","head_branch":"%s"}' "$1" "${2:-feature}"; }
many() {  # many <count> <path> [branch]
  local out="" i
  for i in $(seq "$1"); do [ -z "$out" ] || out="$out,"; out="$out$(run "$2" "${3:-feature}")"; done
  printf '{"workflow_runs":[%s]}' "$out"
}

check false 'a fresh branch is under budget'            "$(guard "$(many 1 "$WORKFLOW_PATH")" 6 60)"
check false 'one run below the council ceiling passes'  "$(guard "$(many 5 "$WORKFLOW_PATH")" 6 60)"
check true  'the council ceiling stops the review'      "$(guard "$(many 6 "$WORKFLOW_PATH")" 6 60)"
check true  'the branch ceiling stops the review'       "$(guard "$(many 8 .github/workflows/build.yml)" 6 8)"
check false 'runs on another branch do not count'       "$(guard "$(many 9 "$WORKFLOW_PATH" other)" 6 60)"
check false 'a zero ceiling disables that check'        "$(guard "$(many 9 "$WORKFLOW_PATH")" 0 0)"
check false 'a different workflow path does not count'  "$(guard "$(many 6 .github/workflows/other.yml)" 6 60)"

# An API blip returns the empty list the action falls back to. Reading that as
# "out of budget" would stop every review in the fleet on one bad request.
check false 'an empty run list is not over budget'      "$(guard '{"workflow_runs":[]}' 6 60)"

# A run still in progress has not cost a full run yet, and counting it would
# stop the very review that is running.
check false 'an in-progress run does not count'         "$(guard '{"workflow_runs":[{"path":".github/workflows/vibecodereview.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/vibecodereview.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/vibecodereview.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/vibecodereview.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/vibecodereview.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/vibecodereview.yml","status":"in_progress","head_branch":"feature"}]}' 6 60)"

# The same holds for the branch ceiling: several workflows queuing at once on a
# fresh push must not look like spend that already happened.
check false 'in-progress runs do not count toward the branch ceiling' "$(guard '{"workflow_runs":[{"path":".github/workflows/build.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/build.yml","status":"queued","head_branch":"feature"},{"path":".github/workflows/build.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/build.yml","status":"queued","head_branch":"feature"},{"path":".github/workflows/build.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/build.yml","status":"queued","head_branch":"feature"},{"path":".github/workflows/build.yml","status":"in_progress","head_branch":"feature"},{"path":".github/workflows/build.yml","status":"queued","head_branch":"feature"}]}' 6 8)"

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
