#!/usr/bin/env node
import assert from "node:assert/strict";
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

console.log("behavioral surface tests passed");
