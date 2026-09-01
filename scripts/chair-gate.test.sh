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

# Stand in for the reviews query. REVIEWS_POSTED is what the real API would
# return for reviews submitted since this run started.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "${REVIEWS_POSTED:-0}"
GH
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

export VCR_PR=1 VCR_REPO=owner/repo STARTED_AT=2026-01-01T00:00:00Z
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

# The shipped bug. A step succeeded, nothing was posted, the check went green.
OVER_BUDGET=false P=success B=skipped T=skipped Q=skipped F=skipped REVIEWS_POSTED=0 \
  check 1 'a step that exits 0 without posting fails the gate'

OVER_BUDGET=false P=success B=skipped T=skipped Q=skipped F=skipped REVIEWS_POSTED=1 \
  check 0 'a posted review passes'

# Failover still works: any chair may fail as long as something posted.
OVER_BUDGET=false P=failure B=success T=skipped Q=skipped F=skipped REVIEWS_POSTED=1 \
  check 0 'the backup token posting passes'
OVER_BUDGET=false P=failure B=failure T=success Q=skipped F=skipped REVIEWS_POSTED=1 \
  check 0 'the third token posting passes'
OVER_BUDGET=false P=failure B=failure T=failure Q=success F=skipped REVIEWS_POSTED=1 \
  check 0 'the fourth token posting passes'
OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=success REVIEWS_POSTED=1 \
  check 0 'the OpenRouter fallback posting passes'

OVER_BUDGET=false P=failure B=failure T=failure Q=failure F=failure REVIEWS_POSTED=0 \
  check 1 'every chair failing fails the gate'

# Over budget is a routing decision, not a verdict on the code, so it passes
# without a review. Failing here would hide a real failure behind a cost stop.
OVER_BUDGET=true P=skipped B=skipped T=skipped Q=skipped F=skipped REVIEWS_POSTED=0 \
  check 0 'an over-budget run passes without a review'

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
