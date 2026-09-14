#!/usr/bin/env node
// VCR-163: a claude*-provider council seat shells the Claude Code CLI the
// moment the fan-out spawns it (scripts/claude-cli-seat.mjs), so the CLI
// install step must run before "Council fan-out (start)", not after it. The
// only install step used to sit below the fan-out, so every claude* seat
// spawned before the binary existed and died in 0.0s with `spawn claude
// ENOENT` -- observed live on pooriaarab/alongside#348, whose council is all
// Claude seats because its source may not go to a third-party relay.
//
// Extracted straight from action.yml's step list, the same way
// scripts/chair-gate.test.sh extracts a step's `run:` body: this test reads
// the real file, so reordering it (the exact regression this guards against)
// fails here instead of only in a live run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = fs.readFileSync(path.join(root, "action.yml"), "utf8");

function check(name, fn) {
  fn();
  console.log(`ok    ${name}`);
}

function namedSteps(src) {
  return [...src.matchAll(/^\s+- name: (.+)$/gm)].map((m) => ({ name: m[1], index: m.index }));
}

const steps = namedSteps(action);
function indexOf(name) {
  const step = steps.find((s) => s.name === name);
  assert.ok(step, `action.yml has no step named "${name}"`);
  return step.index;
}

check("the CLI-roster install step exists and sits above the fan-out", () => {
  const preInstall = indexOf("Install Claude Code CLI (CLI council seats)");
  const fanOut = indexOf("Council fan-out (start)");
  assert.ok(
    preInstall < fanOut,
    "'Install Claude Code CLI (CLI council seats)' must sit above 'Council fan-out (start)', " +
      "or a claude*-provider seat spawns before the binary exists and dies with `spawn claude ENOENT`",
  );
});

check("the CLI-roster install step resolves the roster and defers to the shared installer", () => {
  const start = indexOf("Install Claude Code CLI (CLI council seats)");
  const body = action.slice(start, indexOf("Council fan-out (start)"));
  assert.match(body, /council-roster-has-cli\.mjs/, "must resolve the roster via the shared script, not a re-parse");
  assert.match(body, /install-claude-cli\.sh/, "must call the shared installer, not a copy of its body");
});

check("the chair's own install step still sits below the fan-out (all-HTTP rosters pay nothing extra)", () => {
  const fanOut = indexOf("Council fan-out (start)");
  const lateInstall = indexOf("Install Claude Code CLI");
  assert.ok(
    fanOut < lateInstall,
    "the chair's install step moving above the fan-out would cost every run (including an all-HTTP " +
      "roster, which never needed an early install) the download time the fan-out currently hides",
  );
});

console.log("\ncouncil-order tests passed");
