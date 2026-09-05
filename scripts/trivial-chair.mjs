#!/usr/bin/env node
// Deterministic chair for a trivial delta. Posts one review comment and a
// SUCCESS-path verdict with no model call. Skipping the Claude chair without
// posting leaves consumer repos with no review and no check conclusion.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { behavioralSurface } from "./behavioral-surface.mjs";

export function classifyDiff(raw) {
  try {
    return behavioralSurface(String(raw ?? "")).trivial === true;
  } catch {
    return false;
  }
}

export function classifyFile(file) {
  try {
    return classifyDiff(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export function reviewBody(surface, headSha) {
  const reason = surface?.reason
    || "every changed path is inert (docs, lockfiles, assets, or editor noise)";
  const paths = Array.isArray(surface?.paths) && surface.paths.length > 0
    ? surface.paths.map((p) => `\`${p}\``).join(", ")
    : "none listed";
  const head = headSha ? `\nReviewed head: \`${headSha}\`.\n` : "\n";
  return `Council: skipped.

This delta has no behavioral surface — ${reason}. Paths: ${paths}.
The council members and the chair did not run.${head}
<details><summary>🧑‍⚖️ Council</summary>

Council: skipped

</details>
`;
}

export function verdictsJson() {
  return `${JSON.stringify({ verdict: "comment", dispositions: [] })}\n`;
}

export function reviewArgs(pr, repo, bodyFile) {
  return ["pr", "review", String(pr), "--repo", String(repo), "--comment", "--body-file", bodyFile];
}

function surfaceFromWorkspace() {
  try {
    if (!fs.existsSync("pr-delta.diff")) return { paths: [] };
    return behavioralSurface(fs.readFileSync("pr-delta.diff", "utf8"));
  } catch {
    return { paths: [] };
  }
}

function postMain() {
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  if (!repo || !pr) throw new Error("GITHUB_REPOSITORY and PR_NUMBER are required");
  fs.writeFileSync("trivial-review.md", reviewBody(surfaceFromWorkspace(), process.env.VCR_REVIEW_HEAD_SHA));
  execFileSync("gh", reviewArgs(pr, repo, "trivial-review.md"), { stdio: "inherit" });
  const verdicts = process.env.VCR_CHAIR_VERDICTS;
  if (!verdicts) return;
  try {
    fs.writeFileSync(verdicts, verdictsJson());
  } catch {
    // Telemetry must never turn a posted review red.
  }
}

function main() {
  if (process.argv[2] === "--classify") {
    process.stdout.write(classifyFile(process.argv[3]) ? "true" : "false");
    return;
  }
  postMain();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error("trivial chair failed:", err?.message || err);
    process.exit(1);
  }
}
