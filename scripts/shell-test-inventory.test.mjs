#!/usr/bin/env node
// The shell-tests workflow names each scripts/*.test.sh as its own step, which
// is the same hand-maintained inventory VCR-138 removed from `npm test`. Add a
// fifth suite and it is invisible to CI until somebody edits the workflow, and
// nothing goes red while it is missing — the run just gets quieter.
//
// This guard is a .mjs file on purpose. The npm-test glob picks it up with no
// wiring, so it cannot itself become the thing that was forgotten. A .sh guard
// would have to be listed in the very workflow it is checking.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workflow = path.join(scriptsDir, "..", ".github", "workflows", "shell-tests.yml");

const yaml = fs.readFileSync(workflow, "utf8");
const onDisk = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".test.sh")).sort();

assert.ok(onDisk.length > 0, "expected at least one scripts/*.test.sh on disk");

const missing = onDisk.filter((f) => !yaml.includes(`scripts/${f}`));
assert.deepEqual(
  missing,
  [],
  `shell-tests.yml does not run: ${missing.join(", ")}. Every scripts/*.test.sh must have a ` +
    `step, or it is invisible to CI while the run stays green.`,
);

// Each suite after the first must keep going when an earlier one fails, so one
// run names every failure instead of only the first.
const steps = yaml.split(/^\s*- name:/m).slice(1);
const guarded = steps.filter((s) => s.includes("cancelled()")).length;
assert.equal(
  guarded,
  steps.length - 1,
  `every step after the first needs 'if: \${{ !cancelled() }}' or a failing suite skips the rest; ` +
    `${guarded} of ${steps.length - 1} have it`,
);

console.log(`ok - shell-tests.yml runs all ${onDisk.length} scripts/*.test.sh, keep-going intact`);
