#!/usr/bin/env node
// Every early return from scripts/council-review.mjs must preserve the carry:
// drive the engine with VCR_PRIOR_FINDINGS_FILE set and a diff that triggers
// each return, then assert VCR_CARRY_FILE exists and still holds the prior
// text. A return that forgets the carry write fails its case here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engine = path.join(path.dirname(fileURLToPath(import.meta.url)), "council-review.mjs");

const PRIOR = "## unresolved\n\nKeep this finding.";
const CODE_DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n+const x = 1;\n";
const DOCS_DIFF = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n+details\n";

// Drive the engine the way the workflow does: VCR_PRIOR_FINDINGS_FILE in,
// VCR_CARRY_FILE out. The child gets a scrubbed environment — no provider
// keys — so no case can reach the network and the no-keys return is honest.
function runEngine(diff, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-carry-"));
  const diffFile = path.join(dir, "pr.diff");
  const outFile = path.join(dir, "council-findings.md");
  const priorFile = path.join(dir, "council-carry.md");
  const carryFile = path.join(dir, "council-carry.next.md");
  fs.writeFileSync(diffFile, diff);
  fs.writeFileSync(priorFile, PRIOR);
  const result = spawnSync(process.execPath, [engine, diffFile, outFile], {
    env: {
      VCR_PRIOR_FINDINGS_FILE: priorFile,
      VCR_CARRY_FILE: carryFile,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { result, carryFile };
}

function checkCarry(name, diff, extraEnv = {}) {
  const { result, carryFile } = runEngine(diff, extraEnv);
  assert.equal(result.status, 0, `${name}: engine exited ${result.status}: ${result.stderr}`);
  assert.equal(fs.existsSync(carryFile), true, `${name}: VCR_CARRY_FILE was not written`);
  const carry = fs.readFileSync(carryFile, "utf8");
  assert.ok(carry.includes("Keep this finding"), `${name}: prior text lost from carry: ${JSON.stringify(carry)}`);
  console.log(`ok    ${name}`);
}

// COUNCIL_MODELS parses to no valid members.
checkCarry("no valid members preserves the carry", CODE_DIFF, { COUNCIL_MODELS: "bogus" });

// Empty diff.
checkCarry("empty diff preserves the carry", "");

// Trivial delta with no behavioral surface.
checkCarry("trivial delta preserves the carry", DOCS_DIFF);

// Roster survives parsing, but the path filter leaves no applicable lens.
checkCarry("no applicable lens preserves the carry", CODE_DIFF, {
  COUNCIL_MODELS: "openai|gpt-x|G|correctness",
  LENS_PATH_FILTER: JSON.stringify({ correctness: "." }),
});

// Applicable lenses exist, but no provider key (and no cache) can serve them.
checkCarry("no provider keys preserves the carry", CODE_DIFF);

console.log("\nall passing");
