#!/usr/bin/env bash
# Prove that `require_proof: false` really turns the proof lens off.
#
# The flag reaches the review through TWO independent code paths: the council
# scope lens in council-config.mjs, and the chair's own proof bullet built in
# action.yml. The first version gated only the first path, so a repo that set
# require_proof: false still got a chair demanding screenshots. One path passing
# says nothing about the other, so both are checked here.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
fails=0

report() {
  if [ "$1" = 0 ]; then printf 'ok    %s\n' "$2"
  else printf 'FAIL  %s\n' "$2"; fails=$((fails + 1)); fi
}

# Path 1: the council scope lens.
lens() { REQUIRE_PROOF="$1" node -e 'import("./scripts/council-config.mjs").then(m => process.stdout.write(m.LENSES.scope))'; }
( cd "$ROOT" && lens false | grep -q 'judge the evidence' ) && report 1 'scope lens drops the proof clause when off' || report 0 'scope lens drops the proof clause when off'
( cd "$ROOT" && lens true  | grep -q 'judge the evidence' ) && report 0 'scope lens keeps the proof clause when on'  || report 1 'scope lens keeps the proof clause when on'

# Path 2: the chair's proof bullet, run as the action runs it. The block is
# extracted from action.yml rather than copied, so this test cannot drift from
# what the workflow actually executes.
extract() {
  python3 - "$ROOT/action.yml" <<'PY'
import sys
lines = open(sys.argv[1]).read().splitlines()
start = next(i for i, l in enumerate(lines) if 'if [ "${VCR_REQUIRE_PROOF:-true}" = "false" ]; then' in l)
end = next(i for i in range(start, len(lines)) if lines[i].strip() == "fi")
indent = len(lines[start]) - len(lines[start].lstrip())
print("\n".join(l[indent:] for l in lines[start:end + 1]))
PY
}
BLOCK="$(extract)"
# The bullet is wrapped over several lines, so squeeze the whitespace before
# matching. Otherwise a grep for a phrase fails on where the line happens to break.
chair() { VCR_REQUIRE_PROOF="$1" bash -c "$BLOCK"'; printf "%s" "$PROOF_LENS"' | tr -s '[:space:]' ' '; }
chair false | grep -q 'Do not ask for screenshots' && report 0 'chair bullet turns off when require_proof is false' || report 1 'chair bullet turns off when require_proof is false'
chair false | grep -q 'must carry evidence'         && report 1 'chair bullet drops the demand when off'          || report 0 'chair bullet drops the demand when off'
chair true  | grep -q 'must carry evidence'         && report 0 'chair bullet demands evidence by default'        || report 1 'chair bullet demands evidence by default'
chair ""    | grep -q 'must carry evidence'         && report 0 'an unset flag defaults to demanding evidence'    || report 1 'an unset flag defaults to demanding evidence'

# The rule the chair applies must name the gap that this PR's own review found:
# evidence that tests one file while a later commit changed another.
chair true | grep -q 'leaves untested a code path this PR changes' && report 0 'chair asks for evidence covering every changed path' || report 1 'chair asks for evidence covering every changed path'

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
