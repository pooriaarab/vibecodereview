#!/usr/bin/env bash
# Drive the trivial-delta chair skip that action.yml embeds.
#
# The chair is the only step that posts a review and finishes the check.
# Skipping it on a docs-only delta without a cheap stand-in leaves the
# consumer check with no conclusion. This file extracts the real steps
# so a renamed gate or a dropped conjunct fails here, not in the fleet.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fails=0

python3 - "$ROOT/action.yml" "$WORK/meta.json" <<'PY'
import json, sys, yaml
action = yaml.safe_load(open(sys.argv[1]))
steps = action["runs"]["steps"]
by_name = {s.get("name"): s for s in steps}
open(sys.argv[2], "w").write(json.dumps({
  "names": [s.get("name") for s in steps],
  "steps": [
    {
      "name": s.get("name"),
      "id": s.get("id"),
      "if": s.get("if") or "",
      "run": s.get("run") or "",
      "uses": s.get("uses") or "",
    }
    for s in steps
  ],
}, indent=2))
PY

report() {
  if [ "$1" = 0 ]; then printf 'ok    %s\n' "$2"
  else printf 'FAIL  %s\n' "$2"; fails=$((fails + 1)); fi
}

python3 - "$WORK/meta.json" <<'PY'
import json, sys
meta = json.load(open(sys.argv[1]))
steps = {s["name"]: s for s in meta["steps"]}
fails = 0

def ok(cond, name):
    global fails
    if cond:
        print(f"ok    {name}")
    else:
        print(f"FAIL  {name}")
        fails += 1

GATE = "Chair result gate"
ok(GATE in steps, "action.yml still has Chair result gate")
ok(steps.get(GATE, {}).get("if") == "", "Chair result gate has no if (runs on trivial and non-trivial)")
ok("trivial" not in steps.get(GATE, {}).get("if", ""), "Chair result gate is not skipped when the delta is trivial")

start = steps.get("Council fan-out (start)", {})
ok(start.get("id") == "council_start", "council start step id is council_start")
ok("trivial=$TRIVIAL" in start.get("run", ""), "council start writes a trivial output")
ok("trivial-chair.mjs" in start.get("run", "") and "--classify" in start.get("run", ""),
   "council start classifies with trivial-chair.mjs --classify")

trivial = steps.get("Trivial delta review", {})
ok(bool(trivial), "action.yml has Trivial delta review")
ok(trivial.get("id") == "trivial_review", "trivial review step id is trivial_review")
ok("steps.council_start.outputs.trivial == 'true'" in trivial.get("if", ""),
   "trivial review runs only when the delta is trivial")
ok("steps.budget.outputs.over != 'true'" in trivial.get("if", ""),
   "trivial review still respects the budget guard")
ok("trivial-chair.mjs" in trivial.get("run", ""), "trivial review runs trivial-chair.mjs")
ok("check-runs" not in trivial.get("run", ""), "trivial review does not create a different check-run")

chair_names = [
    "Install Claude Code CLI",
    "Fix-cycle guard",
    "Build chair prompt",
    "Probe chair tokens",
    "Chair review (primary token)",
    "Chair review (backup token)",
    "Chair review (third token)",
    "Chair review (fourth token)",
    "Chair fallback (OpenRouter)",
    "Clear stale chair-verdicts.json before backup attempt",
    "Clear stale chair-verdicts.json before third attempt",
    "Clear stale chair-verdicts.json before fourth attempt",
    "Clear stale chair-verdicts.json before fallback",
]
skip = "steps.council_start.outputs.trivial != 'true'"
for name in chair_names:
    step = steps.get(name, {})
    ok(skip in (step.get("if") or ""), f"{name} skips when the delta is trivial")

primary = steps.get("Chair review (primary token)", {})
primary_if = primary.get("if") or ""
ok("steps.budget.outputs.over != 'true'" in primary_if, "non-trivial chair still requires the budget guard")
ok("steps.chair_probe.outputs.token_1 != 'dead'" in primary_if, "non-trivial chair still requires a live primary token")
ok(primary.get("uses") == "anthropics/claude-code-action@v1", "non-trivial chair still uses claude-code-action")

names = meta["names"]
ok("Trivial delta review" in names and GATE in names
   and names.index("Trivial delta review") < names.index(GATE),
   "trivial review posts before the result gate")
ok("Trivial delta review" in names and "Chair review (primary token)" in names
   and names.index("Chair review (primary token)") < names.index("Trivial delta review"),
   "trivial review sits after the model chairs so a stale-verdict clear cannot wipe it")

sys.exit(fails)
PY
py_fails=$?
fails=$((fails + py_fails))

# The check consumers gate on is the job that contains this composite action.
# Neither path may mint a differently named check-run.
grep -q 'check-runs' "$ROOT/scripts/trivial-chair.mjs" \
  && report 1 'trivial-chair.mjs does not mint a check-run' \
  || report 0 'trivial-chair.mjs does not mint a check-run'
grep -q 'name: Chair result gate' "$ROOT/action.yml" \
  && report 0 'verdict step name is still Chair result gate' \
  || report 1 'verdict step name is still Chair result gate'
grep -qE '^  review:$' "$ROOT/.github/workflows/vibecodereview.yml" \
  && report 0 'this repo still reports the review job under the same name' \
  || report 1 'this repo still reports the review job under the same name'

# Fail-open classify: a crashing classifier must not skip the chair.
cat > "$WORK/pr-delta.diff" <<'DIFF'
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
+docs
DIFF
CLASSIFY="$(node "$ROOT/scripts/trivial-chair.mjs" --classify "$WORK/pr-delta.diff")"
[ "$CLASSIFY" = true ] && report 0 'docs-only delta classifies as trivial' \
  || report 1 'docs-only delta classifies as trivial'
CLASSIFY="$(node "$ROOT/scripts/trivial-chair.mjs" --classify /no/such/file)"
[ "$CLASSIFY" = false ] && report 0 'a missing diff fails open to non-trivial' \
  || report 1 'a missing diff fails open to non-trivial'

cat > "$WORK/src.diff" <<'DIFF'
diff --git a/scripts/app.mjs b/scripts/app.mjs
--- a/scripts/app.mjs
+++ b/scripts/app.mjs
+export const x = 1;
DIFF
CLASSIFY="$(node "$ROOT/scripts/trivial-chair.mjs" --classify "$WORK/src.diff")"
[ "$CLASSIFY" = false ] && report 0 'a source delta stays on the chair path' \
  || report 1 'a source delta stays on the chair path'

[ "$fails" = 0 ] || { printf '\n%s failing\n' "$fails" >&2; exit 1; }
printf '\nall passing\n'
