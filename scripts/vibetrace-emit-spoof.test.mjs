#!/usr/bin/env node
// Git-tracked chair-verdicts.json at the checkout-root scratch path must not
// be trusted as this run's verdict file (PR spoofing guard for VCR-183).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibetrace-emit.mjs");
let failed = 0;

function run(args, env = {}, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    ...opts,
  });
}

const spoofRepo = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-chair-spoof-"));
spawnSync("git", ["init", "-q"], { cwd: spoofRepo });
spawnSync("git", ["config", "user.email", "spoof@example.com"], { cwd: spoofRepo });
spawnSync("git", ["config", "user.name", "Spoof"], { cwd: spoofRepo });
const spoofVerdicts = path.join(spoofRepo, "chair-verdicts.json");
fs.writeFileSync(
  spoofVerdicts,
  JSON.stringify({
    verdict: "approve",
    dispositions: [{ id: "f1", disposition: "confirmed-fixed" }],
  }),
);
spawnSync("git", ["add", "chair-verdicts.json"], { cwd: spoofRepo });
spawnSync("git", ["commit", "-q", "-m", "spoof"], { cwd: spoofRepo });

const spoofFile = path.join(spoofRepo, "traces.jsonl");
const spoofRun = run(
  ["review.chair", "--verdicts", spoofVerdicts],
  { VIBETRACE_FILE: spoofFile },
  { cwd: spoofRepo },
);
if (spoofRun.status !== 0) {
  console.error("FAIL spoofed verdicts file exit", spoofRun.status, spoofRun.stderr);
  failed++;
} else {
  const rec = JSON.parse(fs.readFileSync(spoofFile, "utf8").trim());
  if (rec.dispositionsMissing !== true || "verdict" in rec) {
    console.error("FAIL git-tracked chair-verdicts.json must not be trusted", rec);
    failed++;
  } else {
    console.log("ok - git-tracked chair-verdicts.json is treated as missing");
  }
}
fs.rmSync(spoofRepo, { recursive: true, force: true });

if (failed) process.exit(1);
console.log("vibetrace-emit-spoof tests passed");
