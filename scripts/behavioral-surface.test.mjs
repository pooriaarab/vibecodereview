#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { behavioralSurface } from "./behavioral-surface.mjs";

function diffFor(path) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n+change\n`;
}

function joinDiffs(...paths) {
  return paths.map(diffFor).join("");
}

// Docs-only diff is trivial.
assert.equal(behavioralSurface(diffFor("README.md")).trivial, true);
// Lockfile-only diff is trivial.
assert.equal(behavioralSurface(diffFor("package-lock.json")).trivial, true);
// Source change is not trivial.
assert.equal(behavioralSurface(diffFor("src/app.ts")).trivial, false);
// Mixed docs + source is not trivial.
assert.equal(behavioralSurface(joinDiffs("docs/guide.md", "src/app.ts")).trivial, false);
// Workflow changes are behavioral.
assert.equal(behavioralSurface(diffFor(".github/workflows/ci.yml")).trivial, false);
// Agent-instruction markdown is behavioral.
assert.equal(behavioralSurface(diffFor("AGENTS.md")).trivial, false);
assert.equal(behavioralSurface(diffFor(".claude/rules/foo.md")).trivial, false);
assert.equal(behavioralSurface(diffFor("skills/x/SKILL.md")).trivial, false);
// Plain docs under docs/ stay inert.
assert.equal(behavioralSurface(diffFor("docs/guide.md")).trivial, true);
// Empty / unparseable diff fails open.
assert.equal(behavioralSurface("").trivial, false);
assert.equal(behavioralSurface("not a git diff").trivial, false);
// A real changelog is inert, but a source file that merely STARTS with the
// word is not. Getting this wrong skips review on code, which is the only
// direction this gate must never fail in.
assert.equal(behavioralSurface(diffFor("CHANGELOG")).trivial, true);
assert.equal(behavioralSurface(diffFor("CHANGELOG.md")).trivial, true);
assert.equal(behavioralSurface(diffFor("CHANGELOG_GENERATOR.py")).trivial, false);
assert.equal(behavioralSurface(diffFor("tools/CHANGELOGGER.ts")).trivial, false);
// Config is behavioral; named lockfiles are inert.
assert.equal(behavioralSurface(diffFor("config.json")).trivial, false);
assert.equal(behavioralSurface(diffFor("package-lock.json")).trivial, true);

// A trivial delta must hand the carry back untouched. The workflow reads
// VCR_CARRY_FILE with an `existsSync(...) ? ... : ""` fallback, so an early
// return that never writes it rewrites the review-state comment with an EMPTY
// carry -- one docs-only push after a review with unresolved findings would
// erase them permanently. Drive the real engine, not a stub: the bug lives in
// the order of the reads, which a stub would not reproduce.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-trivial-"));
  try {
    const prior = "## Old member — security lens\n\n- `src/auth.ts:42` — unresolved finding.\n";
    fs.writeFileSync(path.join(dir, "pr.diff"), diffFor("docs/x.md"));
    fs.writeFileSync(path.join(dir, "prior.md"), prior);
    const engine = path.join(import.meta.dirname, "council-review.mjs");
    const out = path.join(dir, "out.md");
    execFileSync(process.execPath, [engine, path.join(dir, "pr.diff"), out], {
      env: {
        ...process.env,
        VCR_PRIOR_FINDINGS_FILE: path.join(dir, "prior.md"),
        VCR_CARRY_FILE: path.join(dir, "carry.next.md"),
      },
      stdio: "ignore",
    });
    assert.equal(
      fs.existsSync(path.join(dir, "carry.next.md")),
      true,
      "trivial delta must write the carry file, or the state comment is rewritten empty",
    );
    assert.match(fs.readFileSync(path.join(dir, "carry.next.md"), "utf8"), /unresolved finding/);
    // The chair must still be told to re-check them.
    const report = fs.readFileSync(out, "utf8");
    assert.match(report, /Findings carried forward/);
    assert.match(report, /unresolved finding/);
    // ...and the skip itself stays disclosed.
    assert.match(report, /Council skipped: trivial delta/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("behavioral surface tests passed");
