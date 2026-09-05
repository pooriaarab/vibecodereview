#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChairRecord,
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

const chairMissing = buildChairRecord({ verdictsPath: path.join(tmp, "missing-chair.json"), attribution: {} });
if (!chairMissing.record.dispositionsMissing || chairMissing.record.dispositions) {
  console.error("FAIL missing chair-verdicts should set dispositionsMissing", chairMissing.record);
  failed++;
} else {
  console.log("ok - missing chair-verdicts.json sets dispositionsMissing");
}

const verdictsPath = path.join(tmp, "chair-verdicts.json");
fs.writeFileSync(verdictsPath, JSON.stringify({
  verdict: "comment",
  dispositions: [{ id: "abc", classKey: "def", disposition: "confirmed-open" }],
}));
const chairPresent = buildChairRecord({ verdictsPath, attribution: {} });
if (chairPresent.record.dispositionsMissing || chairPresent.record.verdict !== "comment") {
  console.error("FAIL present chair-verdicts", chairPresent.record);
  failed++;
} else {
  console.log("ok - chair-verdicts.json parsed into review.chair");
}

const chairEmitFile = path.join(tmp, "chair-emit.jsonl");
const chairEmit = run(["review.chair", "--verdicts", verdictsPath], { VIBETRACE_FILE: chairEmitFile });
if (chairEmit.status !== 0) {
  console.error("FAIL review.chair emit exit", chairEmit.status, chairEmit.stderr);
  failed++;
} else {
  const chairLine = JSON.parse(fs.readFileSync(chairEmitFile, "utf8").trim());
  if (chairLine.type !== "review.chair" || chairLine.dispositionsMissing) {
    console.error("FAIL review.chair record", chairLine);
    failed++;
  } else {
    console.log("ok - CLI emits review.chair");
  }
}

const chairMissingEmit = run(["review.chair", "--verdicts", path.join(tmp, "nope.json")], {
  VIBETRACE_FILE: path.join(tmp, "chair-missing.jsonl"),
});
if (chairMissingEmit.status !== 0) {
  console.error("FAIL missing chair emit exit", chairMissingEmit.status);
  failed++;
} else {
  const missingLine = JSON.parse(fs.readFileSync(path.join(tmp, "chair-missing.jsonl"), "utf8").trim());
  if (!missingLine.dispositionsMissing || missingLine.findings) {
    console.error("FAIL missing chair must not look like zero findings", missingLine);
    failed++;
  } else if (missingLine.dispositions) {
    console.error("FAIL missing chair should not include dispositions array", missingLine);
    failed++;
  } else {
    console.log("ok - missing chair file fails open with dispositionsMissing");
  }
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
