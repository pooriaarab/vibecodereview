#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflows = path.join(root, ".github", "workflows");
const lint = fs.readFileSync(path.join(workflows, "lint.yml"), "utf8");

function check(name, fn) {
  fn();
  console.log(`ok    ${name}`);
}

function topBlock(src, header) {
  const lines = src.split("\n");
  const start = lines.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== "" && !line.startsWith(" ") && !line.startsWith("#")) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function namedSteps(src) {
  const steps = [];
  let current = null;
  for (const line of src.split("\n")) {
    const name = /^\s+- name: (.+)$/.exec(line);
    if (name) {
      if (current) steps.push(current);
      current = { name: name[1], ifCancelledGuard: false };
      continue;
    }
    if (current && line.includes("if:") && line.includes("!cancelled()")) {
      current.ifCancelledGuard = true;
    }
  }
  if (current) steps.push(current);
  return steps;
}

// GitHub skips a later step after a failure unless that step has its own `if`.
// `if: ${{ !cancelled() }}` still runs on failure and still fails the job.
function runJob(steps, exits) {
  let failed = false;
  const ran = [];
  for (const step of steps) {
    if (failed && !step.ifCancelledGuard) continue;
    ran.push(step.name);
    if ((exits[step.name] ?? 0) !== 0) failed = true;
  }
  return { ran, failed };
}

check("one workflow file holds both checks", () => {
  const names = namedSteps(lint).map((s) => s.name);
  assert.equal(names.filter((n) => n.startsWith("oxlint")).length, 1);
  assert.equal(names.filter((n) => n === "jscpd").length, 1);
  const jobsBlock = lint.slice(lint.indexOf("\njobs:\n"));
  assert.equal([...jobsBlock.matchAll(/^  [A-Za-z0-9_-]+:$/gm)].length, 1);
  assert.equal([...lint.matchAll(/^    runs-on:/gm)].length, 1);
});

check("triggers are pull_request plus push to main, nothing else", () => {
  assert.equal(topBlock(lint, "on:"), "pull_request:\n  push:\n    branches: [main]");
  assert.doesNotMatch(lint, /\bedited\b/);
  assert.doesNotMatch(lint, /\blabeled\b/);
  assert.doesNotMatch(lint, /\bunlabeled\b/);
});

// Disabling the old files rather than deleting them would leave two dead paths
// a later agent can copy from, and a `workflow_dispatch` stub still shows up in
// the Actions UI as if it were a real check.
check("the old workflow files are gone, not disabled", () => {
  for (const file of ["oxlint.yml", "jscpd.yml"]) {
    assert.equal(fs.existsSync(path.join(workflows, file)), false, `${file} still exists`);
  }
});

check("pr-standards keeps its own workflow and trigger set", () => {
  const prs = fs.readFileSync(path.join(workflows, "pr-standards.yml"), "utf8");
  assert.match(prs, /^name: pr-standards$/m);
  assert.match(prs, /types: \[opened, edited, synchronize, reopened, labeled, unlabeled\]/);
  assert.doesNotMatch(prs, /^  push:/m);
});

check("neither lint step uses continue-on-error", () => {
  assert.doesNotMatch(lint, /continue-on-error/);
  assert.match(lint, /bunx oxlint@\^1 --config \.oxlintrc\.json/);
  assert.match(lint, /bunx jscpd@5\.1\.1 --no-tips \./);
});

check("a failing oxlint step still runs jscpd and still fails the job", () => {
  const steps = namedSteps(lint);
  const jscpd = steps.find((s) => s.name === "jscpd");
  assert.equal(jscpd.ifCancelledGuard, true);
  const oxlintFail = runJob(steps, { [steps[0].name]: 1, jscpd: 0, test: 0 });
  assert.deepEqual(oxlintFail.ran, steps.map((s) => s.name));
  assert.equal(oxlintFail.failed, true);
  const jscpdFail = runJob(steps, { [steps[0].name]: 0, jscpd: 1, test: 0 });
  assert.ok(jscpdFail.ran.includes("jscpd"));
  assert.ok(jscpdFail.ran.includes("test"));
  assert.equal(jscpdFail.failed, true);
  const unguarded = steps.map((s) => ({ ...s, ifCancelledGuard: false }));
  const hidden = runJob(unguarded, { [steps[0].name]: 1, jscpd: 1, test: 1 });
  assert.deepEqual(hidden.ran, [steps[0].name]);
});

console.log("\nall passing");
