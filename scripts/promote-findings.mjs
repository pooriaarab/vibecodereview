// Report which finding classKeys have earned promotion to a lint rule, test, or
// prose guard. Report only — never writes rules or opens PRs.
//
// Chair-confirmed counts come from vibetrace JSONL (review.council +
// review.chair). Live mode optionally enriches via `gh search issues` on
// vibecodereview-class markers — GitHub is the store for filed recurrence.
//
// Usage:
//   node promote-findings.mjs --repo owner/name --traces traces.jsonl [--promoted rules.json] [--live] [--now ISO]

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const CONFIRMED = new Set(["confirmed-fixed", "confirmed-open"]);
export const EVIDENCE_STRENGTH = new Set(["full", "delta"]);
export const LINT_CRITERION = { min: 3, days: 30 };
export const PROSE_CRITERION = { min: 5, days: 60 };
export const DELETE_IDLE_DAYS = 90;

const ISSUE_CLASS_RE = /vibecodereview-class:([a-f0-9]+)/;
const ISSUE_PR_RE = /review of #(\d+)/i;

/** @param {string} raw */
export function parseTraceLines(raw) {
  return String(raw || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** @param {unknown[]} records */
export function pairReviewSessions(records) {
  /** @type {Map<number, { councils: object[], chairs: object[] }>} */
  const byPr = new Map();
  for (const rec of records) {
    const pr = rec?.attribution?.pr;
    if (!Number.isInteger(pr) || pr <= 0) continue;
    if (!byPr.has(pr)) byPr.set(pr, { councils: [], chairs: [] });
    const bucket = byPr.get(pr);
    if (rec.type === "review.council") bucket.councils.push(rec);
    if (rec.type === "review.chair") bucket.chairs.push(rec);
  }
  /** @type {{ pr: number, council: object, chair: object|null }[]} */
  const sessions = [];
  for (const [pr, { councils, chairs }] of byPr) {
    councils.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    chairs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let ci = 0;
    for (const council of councils) {
      while (ci < chairs.length && String(chairs[ci].ts) < String(council.ts)) ci += 1;
      const chair = ci < chairs.length ? chairs[ci++] : null;
      sessions.push({ pr, council, chair });
    }
  }
  return sessions;
}

/** @param {ReturnType<typeof pairReviewSessions>} sessions */
export function confirmedOccurrencesFromSessions(sessions) {
  /** @type {Map<string, { pr: number, ts: string, strength: string, disposition: string, path: string, lens: string, id: string }>} */
  const byKey = new Map();
  for (const { pr, council, chair } of sessions) {
    const strength = String(council.strength || "");
    if (!EVIDENCE_STRENGTH.has(strength)) continue;
    if (!chair || chair.dispositionsMissing || !Array.isArray(chair.dispositions)) continue;
    const dispById = new Map(chair.dispositions.map((d) => [d.id, d.disposition]));
    for (const f of council.findings || []) {
      const disposition = dispById.get(f.id);
      if (!CONFIRMED.has(disposition)) continue;
      const dedupe = `${f.classKey}|${pr}`;
      if (byKey.has(dedupe)) continue;
      byKey.set(dedupe, {
        pr,
        ts: String(council.ts),
        strength,
        disposition,
        path: f.path,
        lens: f.lens,
        id: f.id,
        classKey: f.classKey,
      });
    }
  }
  return [...byKey.values()];
}

/** @param {object[]} hits @param {number} min @param {number} maxDays */
export function windowQualifies(hits, min, maxDays) {
  if (hits.length < min) return false;
  const sorted = [...hits].sort((a, b) => a.ts.localeCompare(b.ts));
  for (let i = 0; i <= sorted.length - min; i += 1) {
    const slice = sorted.slice(i, i + min);
    const span = (Date.parse(slice[slice.length - 1].ts) - Date.parse(slice[0].ts)) / 86400000;
    if (span <= maxDays) return true;
  }
  return false;
}

/** @param {ReturnType<typeof confirmedOccurrencesFromSessions>} occ @param {string} classKey */
export function hitsForClass(occ, classKey) {
  return occ.filter((o) => o.classKey === classKey);
}

/** @param {ReturnType<typeof confirmedOccurrencesFromSessions>} occ */
export function strengthSummary(occ) {
  const counts = {};
  for (const o of occ) counts[o.strength] = (counts[o.strength] || 0) + 1;
  return counts;
}

/** @param {{ path?: string, lens?: string }} sample */
export function recommendRank(sample) {
  const lens = String(sample.lens || "").toLowerCase();
  if (lens === "security" || lens === "correctness") {
    return { rank: 1, mechanism: "oxlint / type rule", why: "defect class suits static analysis (~0 cost per session)" };
  }
  if (sample.path?.includes("/")) {
    return { rank: 2, mechanism: "unit or CI test", why: "concrete path trigger suits a named failure test" };
  }
  return {
    rank: 3,
    mechanism: "prose rule in AGENTS.md / .claude/rules",
    why: "judgment call — only after lint/test ruled out (tokens every session)",
  };
}

/** @param {ReturnType<typeof confirmedOccurrencesFromSessions>} occ @param {object} opts */
export function analyzePromotions(occ, opts = {}) {
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const proseRuled = new Set(opts.proseRuledOut || []);
  const classKeys = [...new Set(occ.map((o) => o.classKey))];
  const lintEarned = [];
  const proseEarned = [];
  const nearMiss = [];

  for (const classKey of classKeys) {
    const hits = hitsForClass(occ, classKey);
    const distinctPrs = new Set(hits.map((h) => h.pr)).size;
    const rank = recommendRank(hits[0] || {});
    const strength = strengthSummary(hits);
    const entry = { classKey, hits: hits.length, distinctPrs, strength, rank, samples: hits.slice(0, 2) };

    if (
      distinctPrs >= LINT_CRITERION.min
      && windowQualifies(hits, LINT_CRITERION.min, LINT_CRITERION.days)
      && rank.rank !== 3
    ) {
      lintEarned.push(entry);
    } else if (
      proseRuled.has(classKey)
      && distinctPrs >= PROSE_CRITERION.min
      && windowQualifies(hits, PROSE_CRITERION.min, PROSE_CRITERION.days)
    ) {
      proseEarned.push(entry);
    } else if (hits.length >= 2) {
      nearMiss.push(entry);
    }
  }

  const promoted = Array.isArray(opts.promoted) ? opts.promoted : [];
  const deleteCandidates = [];
  for (const rule of promoted) {
    const hits = hitsForClass(occ, rule.classKey);
    const last = hits.sort((a, b) => b.ts.localeCompare(a.ts))[0];
    const idleDays = last ? (now - Date.parse(last.ts)) / 86400000 : Infinity;
    if (idleDays >= DELETE_IDLE_DAYS) {
      deleteCandidates.push({ ...rule, lastConfirmed: last?.ts || null, idleDays: Math.floor(idleDays) });
    }
  }

  return { lintEarned, proseEarned, nearMiss, deleteCandidates, now: new Date(now).toISOString() };
}

export function ghSearchClass(repo, classKey, searchFn = defaultGhSearch) {
  return searchFn(repo, `vibecodereview-class:${classKey}`);
}

function defaultGhSearch(repo, needle) {
  const out = execFileSync(
    "gh",
    ["search", "issues", "--repo", repo, "--match", "body", needle, "--json", "number,createdAt,state,body"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out || "[]");
}

/** @param {string} body */
export function parseIssueClass(body) {
  const m = ISSUE_CLASS_RE.exec(String(body || ""));
  return m ? m[1] : null;
}

/** @param {string} body */
export function parseIssuePr(body) {
  const m = ISSUE_PR_RE.exec(String(body || ""));
  return m ? Number(m[1]) : null;
}

export function formatReport(repo, analysis) {
  const lines = [`# Promotion report — ${repo}`, `Generated: ${analysis.now}`, ""];
  lines.push("Chair-push guard: traces attribute to the review run, not the writer state before the chair pushed fixes. A quiet next PR may be chair-healed, not learned.");
  lines.push("");

  if (analysis.lintEarned.length) {
    lines.push("## Earned — lint rule or test (rank 1–2, 3 confirmed / 3 PRs / 30 days)");
    for (const e of analysis.lintEarned) {
      lines.push(`- \`${e.classKey.slice(0, 12)}…\` — ${e.distinctPrs} PRs, strength ${JSON.stringify(e.strength)}`);
      lines.push(`  Recommend rank ${e.rank.rank}: ${e.rank.mechanism} — ${e.rank.why}`);
      if (e.rank.rank === 3) lines.push("  WARNING: rank 3 not allowed here; use prose path instead.");
    }
    lines.push("");
  } else {
    lines.push("## Earned — lint/test\n(none)\n");
  }

  if (analysis.proseEarned.length) {
    lines.push("## Earned — prose (rank 3, 5 confirmed / 5 PRs / 60 days, lint/test ruled out)");
    for (const e of analysis.proseEarned) {
      lines.push(`- \`${e.classKey.slice(0, 12)}…\` — strength ${JSON.stringify(e.strength)}`);
      lines.push(`  Recommend rank 3 only: ${e.rank.mechanism}`);
    }
    lines.push("");
  }

  if (analysis.deleteCandidates.length) {
    lines.push(`## Delete candidates (zero confirmed ≥ ${DELETE_IDLE_DAYS} days)`);
    for (const d of analysis.deleteCandidates) {
      lines.push(`- ${d.label || d.classKey.slice(0, 12)} — last confirmed ${d.lastConfirmed || "never"}, idle ${d.idleDays}d`);
    }
    lines.push("");
  }

  if (analysis.nearMiss.length) {
    lines.push("## Near miss (not yet promoted)");
    for (const e of analysis.nearMiss) {
      lines.push(`- \`${e.classKey.slice(0, 12)}…\` — ${e.hits} confirmed hits / ${e.distinctPrs} PRs, strength ${JSON.stringify(e.strength)}`);
    }
  }
  return lines.join("\n");
}

export function runReport({ repo, traces, promoted = [], proseRuledOut = [], live = false, now, searchFn }) {
  const records = parseTraceLines(traces);
  const occ = confirmedOccurrencesFromSessions(pairReviewSessions(records));
  const analysis = analyzePromotions(occ, { promoted, proseRuledOut, now });
  if (live) {
    for (const e of [...analysis.lintEarned, ...analysis.proseEarned]) {
      e.issues = ghSearchClass(repo, e.classKey, searchFn);
    }
  }
  return { analysis, report: formatReport(repo, analysis), occurrences: occ };
}

function usage() {
  return `Usage: promote-findings.mjs --repo owner/name --traces FILE [--promoted rules.json] [--prose-ruled classKey,...] [--live] [--now ISO]`;
}

export async function main(argv) {
  const opts = { proseRuledOut: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--live") { opts.live = true; continue; }
    if (a === "--repo") { opts.repo = argv[++i]; continue; }
    if (a === "--traces") { opts.traces = fs.readFileSync(argv[++i], "utf8"); continue; }
    if (a === "--promoted") { opts.promoted = JSON.parse(fs.readFileSync(argv[++i], "utf8")); continue; }
    if (a === "--prose-ruled") { opts.proseRuledOut = argv[++i].split(",").filter(Boolean); continue; }
    if (a === "--now") { opts.now = argv[++i]; continue; }
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (!opts.repo || !opts.traces) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const { report } = runReport(opts);
  process.stdout.write(`${report}\n`);
  return 0;
}

const invoked = process.argv[1]?.endsWith("promote-findings.mjs");
if (invoked) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
