#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibetrace-emit.mjs");
let failed = 0;

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return r;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-emit-"));
const file = path.join(tmp, "traces.jsonl");

const ok = run(
  ["review.council", "--mode", "delta", "--cache-hit", "1", "--members", "4", "--cancelled", "0"],
  {
    VIBETRACE_FILE: file,
    GITHUB_REPOSITORY: "pooriaarab/vibecodereview",
    VCR_PR: "107",
    GITHUB_HEAD_REF: "vcr-107-emit-council",
  },
);
if (ok.status !== 0) {
  console.error("FAIL exit", ok.status, ok.stderr);
  failed++;
} else {
  const line = fs.readFileSync(file, "utf8").trim();
  const rec = JSON.parse(line);
  if (rec.type !== "review.council" || rec.mode !== "delta" || rec.cacheHit !== true) {
    console.error("FAIL record shape", rec);
    failed++;
  } else if (rec.attribution?.issue !== 107 || rec.attribution?.pr !== 107) {
    console.error("FAIL attribution", rec.attribution);
    failed++;
  } else {
    console.log("ok - writes review.council with attribution");
  }
}

const bad = run(["review.council", "--mode", "nope", "--members", "1"], { VIBETRACE_FILE: file });
if (bad.status !== 0) {
  console.error("FAIL bad mode should exit 0", bad.status);
  failed++;
} else if (!/mode must be/.test(bad.stderr + bad.stdout)) {
  console.error("FAIL bad mode message", bad.stderr, bad.stdout);
  failed++;
} else {
  console.log("ok - invalid mode silent-fails with message");
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("vibetrace-emit tests passed");
