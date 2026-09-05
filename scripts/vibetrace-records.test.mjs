#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFindingsMeta, parseFindingsMeta } from "./file-findings.mjs";
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

// A run that threw (council-review.mjs's top-level catch) is not a quiet
// full/delta success and must not be recorded as one.
const erroredMd = "# 🧑‍⚖️ LLM Council findings\n\n_Council errored: boom_\n";
if (detectStrength(erroredMd, "full") !== "errored" || detectStrength(erroredMd, "delta") !== "errored") {
  console.error("FAIL detectStrength must classify an errored run as `errored`, not full/delta");
  failed++;
} else {
  console.log("ok - strength=errored for a run that threw");
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
// A finding that QUOTES a skip marker is reviewer content, not a skip. This
// repo's council reviews the code these strings live in, so an unanchored
// match turned a real full review with a genuine finding into `trivial`.
{
  const quoted = [
    "# 🧑‍⚖️ LLM Council findings", "",
    "## GPT-5.6 (Codex) — correctness lens", "",
    "- `scripts/vibetrace-records.mjs:20` — the `_Council skipped: trivial delta` marker is matched anywhere in the body -> anchor it to line start.",
    "",
  ].join("\n");
  if (detectStrength(quoted, "full") !== "full") {
    console.error("FAIL a finding quoting a skip marker must stay `full`, got", detectStrength(quoted, "full"));
    failed++;
  } else if (detectStrength("# h\n\n  _Council skipped: empty diff._\n", "full") !== "no-diff") {
    console.error("FAIL an indented real skip line must still be detected");
    failed++;
  } else {
    console.log("ok - a quoted skip marker is content, an anchored one is a skip");
  }
}

// --- review.chair: missing verdicts must not look like zero findings ----------
{
  const missing = buildChairRecord({ attribution: {}, verdictsMissing: true });
  if (!missing.ok || missing.record.dispositionsMissing !== true) {
    console.error("FAIL missing verdicts must set dispositionsMissing", missing.record);
    failed++;
  } else if ("dispositions" in missing.record || "verdict" in missing.record) {
    console.error("FAIL missing verdicts must not include dispositions or verdict", missing.record);
    failed++;
  } else {
    console.log("ok - missing chair-verdicts.json sets dispositionsMissing without zero findings");
  }

  const validJson = JSON.stringify({
    verdict: "comment",
    dispositions: [
      { id: "abc123", disposition: "confirmed-fixed" },
      { id: "def456", disposition: "rejected" },
    ],
  });
  const present = buildChairRecord({ attribution: {}, verdictsJson: validJson });
  if (!present.ok || present.record.dispositionsMissing !== false) {
    console.error("FAIL valid verdicts must clear dispositionsMissing", present.record);
    failed++;
  } else if (present.record.verdict !== "comment" || present.record.dispositions?.length !== 2) {
    console.error("FAIL valid verdicts shape", present.record);
    failed++;
  } else {
    console.log("ok - valid chair-verdicts.json parses into dispositions");
  }

  const malformed = buildChairRecord({ attribution: {}, verdictsJson: "{ not json" });
  if (!malformed.ok || malformed.record.dispositionsMissing !== true) {
    console.error("FAIL malformed verdicts must set dispositionsMissing", malformed.record);
    failed++;
  } else if ("dispositions" in malformed.record) {
    console.error("FAIL malformed verdicts must not include dispositions array", malformed.record);
    failed++;
  } else {
    console.log("ok - malformed chair-verdicts.json fails open with dispositionsMissing");
  }
}

// A well-formed verdict file is not a complete one. A set that omits,
// duplicates or invents a finding id is not a verdict on this run, and
// recording it with dispositionsMissing:false hands the promotion counter a
// claim no chair made.
{
  const report = appendFindingsMeta(
    "## GPT — security lens\n\n- `a.ts:1` — bad -> fix.\n- `b.ts:2` — worse -> fix.\n",
  );
  const ids = parseFindingsMeta(report);
  const body = (ds) => JSON.stringify({ verdict: "comment", dispositions: ds });
  const rec = (ds, md = report) =>
    buildChairRecord({ verdictsJson: body(ds), findingsMarkdown: md, attribution: {} }).record;
  const all = ids.map((id) => ({ id, disposition: "confirmed-open" }));

  const complete = rec(all);
  if (complete.dispositionsMissing !== false || complete.coverageUnverified !== false) {
    console.error("FAIL a complete disposition set must be trusted", complete);
    failed++;
  }
  for (const [label, ds] of [
    ["omits a finding", [all[0]]],
    ["duplicates a finding", [all[0], { id: ids[0], disposition: "rejected" }, all[1]]],
    ["invents a finding", [...all, { id: "forged", disposition: "confirmed-fixed" }]],
  ]) {
    const r = rec(ds);
    if (r.dispositionsMissing !== true || !r.dispositionsRejected) {
      console.error(`FAIL a set that ${label} must not be recorded as a complete verdict`, r);
      failed++;
    }
  }
  // No meta block means nothing to check against, not a failure — but the
  // reader must be able to tell that apart from a verified set.
  const unchecked = rec([{ id: "x", disposition: "confirmed-open" }], "## x\n");
  if (unchecked.dispositionsMissing !== false || unchecked.coverageUnverified !== true) {
    console.error("FAIL an unverifiable set must be flagged, not failed", unchecked);
    failed++;
  } else {
    console.log("ok - disposition coverage is checked against the recorded findings");
  }
}

console.log("vibetrace-records tests passed");
if (failed) process.exit(1);
