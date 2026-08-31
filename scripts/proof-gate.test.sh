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

# Path 0: action.yml must actually wire the `require_proof` input to both env
# vars. Paths 1 and 2 below inject REQUIRE_PROOF/VCR_REQUIRE_PROOF directly, so
# they'd stay green even if this wiring were broken or renamed — which is
# exactly the class of bug this whole file exists to catch.
grep -q 'REQUIRE_PROOF: ${{ inputs.require_proof }}' "$ROOT/action.yml" \
  && report 0 'action.yml wires require_proof input to REQUIRE_PROOF' \
  || report 1 'action.yml wires require_proof input to REQUIRE_PROOF'
grep -q 'VCR_REQUIRE_PROOF: ${{ inputs.require_proof }}' "$ROOT/action.yml" \
  && report 0 'action.yml wires require_proof input to VCR_REQUIRE_PROOF' \
  || report 1 'action.yml wires require_proof input to VCR_REQUIRE_PROOF'

grep -q 'VCR_REQUIRE_PROOF: ${{ inputs.require_proof }}' "$ROOT/action.yml" \
  && report 0 'action.yml wires require_proof to the fallback chair too' \
  || report 1 'action.yml wires require_proof to the fallback chair too'
# The fallback chair judges nothing it cannot see. Without the PR body it can
# never apply the proof rule, however well the rule is worded.
[ "$(grep -c 'PR_CONTEXT_FILE: ${{ runner.temp }}/pr-context.txt' "$ROOT/action.yml")" -ge 2 ] \
  && report 0 'action.yml gives the fallback chair the PR body' \
  || report 1 'action.yml gives the fallback chair the PR body'

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

# The scope lens must carry the same changed-path rule as the chair. One of the
# two carrying it is how a rule reaches a review only when a subscription is up.
( cd "$ROOT" && lens true | grep -q 'leaves untested a code path this PR changes' ) \
  && report 0 'scope lens asks for evidence covering every changed path' \
  || report 1 'scope lens asks for evidence covering every changed path'

# Path 3: the OpenRouter fallback chair. It runs only when every Claude
# subscription has failed, and it had no proof rule at all — so an outage
# silently turned proof off while the check still reported green.
fallback() { VCR_REQUIRE_PROOF="$1" node --input-type=module -e '
const src = await import("node:fs").then(m => m.readFileSync("scripts/chair-fallback.mjs", "utf8"));
const on = process.env.VCR_REQUIRE_PROOF !== "false";
const rule = src.includes("Judge the evidence too");
const gated = src.includes("VCR_REQUIRE_PROOF !== \"false\"");
process.stdout.write(rule && gated ? (on ? "on" : "off") : "missing");
'; }
( cd "$ROOT" && [ "$(fallback true)" = on ] ) \
  && report 0 'fallback chair carries a proof rule, gated on the flag' \
  || report 1 'fallback chair carries a proof rule, gated on the flag'
( cd "$ROOT" && grep -q 'PR title, body and linked issues' scripts/chair-fallback.mjs ) \
  && report 0 'fallback chair is sent the body it must judge' \
  || report 1 'fallback chair is sent the body it must judge'

# The fallback chair's rule must carry the SAME criteria as the primary chair's
# and the scope lens's, not just any proof rule. A rule that demands evidence
# but never checks for a wrong-screen screenshot or a stale capture is a
# weaker gate hiding behind the same "proof required" label.
( cd "$ROOT" && grep -q 'embedded screenshot shows a screen this diff does not touch' scripts/chair-fallback.mjs ) \
  && report 0 'fallback chair rejects a wrong-screen screenshot' \
  || report 1 'fallback chair rejects a wrong-screen screenshot'
( cd "$ROOT" && grep -q 'predates the newest commit that touched a path it exercises' scripts/chair-fallback.mjs ) \
  && report 0 'fallback chair rejects stale evidence' \
  || report 1 'fallback chair rejects stale evidence'

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
