#!/usr/bin/env node
// VCR-163, second half: `spawn claude ENOENT` must read as an infrastructure
// failure, never as "this member reviewed and found nothing". A council
// member's error and a member that found zero issues render identically
// today (both are an italic line in council-findings.md, both log as
// SKIP/ERR) -- exactly how the shipped bug went unnoticed: the check still
// passed. This mirrors the shape callModelWithFallback already uses to keep
// an absent key distinct from a rejected one (council-members.mjs), applied
// to the one failure mode neither of those cases covers: the binary itself
// is missing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callClaudeCli } from "./claude-cli-seat.mjs";
import { buildFindingsMarkdown } from "./review-delta.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(scriptsDir, "council-review.mjs");

function check(name, fn) {
  fn();
  console.log(`ok    ${name}`);
}

async function checkAsync(name, fn) {
  await fn();
  console.log(`ok    ${name}`);
}

await checkAsync("a missing claude binary tags the result infra, not a bare error", async () => {
  const savedPath = process.env.PATH;
  // An empty PATH guarantees no `claude` on it, wherever the CLI may
  // otherwise be installed on the machine running this test.
  process.env.PATH = "";
  try {
    const r = await callClaudeCli(
      { model: "claude-sonnet-5" },
      "d",
      { oauthToken: "fake-token" },
      { instructions: "review", timeoutMs: 20_000 },
    );
    assert.equal(r.infra, true, "ENOENT must set infra: true");
    assert.match(r.error, /ENOENT/);
    assert.match(r.error, /install step/);
  } finally {
    process.env.PATH = savedPath;
  }
});

check("buildFindingsMarkdown renders an infra failure as a warning, not the plain skip shape", () => {
  const infra = buildFindingsMarkdown([
    { model: { name: "Opus 5", lens: "correctness" }, error: "infra: claude CLI binary not found (spawn ENOENT)", infra: true },
  ]);
  assert.match(infra, /⚠️ \*\*Infrastructure failure, not a review:\*\*/);
  assert.doesNotMatch(infra, /^_infra: /m, "an infra failure must not render as the plain italic skip line");

  const ordinarySkip = buildFindingsMarkdown([
    { model: { name: "Kimi K3", lens: "security" }, error: "skipped: MOONSHOT_API_KEY not set" },
  ]);
  assert.match(ordinarySkip, /_skipped: MOONSHOT_API_KEY not set_/, "an ordinary skip keeps its existing shape");
  assert.doesNotMatch(ordinarySkip, /Infrastructure failure/);
});

// End-to-end: drive the real engine with a claude seat and no `claude` on
// PATH, the exact shape of pooriaarab/alongside#348. Assert the per-member
// log line and the findings file both mark it as infra, not as a clean skip.
check("the engine marks a CLI seat's ENOENT as an infra failure end to end", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-infra-"));
  const diffFile = path.join(dir, "pr.diff");
  const outFile = path.join(dir, "council-findings.md");
  fs.writeFileSync(diffFile, "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n+const x = 1;\n");
  const result = spawnSync(process.execPath, [engine, diffFile, outFile], {
    env: {
      COUNCIL_MODELS: "claude|claude-opus-5|Opus 5 (correctness)|correctness",
      CLAUDE_CODE_OAUTH_TOKEN: "fake-token",
      // PATH set to empty, not merely omitted: an unset PATH falls back to
      // an OS-default search on some platforms, which could still find a
      // real `claude` on the machine running this test. Empty restricts the
      // lookup to cwd (os.tmpdir(), per claude-cli-seat.mjs), which never
      // has one -- a deterministic ENOENT, reproducing the bug report.
      PATH: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `engine exited ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /INFRA-ERR/, "the per-member log line must tag the ENOENT as infra, not SKIP/ERR");
  assert.doesNotMatch(result.stdout, /- Opus 5 \(correctness\)[^\n]*: SKIP\/ERR/);
  const report = fs.readFileSync(outFile, "utf8");
  assert.match(report, /Infrastructure failure, not a review/);
});

console.log("\ncouncil-infra-failure tests passed");
