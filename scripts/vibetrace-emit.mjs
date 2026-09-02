#!/usr/bin/env node
// Silent-fail vibetrace emitter for council runs. Matches @vibetrace/schema
// review.council shape. Never throws; never blocks the review check.
//
// Usage:
//   node vibetrace-emit.mjs review.council \
//     --mode delta|full --cache-hit 0|1 --members N --cancelled 0|1
//
// Env (all optional): VIBETRACE_INGEST_URL, VIBETRACE_INGEST_TOKEN, VIBETRACE_FILE,
// GITHUB_REPOSITORY, VCR_PR / GITHUB_PR_NUMBER, GITHUB_HEAD_REF,
// VCR_ISSUE / OFFROUTER_ISSUE, VCR_PR_BODY

import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = "0.1.0";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function parseIssueFromBranch(branch) {
  if (!branch) return undefined;
  const m = branch.toLowerCase().match(/^[a-z][a-z0-9]{1,3}-(\d+)-/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Matches GitHub's own closing-keyword syntax, e.g. "Closes #107".
function parseIssueFromBody(body) {
  if (!body) return undefined;
  const m = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function attribution() {
  const repo = process.env.GITHUB_REPOSITORY?.trim() || undefined;
  const branch =
    process.env.GITHUB_HEAD_REF?.trim() ||
    process.env.GITHUB_REF_NAME?.trim() ||
    undefined;
  const explicit = Number(process.env.VCR_ISSUE || process.env.OFFROUTER_ISSUE || "");
  const issue =
    (Number.isInteger(explicit) && explicit > 0 ? explicit : undefined) ??
    parseIssueFromBranch(branch) ??
    parseIssueFromBody(process.env.VCR_PR_BODY);
  const pr = Number(process.env.VCR_PR || process.env.GITHUB_PR_NUMBER || "");
  const out = {};
  if (repo) out.repo = repo;
  if (issue) out.issue = issue;
  if (Number.isInteger(pr) && pr > 0) out.pr = pr;
  if (branch) out.branch = branch;
  out.agent = "vibecodereview";
  out.harness = "github-actions";
  return out;
}

function buildCouncilRecord() {
  const mode = arg("--mode", "full");
  if (mode !== "full" && mode !== "delta") {
    return { ok: false, reason: "mode must be full or delta" };
  }
  const cacheHit = arg("--cache-hit", "0") === "1";
  const cancelled = arg("--cancelled", "0") === "1";
  const memberCount = Number(arg("--members", "0"));
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    return { ok: false, reason: "members must be a non-negative integer" };
  }
  return {
    ok: true,
    record: {
      schemaVersion: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      type: "review.council",
      mode,
      cacheHit,
      memberCount,
      cancelled,
      attribution: attribution(),
    },
  };
}

async function emit(record) {
  const ingest = process.env.VIBETRACE_INGEST_URL?.trim();
  const token = process.env.VIBETRACE_INGEST_TOKEN?.trim();
  const body = JSON.stringify(record);
  if (ingest) {
    // Bounded so a dead/hanging endpoint can never hold the job open despite
    // the "never blocks the review" contract this script promises.
    const headers = { "content-type": "application/json" };
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(ingest, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
    return "ingest";
  }
  const file =
    process.env.VIBETRACE_FILE?.trim() ||
    path.join(process.env.RUNNER_TEMP || "/tmp", "vibetrace-traces.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${body}\n`, "utf8");
  return file;
}

async function main() {
  try {
    const kind = process.argv[2];
    if (kind !== "review.council") {
      console.error("vibetrace-emit: unsupported type; only review.council");
      process.exit(0);
    }
    const built = buildCouncilRecord();
    if (!built.ok) {
      console.error(`vibetrace-emit: ${built.reason}`);
      process.exit(0);
    }
    const where = await emit(built.record);
    console.log(`vibetrace-emit: wrote review.council -> ${where}`);
  } catch (err) {
    console.error(
      `vibetrace-emit: silent-fail: ${err instanceof Error ? err.message : err}`,
    );
  }
}

await main();
