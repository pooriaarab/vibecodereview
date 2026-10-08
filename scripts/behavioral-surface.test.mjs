#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { behavioralSurface } from "./behavioral-surface.mjs";

function diffFor(file) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n+change\n`;
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

for (const file of ["VISION.md", "docs/decisions/x.md", "README.md", "guide.mdx", "guide.txt", "guide.rst"]) {
  test(`review_prose opts in ${file}`, () => {
    const diff = diffFor(file);
    assert.equal(behavioralSurface(diff).trivial, true);
    for (const review_prose of ["false", "TRUE", "1", "yes", "", true]) {
      assert.deepEqual(behavioralSurface(diff, { review_prose }), behavioralSurface(diff));
    }
    assert.equal(behavioralSurface(diff, { review_prose: "true" }).trivial, false);
  });
}
for (const file of ["bun.lock", "image.png", "font.woff2", "clip.mp4", "LICENSE", "LICENSE.md", "NOTICE", "NOTICE.txt", "CHANGELOG", "CHANGELOG.md", ".editorconfig"]) {
  test(`review_prose keeps ${file} inert`, () => {
    assert.deepEqual(behavioralSurface(diffFor(file), { review_prose: "true" }), behavioralSurface(diffFor(file)));
  });
}
test("review_prose keeps mixed diffs unchanged", () => {
  const diff = joinDiffs("README.md", "src/app.ts");
  for (const review_prose of ["true", "false", "TRUE", "1", "yes", ""]) {
    assert.equal(behavioralSurface(diff, { review_prose }).trivial, false);
  }
});

test("review_prose reaches every council lens for a prose-only delta", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-prose-"));
  try {
    const diff = path.join(work, "pr.diff");
    const report = path.join(work, "findings.md");
    fs.writeFileSync(diff, diffFor("VISION.md"));
    const engine = fileURLToPath(new URL("./council-review.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [engine, diff, report], {
      cwd: work, encoding: "utf8", env: { VCR_REVIEW_PROSE: "true" },
    });
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(report, "utf8");
    assert.match(text, /no provider keys set \(OPENAI_API_KEY, GEMINI_API_KEY, MOONSHOT_API_KEY, OPENROUTER_API_KEY, OPENROUTER_API_KEY\)/);
    assert.doesNotMatch(text, /trivial delta|Lenses not dispatched/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
