#!/usr/bin/env node
// Issue #129: promotion ladder measurement — report only, fixtures only (no network).
import {
  analyzePromotions,
  confirmedOccurrencesFromSessions,
  pairReviewSessions,
  parseTraceLines,
  windowQualifies,
  LINT_CRITERION,
  DELETE_IDLE_DAYS,
} from "./promote-findings.mjs";
import { buildClassKey } from "./file-findings.mjs";

let failed = 0;
function fail(msg) {
  console.error(`FAIL ${msg}`);
  failed += 1;
}
function ok(msg) {
  console.log(`ok - ${msg}`);
}

const CLASS = buildClassKey("correctness", "src/x.ts", "empty catch block swallows error -> log or rethrow");
const OTHER = buildClassKey("security", "src/y.ts", "api key in source -> move to env");

function session({ pr, ts, id, classKey = CLASS, disposition, strength = "full" }) {
  const council = {
    type: "review.council",
    ts,
    strength,
    findings: [{ id, classKey, path: "src/x.ts", lens: "correctness" }],
    attribution: { pr, repo: "o/r" },
  };
  const chair = {
    type: "review.chair",
    ts: new Date(Date.parse(ts) + 1000).toISOString(),
    dispositionsMissing: false,
    verdict: "comment",
    dispositions: [{ id, disposition }],
    attribution: { pr, repo: "o/r" },
  };
  return [council, chair];
}

function buildTrace(sessions) {
  return sessions.flat().map((r) => JSON.stringify(r)).join("\n");
}

function occFromSessions(sessions) {
  return confirmedOccurrencesFromSessions(pairReviewSessions(parseTraceLines(buildTrace(sessions))));
}

{
  const sessions = [
    session({ pr: 1, ts: "2026-08-01T00:00:00Z", id: "a1", disposition: "confirmed-open" }),
    session({ pr: 2, ts: "2026-08-10T00:00:00Z", id: "a2", disposition: "confirmed-fixed" }),
    session({ pr: 3, ts: "2026-08-20T00:00:00Z", id: "a3", disposition: "confirmed-open" }),
  ];
  const analysis = analyzePromotions(occFromSessions(sessions), { now: "2026-08-25T00:00:00Z" });
  if (!analysis.lintEarned.some((e) => e.classKey === CLASS)) {
    fail("3 confirmed / 3 PRs / 30d should promote lint/test");
  } else ok("3 confirmed across 3 distinct PRs within 30 days promotes");
}

{
  const sessions = [
    session({ pr: 9, ts: "2026-08-01T00:00:00Z", id: "b1", disposition: "confirmed-open" }),
    session({ pr: 9, ts: "2026-08-02T00:00:00Z", id: "b2", disposition: "confirmed-open" }),
    session({ pr: 9, ts: "2026-08-03T00:00:00Z", id: "b3", disposition: "confirmed-fixed" }),
  ];
  const analysis = analyzePromotions(occFromSessions(sessions), { now: "2026-08-05T00:00:00Z" });
  if (analysis.lintEarned.some((e) => e.classKey === CLASS)) {
    fail("three hits on one PR must not promote (distinct PR rule)");
  } else ok("3 confirmed hits on one PR does not promote");
}

{
  const sessions = [
    session({ pr: 1, ts: "2026-08-01T00:00:00Z", id: "c1", disposition: "confirmed-open" }),
    session({ pr: 2, ts: "2026-08-05T00:00:00Z", id: "c2", disposition: "confirmed-open" }),
    session({ pr: 3, ts: "2026-08-10T00:00:00Z", id: "c3", disposition: "rejected" }),
  ];
  const occ = occFromSessions(sessions);
  if (occ.length !== 2) fail(`expected 2 chair-confirmed, got ${occ.length}`);
  const analysis = analyzePromotions(occ, { now: "2026-08-15T00:00:00Z" });
  if (analysis.lintEarned.some((e) => e.classKey === CLASS)) {
    fail("rejected disposition must not count toward promotion");
  } else ok("2 confirmed + 1 rejected across 3 PRs does not promote");
}

{
  const sessions = [
    session({ pr: 1, ts: "2026-07-01T00:00:00Z", id: "d1", disposition: "confirmed-open" }),
    session({ pr: 2, ts: "2026-07-15T00:00:00Z", id: "d2", disposition: "confirmed-open" }),
    session({ pr: 3, ts: "2026-08-05T00:00:00Z", id: "d3", disposition: "confirmed-open" }),
  ];
  const occ = occFromSessions(sessions);
  if (windowQualifies(occ.filter((o) => o.classKey === CLASS), LINT_CRITERION.min, LINT_CRITERION.days)) {
    fail("31+ day span must not satisfy 30-day window");
  } else ok("3 confirmed spanning 31+ days does not promote");
}

{
  const occ = occFromSessions([
    session({ pr: 1, ts: "2026-01-01T00:00:00Z", id: "e1", disposition: "confirmed-open", classKey: OTHER }),
  ]);
  const analysis = analyzePromotions(occ, {
    now: "2026-06-01T00:00:00Z",
    promoted: [{ classKey: OTHER, label: "old-rule", promotedAt: "2025-01-01T00:00:00Z" }],
  });
  if (!analysis.deleteCandidates.some((d) => d.classKey === OTHER)) {
    fail("promoted rule with no recent confirmed hit should be delete candidate");
  } else ok(`promoted rule idle ≥ ${DELETE_IDLE_DAYS}d listed as delete candidate`);
}

{
  const sessions = [
    session({ pr: 1, ts: "2026-08-01T00:00:00Z", id: "f1", disposition: "confirmed-open", strength: "trivial" }),
    session({ pr: 2, ts: "2026-08-10T00:00:00Z", id: "f2", disposition: "confirmed-open", strength: "trivial" }),
    session({ pr: 3, ts: "2026-08-20T00:00:00Z", id: "f3", disposition: "confirmed-open", strength: "trivial" }),
  ];
  if (occFromSessions(sessions).length !== 0) fail("trivial runs must not contribute evidence");
  else ok("trivial strength skipped — not counted in denominator");
}

// Decorative guard: any new check must stay ABOVE this line (see AGENTS / issue #129).
// The distinct-PR rule, exercised directly on analyzePromotions.
//
// The end-to-end fixtures cannot reach it: confirmedOccurrencesFromSessions
// dedupes per (classKey, pr), so hits.length and distinctPrs are always equal
// by the time analyzePromotions runs, and replacing one with the other passes
// every other test in this file. Feed it occurrence records that name the same
// PR three times — the shape a future caller or a relaxed dedupe would produce
// — so the guard is pinned by intent rather than by an upstream accident.
{
  const at = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const occ = (pr, days) => ({
    classKey: "K", pr, disposition: "confirmed-open", ts: at(days),
    strength: "full", path: "src/a.ts", lens: "correctness", id: `i${pr}${days}`,
  });
  const onePr = analyzePromotions([occ(7, 5), occ(7, 10), occ(7, 15)]);
  if (onePr.lintEarned.length !== 0) {
    console.error("FAIL three occurrences on ONE pr must not promote", onePr.lintEarned);
    failed++;
  }
  const threePrs = analyzePromotions([occ(1, 5), occ(2, 10), occ(3, 15)]);
  if (threePrs.lintEarned.length !== 1) {
    console.error("FAIL three occurrences across THREE prs must promote", threePrs);
    failed++;
  } else {
    console.log("ok - promotion counts distinct PRs, not raw occurrences");
  }
}

console.log("\npromote-findings tests passed");
if (failed) process.exit(1);
