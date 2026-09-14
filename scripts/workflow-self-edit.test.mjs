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

console.log("ok    workflow-self-edit");
