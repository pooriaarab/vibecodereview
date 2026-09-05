#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCouncilRecord,
  detectStrength,
} from "./vibetrace-records.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibetrace-emit.mjs");
let failed = 0;

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-records-"));

const trivialMd = "# Council\n\n_Council skipped: trivial delta with no behavioral surface — docs only._\n";
const trivialRec = buildCouncilRecord({
  mode: "delta",
  cacheHit: false,
  memberCount: 0,
  cancelled: false,
  attribution: {},
  findingsMarkdown: trivialMd,
  diffMarkdown: "",
});
if (trivialRec.record.strength !== "trivial") {
  console.error("FAIL strength trivial", trivialRec.record.strength);
  failed++;
} else {
  console.log("ok - strength=trivial for trivial skip");
}

const noKeysMd = "# Council\n\n_Council skipped: no provider keys set (OPENAI_API_KEY)._ \n";
const noKeysRec = buildCouncilRecord({
  mode: "full",
  cacheHit: false,
  memberCount: 0,
  cancelled: false,
  attribution: {},
  findingsMarkdown: noKeysMd,
  diffMarkdown: "",
});
if (noKeysRec.record.strength !== "no-keys") {
  console.error("FAIL strength no-keys", noKeysRec.record.strength);
  failed++;
} else {
  console.log("ok - strength=no-keys when keys missing");
}

const fullRec = buildCouncilRecord({
  mode: "full",
  cacheHit: false,
  memberCount: 3,
  cancelled: false,
  attribution: {},
  findingsMarkdown: "# Council\n\n## GPT — correctness lens\n\n- `src/x.ts:1` — defect here -> fix.\n",
  diffMarkdown: "@@\n+added line\n",
});
if (fullRec.record.strength !== "full" || fullRec.record.addedLines !== 1) {
  console.error("FAIL strength full / addedLines", fullRec.record);
  failed++;
} else if (!fullRec.record.findings?.[0]?.classKey) {
  console.error("FAIL findings payload missing classKey", fullRec.record.findings);
  failed++;
} else {
  console.log("ok - strength=full with findings and addedLines");
}

if (detectStrength("# x\n", "delta") !== "delta") {
  console.error("FAIL detectStrength delta");
  failed++;
}
fs.rmSync(tmp, { recursive: true, force: true });

// --- strength must never mistake a skipped review for a full one ----------
// Read every skip string the engine actually writes and check each one lands
// outside `full`/`delta`. This is the durable half: a sixth skip path added to
// council-review.mjs fails here instead of silently recording as "reviewed,
// found nothing", which is the one reading this field exists to prevent.
{
  const engine = fs.readFileSync(path.join(path.dirname(script), "council-review.mjs"), "utf8");
  const written = [...engine.matchAll(/_Council skipped: [^"`\\]+/g)].map((m) => m[0]);
  if (written.length < 5) {
    console.error("FAIL expected several engine skip strings, found", written.length);
    failed++;
  }
  for (const marker of written) {
    const strength = detectStrength(`# hdr\n\n${marker}._\n`, "full");
    if (strength === "full" || strength === "delta") {
      console.error(`FAIL skip string recorded as ${strength}:`, marker.slice(0, 70));
      failed++;
    }
  }
  if (detectStrength("_Council skipped: a gate added later._", "full") !== "skipped") {
    console.error("FAIL an unrecognised skip must degrade to `skipped`, never to `full`");
    failed++;
  } else {
    console.log(`ok - all ${written.length} engine skip paths record outside full/delta`);
  }
}
console.log("vibetrace-records tests passed");
if (failed) process.exit(1);
