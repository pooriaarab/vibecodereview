// vibetrace record builders — council cost/routing plus defect measurement.
import fs from "node:fs";
import { parseFindings } from "./file-findings.mjs";
import { countAddedLines } from "./review-delta.mjs";

export const SCHEMA_VERSION = "0.2.0";

// The prefix every skip path writes. Matching it is what keeps a skipped
// review out of the `full` bucket; the table below only refines WHICH skip.
export const SKIP_PREFIX = "_Council skipped:";

const SKIP_MARKERS = {
  trivial: "_Council skipped: trivial delta",
  "no-lenses": "_Council skipped: no configured lens applies",
  "no-keys": "_Council skipped: no provider keys set",
  "no-diff": "_Council skipped: empty diff",
  "no-members": "_Council skipped: COUNCIL_MODELS parsed to no valid members",
};

/** @typedef {"full"|"delta"|"trivial"|"no-lenses"|"no-keys"|"no-diff"|"no-members"|"skipped"} ReviewStrength */

/**
 * @param {string} markdown @param {"full"|"delta"} mode @returns {ReviewStrength}
 *
 * An unrecognised skip falls back to the generic `skipped`, never to `full`.
 * The whole point of this field is telling a QUIET review from one that never
 * ran, so a skip path added later that nobody added a marker for must not
 * silently land in the `full` bucket and read as "reviewed, found nothing".
 * `skipped` is deliberately coarse: it is honest about not knowing which gate
 * fired, which a wrong-but-specific answer would not be.
 */
export function detectStrength(markdown, mode) {
  // Only a line that BEGINS with the marker counts. The engine always writes it
  // as its own line; a finding that merely quotes it is reviewer content. That
  // distinction is load-bearing on this repo in particular, where the council
  // reviews the very code these strings live in — an unanchored match turned a
  // real full review with a genuine finding into `trivial`.
  const lines = String(markdown || "").split("\n");
  const isSkipLine = (line) => line.trimStart().startsWith(SKIP_PREFIX);
  for (const [strength, marker] of Object.entries(SKIP_MARKERS)) {
    if (lines.some((line) => isSkipLine(line) && line.trimStart().startsWith(marker))) {
      return /** @type {ReviewStrength} */ (strength);
    }
  }
  if (lines.some(isSkipLine)) return "skipped";
  return mode === "delta" ? "delta" : "full";
}

/** @param {string} markdown */
export function parseSkippedLenses(markdown) {
  const match = /> Lenses not dispatched:\s*([^(]+)/.exec(String(markdown || ""));
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

/** @param {string} markdown */
export function councilFindingsPayload(markdown) {
  return parseFindings(markdown).map((f) => ({
    id: f.id,
    classKey: f.classKey,
    path: f.path,
    lens: f.lensFamily,
  }));
}

/**
 * @param {{
 *   mode: "full"|"delta",
 *   cacheHit: boolean,
 *   memberCount: number,
 *   cancelled: boolean,
 *   attribution: Record<string, unknown>,
 *   findingsMarkdown?: string,
 *   diffMarkdown?: string,
 * }} input
 */
export function buildCouncilRecord(input) {
  const { mode, cacheHit, memberCount, cancelled, attribution, findingsMarkdown = "", diffMarkdown = "" } = input;
  if (mode !== "full" && mode !== "delta") {
    return { ok: false, reason: "mode must be full or delta" };
  }
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
      strength: detectStrength(findingsMarkdown, mode),
      skippedLenses: parseSkippedLenses(findingsMarkdown),
      addedLines: countAddedLines(diffMarkdown),
      findings: councilFindingsPayload(findingsMarkdown),
      attribution,
    },
  };
}

/**
 * @param {{
 *   verdictsPath?: string,
 *   attribution: Record<string, unknown>,
 * }} input
 */
