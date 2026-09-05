#!/usr/bin/env node
// Issue #146: memberCount/cacheHit must describe the CURRENT run, not the
// report. Carried-forward findings reuse old `## Name — lens lens` headings
// (and any `(cached)` suffix), so deriving counts by parsing the markdown
// credits the run with members it never dispatched. The engine instead writes
// a VCR_STATS_FILE sidecar from its own results via councilRunStats; these
// checks drive the engine and assert the sidecar (and the record built from
// it) always reflects this run alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { councilRunStats } from "./review-delta.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(scriptsDir, "council-review.mjs");
const emit = path.join(scriptsDir, "vibetrace-emit.mjs");
const statsReader = path.join(scriptsDir, "read-council-stats.mjs");

// The exact read action.yml's emit step performs: run the extracted reader
// script against a stats sidecar and split its "<members> <cacheHit>" line.
// Driving this instead of hardcoding the expected numbers means a regression
// in read-council-stats.mjs itself -- the code action.yml actually runs --
// fails this test, not just a copy of its logic.
function readStatsViaAction(statsFile) {
  const out = spawnSync(process.execPath, [statsReader], {
    env: { VCR_STATS_FILE: statsFile },
    encoding: "utf8",
  });
  const [members, cacheHit] = out.stdout.trim().split(" ");
  return { members, cacheHit };
}

const CODE_DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n+const x = 1;\n";
// Three carried member headings, one of them `(cached)`: under the old
// grep-the-report derivation this counted as 3 members and a cache hit.
const CARRIED = [
  "## GPT-5.6 (Codex) — correctness lens (cached)",
  "",
  "- `src/app.ts:1` — stale defect -> fix it.",
  "",
  "## Gemini 3 Pro — performance lens",
  "",
  "- `src/app.ts:2` — stale defect -> fix it.",
  "",
  "## Kimi K3 — security lens",
  "",
  "- `src/app.ts:3` — stale defect -> fix it.",
].join("\n");

// Scrubbed environment (no provider keys) so no case can reach the network
// unless it sets its own endpoint explicitly.
function runEngine(diff, prior, extraEnv = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "council-stats-"));
  const diffFile = path.join(work, "pr.diff");
  const outFile = path.join(work, "council-findings.md");
  const priorFile = path.join(work, "council-carry.md");
  const carryFile = path.join(work, "council-carry.next.md");
  const statsFile = path.join(work, "council-stats.json");
  fs.writeFileSync(diffFile, diff);
  fs.writeFileSync(priorFile, prior);
  const result = spawnSync(process.execPath, [engine, diffFile, outFile], {
    env: {
      VCR_PRIOR_FINDINGS_FILE: priorFile,
      VCR_CARRY_FILE: carryFile,
      VCR_STATS_FILE: statsFile,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { result, work, diffFile, outFile, statsFile };
}

function readStats(statsFile) {
  return JSON.parse(fs.readFileSync(statsFile, "utf8"));
}

// Zero dispatched members plus carried headings (one cached): the sidecar
// must read 0/false, while the report still carries the text unchanged.
{
  const { result, outFile, statsFile } = runEngine(CODE_DIFF, CARRIED);
  assert.equal(result.status, 0, `engine exited ${result.status}: ${result.stderr}`);
  const stats = readStats(statsFile);
  assert.equal(stats.memberCount, 0, `carried headings counted as members: ${JSON.stringify(stats)}`);
  assert.equal(stats.cacheHit, false, `carried (cached) heading counted as a hit: ${JSON.stringify(stats)}`);
  const report = fs.readFileSync(outFile, "utf8");
  assert.ok(report.includes("Findings carried forward"), "carry must stay in the report");
  assert.ok(report.includes("(cached)"), "carried text must be untouched");
  console.log("ok    zero dispatched members + carried (cached) headings -> memberCount 0, cacheHit false");
}

// A normal run with two dispatched members still reports two, with no cache
// hit. The `custom` seats point at a refused port with a dummy key, so both
// members dispatch and fail fast offline; error results still count as
// dispatched, and none is cached.
{
  const run = runEngine(CODE_DIFF, "", {
    CUSTOM_BASE_URL: "http://127.0.0.1:1/chat/completions",
    CUSTOM_API_KEY: "dummy",
    COUNCIL_MODELS: "custom|m1|M1|correctness,custom|m2|M2|performance",
  });
  assert.equal(run.result.status, 0, `engine exited ${run.result.status}: ${run.result.stderr}`);
  const stats = readStats(run.statsFile);
  assert.equal(stats.memberCount, 2, `two dispatched members must report 2: ${JSON.stringify(stats)}`);
  assert.equal(stats.cacheHit, false, `no cached member must report false: ${JSON.stringify(stats)}`);
  const report = fs.readFileSync(run.outFile, "utf8");
  assert.ok(report.includes("M1 — correctness lens"), "dispatched headings must stay in the report");
  assert.ok(!report.includes("(cached)"), "uncached run must not mark headings cached");
  const { members, cacheHit } = readStatsViaAction(run.statsFile);
  assert.equal(members, "2", `reader script must derive 2 members: ${members}`);
  assert.equal(cacheHit, "0", `reader script must derive no cache hit: ${cacheHit}`);
  console.log("ok    two dispatched members -> memberCount 2, cacheHit false");
}

// councilRunStats is the exact derivation the engine passes to the sidecar:
// cached members (and only those) flip the hit, and the count is the run's
// own result list, whatever the report body contains.
{
  const none = councilRunStats([]);
  assert.deepEqual(none, { memberCount: 0, cacheHit: false });
  const live = councilRunStats([
    { model: { name: "M1" }, text: "ok" },
    { model: { name: "M2" }, error: "boom" },
  ]);
  assert.deepEqual(live, { memberCount: 2, cacheHit: false });
  const mixed = councilRunStats([
    { model: { name: "M1" }, text: "ok" },
    { model: { name: "M2" }, text: "ok", cached: true },
  ]);
  assert.deepEqual(mixed, { memberCount: 2, cacheHit: true });
  console.log("ok    councilRunStats counts results and hits cache only on cached results");
}

// The record built from the zero-member sidecar (the values action.yml's
// reader script derives, then passes as --members/--cache-hit) carries
// 0/false even though the findings file is full of carried member headings.
{
  const { result, work, diffFile, outFile, statsFile } = runEngine(CODE_DIFF, CARRIED);
  assert.equal(result.status, 0, `engine exited ${result.status}: ${result.stderr}`);
  const { members, cacheHit } = readStatsViaAction(statsFile);
  assert.equal(members, "0", `reader script must derive 0 members: ${members}`);
  assert.equal(cacheHit, "0", `reader script must derive no cache hit: ${cacheHit}`);
  const traces = path.join(work, "traces.jsonl");
  const emitted = spawnSync(
    process.execPath,
    [emit, "review.council", "--mode", "full", "--cache-hit", cacheHit, "--members", members,
      "--cancelled", "0", "--findings", outFile, "--diff", diffFile],
    { env: { ...process.env, VIBETRACE_FILE: traces, VIBETRACE_INGEST_URL: "" }, encoding: "utf8" },
  );
  assert.equal(emitted.status, 0, `emit exited ${emitted.status}: ${emitted.stderr}`);
  const rec = JSON.parse(fs.readFileSync(traces, "utf8").trim());
  assert.equal(rec.memberCount, 0);
  assert.equal(rec.cacheHit, false);
  console.log("ok    record from zero-member stats + carried report -> memberCount 0, cacheHit false");
}

console.log("\ncouncil-stats tests passed");
