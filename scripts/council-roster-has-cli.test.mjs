#!/usr/bin/env node
// council-roster-has-cli.mjs decides whether action.yml's early install step
// (VCR-163) actually pays the install cost, so it must say yes for any roster
// touching a claude*-provider seat and no for an all-HTTP roster -- a false
// "no" reintroduces `spawn claude ENOENT`, and a false "yes" reintroduces the
// cost the fan-out is supposed to hide.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "council-roster-has-cli.mjs");

function run(councilModels) {
  const env = councilModels === undefined ? {} : { COUNCIL_MODELS: councilModels };
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

function check(name, fn) {
  fn();
  console.log(`ok    ${name}`);
}

check("the default roster (five HTTP providers) has no CLI seat", () => {
  assert.equal(run(undefined), "false");
});

check("an all-HTTP custom roster has no CLI seat", () => {
  assert.equal(run("openai|gpt|GPT|correctness,gemini|g|G|security"), "false");
});

check("a roster with one claude seat has a CLI seat", () => {
  assert.equal(run("claude|claude-opus-5|Opus|correctness"), "true");
});

check("a claude seat mixed into an otherwise-HTTP roster still has a CLI seat", () => {
  assert.equal(run("openai|gpt|GPT|correctness,claude4|claude-sonnet-5|Sonnet|maintainability"), "true");
});

check("an invalid roster (no valid members) has no CLI seat", () => {
  assert.equal(run("not-a-real-row"), "false");
});

console.log("\ncouncil-roster-has-cli tests passed");
