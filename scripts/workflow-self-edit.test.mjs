#!/usr/bin/env node
// A chair that exits 0 without posting is the defect this guards.
//
// claude-code-action refuses to run when the pull request edits the workflow
// file that invoked it, and it signals that refusal by returning normally --
// so the step exits 0, the failover chain reads the outcome as a success, and
// the pull request gets a red check with no review behind it. alongside #300,
// #314, #333, #343 and #378 were every one of them merged over that check.
//
// The remedy is a token that needs no OIDC exchange, wired to every chair. The
// structural half of this file is the part that must not rot: a chair added
// later without that wiring can self-skip again, silently, and nothing else in
// the suite would notice.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { selfEditsWorkflow, workflowPathFromRef } from "./workflow-self-edit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const actionYml = readFileSync(`${here}/../action.yml`, "utf8");

const REF = "pooriaarab/alongside/.github/workflows/vibecodereview.yml@refs/pull/378/merge";
const diffFor = (...paths) =>
  paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`).join("");

// --- the decision ----------------------------------------------------------

assert.equal(workflowPathFromRef(REF), ".github/workflows/vibecodereview.yml");
assert.equal(workflowPathFromRef("o/r/.github/workflows/x.yml"), ".github/workflows/x.yml");

// An `@` on either side of the separator. A workflow file may be named
// `review@v2.yml` and a branch may be named `feature@2`, so neither the first
// `@` nor the last one is the separator. Getting this wrong returns a path that
// matches nothing, `self_edit` reads false, and the chair self-skips in silence
// — this bug re-created by its own fix, which is why both cases are pinned.
assert.equal(
  workflowPathFromRef("o/r/.github/workflows/review@v2.yml@refs/pull/7/merge"),
  ".github/workflows/review@v2.yml",
  "an `@` in the workflow filename must not truncate the path",
);
assert.equal(
  workflowPathFromRef("o/r/.github/workflows/review@v2.yml@refs/heads/feature@2"),
  ".github/workflows/review@v2.yml",
  "an `@` in the branch name must not eat the filename",
);
assert.equal(
  selfEditsWorkflow(diffFor(".github/workflows/review@v2.yml"),
    "o/r/.github/workflows/review@v2.yml@refs/heads/feature@2"),
  true,
);
// A malformed or absent ref must not be read as a self-edit: that would move
// every review in the fleet onto the caller's token and off claude[bot].
for (const bad of ["", null, undefined, "owner/repo", "@refs/heads/main"]) {
  assert.equal(workflowPathFromRef(bad), "", `expected no path from ${JSON.stringify(bad)}`);
  assert.equal(selfEditsWorkflow(diffFor(".github/workflows/vibecodereview.yml"), bad), false);
}

// The case that shipped: #378 changed two markdown files and the workflow.
assert.equal(
  selfEditsWorkflow(diffFor("POSITIONING.md", "README.md", ".github/workflows/vibecodereview.yml"), REF),
  true,
  "a pull request touching its own workflow must be detected",
);
// A different workflow in the same directory is not this one.
assert.equal(selfEditsWorkflow(diffFor(".github/workflows/lint.yml"), REF), false);
// A path that merely contains the workflow path is not the workflow path.
assert.equal(selfEditsWorkflow(diffFor("docs/.github/workflows/vibecodereview.yml"), REF), false);
assert.equal(selfEditsWorkflow("", REF), false);

// --- the wiring ------------------------------------------------------------

// Match the whole line. `indexOf("id: workflow_guard")` also matched
// `id: workflow_guard_disabled`, so renaming the step out of existence left
// this guard green while every chair's `github_token` expression silently
// resolved to the empty string -- the exact defect, passing its own test.
const detect = actionYml.indexOf("\n      id: workflow_guard\n");
assert.notEqual(detect, -1, "action.yml must detect a self-edited workflow before any chair runs");
assert.ok(
  actionYml.includes("scripts/workflow-self-edit.mjs"),
  "the detection step must call the script this file tests, not re-implement the rule",
);

// Every claude-code-action step is a chair, and every chair must be able to
// survive the self-skip. Counting them from the file means a sixth seat added
// later is covered with no edit here.
const steps = actionYml.split(/^    - name: /m).slice(1);
const chairs = steps.filter((s) => s.includes("uses: anthropics/claude-code-action@"));
assert.ok(chairs.length >= 5, `expected the chair failover chain, found ${chairs.length} chair step(s)`);
for (const chair of chairs) {
  const name = chair.split("\n")[0];
  assert.match(
    chair,
    /github_token: \$\{\{ steps\.workflow_guard\.outputs\.self_edit == 'true' && inputs\.github_token \|\| '' \}\}/,
    `chair step "${name}" can still reach the OIDC exchange, so it can exit 0 without posting`,
  );
}
// The detection has to precede the chairs it feeds, or its output is empty.
assert.ok(detect < actionYml.indexOf("uses: anthropics/claude-code-action@"),
  "the detection step must come before the first chair");

// The caller's GITHUB_TOKEN has no `workflows` scope, so a chair that tries to
// push a fix to .github/workflows/** dies before it posts -- reintroducing the
// no-review outcome by another route.
const cycle = steps.find((s) => s.includes("id: cycle"));
assert.ok(cycle, "fix-cycle guard step not found");
assert.ok(
  cycle.includes("VCR_SELF_EDIT: ${{ steps.workflow_guard.outputs.self_edit }}")
    && cycle.includes('[ "${VCR_SELF_EDIT:-}" = "true" ]'),
  "the fix-cycle guard must turn pushes off for a self-edited workflow",
);

// The gate's failure message now reads self_edit to say whether the remedy was
// even attempted. Unwire the env and it prints "unset" forever, which sends the
// next person debugging a silent chair to the wrong place -- the same cost the
// old message carried when it blamed a cause it could not check.
const gate = steps.find((s) => s.includes("name: Chair result gate") || s.startsWith("Chair result gate"));
assert.ok(gate, "chair result gate step not found");
assert.ok(
  gate.includes("SELF_EDIT: ${{ steps.workflow_guard.outputs.self_edit }}"),
  "the chair result gate must read self_edit, or its failure message cannot say whether the remedy ran",
);
assert.ok(
  gate.includes("${SELF_EDIT:-unset}"),
  "the gate must default SELF_EDIT, since `set -u` would otherwise kill the message it exists to print",
);

// The `@refs/` rule lives in one place. A second, looser copy in shell would
// print a path the script never decided, which is how a diagnostic starts
// lying about the thing it is there to report.
const guard = steps.find((s) => s.startsWith("Detect a self-edited workflow"));
assert.ok(guard, "detection step not found");
// Comment lines are stripped first. The first version of this assertion read
// the whole step and tripped on the comment that explains the rule, which
// would have taught the next person to delete the explanation to get green.
const guardCode = guard.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
assert.ok(
  !/\$\{GITHUB_WORKFLOW_REF[%#]/.test(guardCode),
  "the detection step must not re-parse GITHUB_WORKFLOW_REF in shell; the @refs/ rule has one home",
);

console.log("ok    workflow-self-edit");
