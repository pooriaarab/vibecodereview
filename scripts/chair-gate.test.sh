#!/usr/bin/env bash
# Drive the chair result gate that action.yml embeds.
#
# The gate decides whether a pull request's review check goes green, and green
# is the dangerous direction: a red check gets investigated, a green one gets
# merged. The case that matters is the one that shipped — a chair step exits 0
# having reviewed nothing, because claude-code-action refuses to run when the
# pull request edits its own workflow file. A skipped action still exits 0, so
# an outcome-only gate called that success. Eight pull requests in the fleet
# carried that green check on one day.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract the step from action.yml rather than copying it, so the test cannot
# drift from what the action runs.
python3 - "$(dirname "$HERE")/action.yml" "$WORK/gate.sh" <<'PY'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["runs"]["steps"]
gate = next(s for s in steps if s.get("name") == "Chair result gate")
open(sys.argv[2], "w").write(gate["run"])
PY

# Stand in for the reviews query. REVIEWS_JSON is a JSON array of review
# objects, each shaped like the real API (`submitted_at`, `user.login`); the
# stub hands them back one per page, exactly like real `--paginate` output,
# so the gate's own `jq -s` pipeline does the flattening, time filter, and
# login filter for real instead of a preset count standing in for the result.
# It also checks the invocation shape, so dropping `--paginate` or pointing
# at the wrong endpoint fails loudly instead of the stub answering anyway.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$*" in
  *"/reviews"*"--paginate"*) ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;
esac
python3 -c '
import json, os
for r in json.loads(os.environ.get("REVIEWS_JSON", "[]")):
    print(json.dumps([r]))
'
GH
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

export VCR_PR=1 VCR_REPO=owner/repo STARTED_AT=2026-01-01T12:00:00Z
export TOKEN_1=live TOKEN_2=live TOKEN_3=live TOKEN_4=live

fails=0
check() {
  local want="$1" name="$2" got out
  out=$(bash "$WORK/gate.sh" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s (want exit %s, got %s)\n      %s\n' "$name" "$want" "$got" "$(printf '%s' "$out" | head -1)"
    fails=$((fails + 1))
  fi
}

# Asserts on the gate's output rather than its exit code, for behavior (like
# the dead-primary-token warning) that must not flip the pass/fail verdict.
check_output() {
  local mode="$1" needle="$2" name="$3" out
  out=$(bash "$WORK/gate.sh" 2>&1)
  case "$mode" in
    contains)
      if printf '%s' "$out" | grep -qF "$needle"; then
        printf 'ok    %s\n' "$name"
      else
        printf 'FAIL  %s (output did not contain %q)\n' "$name" "$needle"
        fails=$((fails + 1))
      fi
      ;;
    lacks)
      if printf '%s' "$out" | grep -qF "$needle"; then
        printf 'FAIL  %s (output unexpectedly contained %q)\n' "$name" "$needle"
        fails=$((fails + 1))
      else
        printf 'ok    %s\n' "$name"
      fi
      ;;
  esac
}

claude_review() { printf '{"submitted_at":"%s","user":{"login":"claude[bot]"}}' "${1:-2026-01-01T13:00:00Z}"; }
fallback_review() { printf '{"submitted_at":"%s","user":{"login":"github-actions[bot]"}}' "${1:-2026-01-01T13:00:00Z}"; }
vibecodereview_review() { printf '{"submitted_at":"%s","user":{"login":"vibecodereview[bot]"}}' "${1:-2026-01-01T13:00:00Z}"; }
unrelated_review() { printf '{"submitted_at":"%s","user":{"login":"coderabbitai[bot]"}}' "${1:-2026-01-01T13:00:00Z}"; }

# The shipped bug. A step succeeded, nothing was posted, the check went green.
OVER_BUDGET=false P=success B=skipped T=skipped Q=skipped F=skipped REVIEWS_JSON='[]' \
  check 1 'a step that exits 0 without posting fails the gate'

OVER_BUDGET=false P=success B=skipped T=skipped Q=skipped F=skipped REVIEWS_JSON="[$(claude_review)]" \
  check 0 'a posted review passes'

# Failover still works: any chair may fail as long as something posted.
OVER_BUDGET=false P=failure B=success T=skipped Q=skipped F=skipped REVIEWS_JSON="[$(claude_review)]" \
  check 0 'the backup token posting passes'
OVER_BUDGET=false P=failure B=failure T=success Q=skipped F=skipped REVIEWS_JSON="[$(claude_review)]" \
  check 0 'the third token posting passes'
OVER_BUDGET=false P=failure B=failure T=failure Q=success F=skipped REVIEWS_JSON="[$(claude_review)]" \
  check 0 'the fourth token posting passes'
OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=success REVIEWS_JSON="[$(fallback_review)]" \
  check 0 'the OpenRouter fallback posting under github-actions[bot] passes'

# A consumer repo may wire a `vibecodereview[bot]`-backed app token into
# github_token instead of the default github.token, so the fallback's review
# shows up under that login there rather than github-actions[bot].
OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=success REVIEWS_JSON="[$(vibecodereview_review)]" \
  check 0 'the OpenRouter fallback posting under vibecodereview[bot] passes'

OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=failure REVIEWS_JSON='[]' \
  check 1 'every chair failing fails the gate'

# A review that predates this run does not count -- it is evidence of a past
# cycle, not this one.
OVER_BUDGET=false P=failure B=failure T=skipped Q=skipped F=skipped \
  REVIEWS_JSON="[$(claude_review 2026-01-01T11:00:00Z)]" \
  check 1 'a review submitted before this run started does not count'

# The bug this file exists to catch: every chair failed, but an unrelated
# bot (coderabbitai reviews this very repo's PRs) commented on the pull
# request while the run was in flight. Counting it would report success for
# a run that posted nothing.
OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=failure REVIEWS_JSON="[$(unrelated_review)]" \
  check 1 'an unrelated bot review after this run started does not count'

# Real pagination: three reviews returned as three separate pages, only the
# last one qualifying. If `--jq` ran per page instead of over the slurped
# whole, `-gt` would choke on a multi-line count.
OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=success \
  REVIEWS_JSON="[$(unrelated_review 2026-01-01T10:00:00Z), $(claude_review 2026-01-01T11:30:00Z), $(fallback_review)]" \
  check 0 'a qualifying review counts even split across multiple pages'

# Over budget is a routing decision, not a verdict on the code, so it passes
# without a review. Failing here would hide a real failure behind a cost stop.
OVER_BUDGET=true P=skipped B=skipped T=skipped Q=skipped F=skipped REVIEWS_JSON='[]' \
  check 0 'an over-budget run passes without a review'

# The primary subscription failing over to a backup token is easy to miss --
# the gate still goes green -- so it must warn on both the success and
# failure path, not only inside the failure message.
OVER_BUDGET=false P=failure B=success T=skipped Q=skipped F=skipped TOKEN_1=dead TOKEN_2=live \
  REVIEWS_JSON="[$(claude_review)]" \
  check_output contains '::warning::' 'a dead primary token warns even when the gate passes'
OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=failure TOKEN_1=dead TOKEN_2=live \
  REVIEWS_JSON='[]' \
  check_output contains '::warning::' 'a dead primary token warns when the gate also fails'
OVER_BUDGET=false P=success B=skipped T=skipped Q=skipped F=skipped TOKEN_1=live TOKEN_2=live \
  REVIEWS_JSON="[$(claude_review)]" \
  check_output lacks '::warning::' 'a live primary token warns of nothing'

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
