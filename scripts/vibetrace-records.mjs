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
  const text = String(markdown || "");
  for (const [strength, marker] of Object.entries(SKIP_MARKERS)) {
    if (text.includes(marker)) return /** @type {ReviewStrength} */ (strength);
  }
  if (text.includes(SKIP_PREFIX)) return "skipped";
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
export function buildChairRecord({ verdictsPath, attribution }) {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    ts: new Date().toISOString(),
    type: "review.chair",
    attribution,
  };
  if (!verdictsPath || !fs.existsSync(verdictsPath)) {
    return { ok: true, record: { ...base, dispositionsMissing: true } };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(verdictsPath, "utf8"));
  } catch {
    return { ok: true, record: { ...base, dispositionsMissing: true } };
  }
  const dispositions = Array.isArray(parsed?.dispositions) ? parsed.dispositions : [];
  const record = {
    ...base,
    dispositionsMissing: false,
    verdict: typeof parsed?.verdict === "string" ? parsed.verdict : undefined,
    dispositions: dispositions.map((d) => ({
      id: d.id,
      classKey: d.classKey,
      disposition: d.disposition,
    })),
  };
  return { ok: true, record };
}
