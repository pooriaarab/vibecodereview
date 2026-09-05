#!/usr/bin/env node
// Guard against the class of defect where `npm test` hand-lists test files
// and silently stops running a newly added scripts/*.test.mjs.
// This file is itself a scripts/*.test.mjs, so the glob picks it up.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(scriptsDir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const testScript = pkg.scripts?.test ?? "";

// The test script must discover test files via a glob, not a hand-list.
assert.match(
  testScript,
  /\*\.test\.mjs/,
  "npm test must discover scripts/*.test.mjs via a glob, not a hand-maintained list",
);

// No individual test file may be hardcoded: a hardcoded name means a new
// file is invisible to CI until package.json is edited.
const onDisk = fs
  .readdirSync(scriptsDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();
assert.ok(onDisk.length > 0, "expected at least one scripts/*.test.mjs on disk");
for (const f of onDisk) {
  assert.ok(
    !testScript.includes(f),
    `npm test hand-lists ${f}; use the glob so new test files run with no package.json edit`,
  );
}

// `npm test` must still chain into the selfchecks.
assert.match(testScript, /selfcheck/, "npm test must still run the selfcheck step");

console.log(`ok - npm test discovers all ${onDisk.length} test files via glob`);
