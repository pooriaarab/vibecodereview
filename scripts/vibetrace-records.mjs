// vibetrace record builders — council cost/routing plus defect measurement.
import { parseChairVerdictsJson, verifyDispositionCoverage } from "./chair-verdicts.mjs";
import { parseFindings, parseFindingsMeta } from "./file-findings.mjs";
import { countAddedLines } from "./review-delta.mjs";

export const SCHEMA_VERSION = "0.3.0";

// The prefix every skip path writes. Matching it is what keeps a skipped
// review out of the `full` bucket; the table below only refines WHICH skip.
export const SKIP_PREFIX = "_Council skipped:";

// Written by council-review.mjs's top-level catch. A run that threw is not a
// quiet success, so it must not fall through to `full`/`delta` either.
export const ERROR_PREFIX = "_Council errored:";

const SKIP_MARKERS = {
  trivial: "_Council skipped: trivial delta",
  "no-lenses": "_Council skipped: no configured lens applies",
  "no-keys": "_Council skipped: no provider keys set",
  "no-diff": "_Council skipped: empty diff",
  "no-members": "_Council skipped: COUNCIL_MODELS parsed to no valid members",
};

/** @typedef {"full"|"delta"|"trivial"|"no-lenses"|"no-keys"|"no-diff"|"no-members"|"skipped"|"errored"} ReviewStrength */

/**
 * @param {string} markdown @param {"full"|"delta"} mode @returns {ReviewStrength}
 *
 * An unrecognised skip falls back to the generic `skipped`, never to `full`.
 * The whole point of this field is telling a QUIET review from one that never
 * ran, so a skip path added later that nobody added a marker for must not
 * silently land in the `full` bucket and read as "reviewed, found nothing".
 * `skipped` is deliberately coarse: it is honest about not knowing which gate
 * fired, which a wrong-but-specific answer would not be. A run that errored
 * out is checked first and separately, for the same reason: a crash is not a
 * review that found nothing either.
 *
 * Only a line that BEGINS with a marker counts. The engine always writes each
 * marker as its own line; a finding that merely quotes one is reviewer
 * content. That distinction is load-bearing on this repo in particular, where
 * the council reviews the very code these strings live in — an unanchored
 * match turned a real full review with a genuine finding into `trivial`.
 */
export function detectStrength(markdown, mode) {
  const lines = String(markdown || "").split("\n");
  const startsWithAnchored = (line, marker) => line.trimStart().startsWith(marker);
  if (lines.some((line) => startsWithAnchored(line, ERROR_PREFIX))) return "errored";
  for (const [strength, marker] of Object.entries(SKIP_MARKERS)) {
    if (lines.some((line) => startsWithAnchored(line, marker))) {
      return /** @type {ReviewStrength} */ (strength);
    }
  }
  if (lines.some((line) => startsWithAnchored(line, SKIP_PREFIX))) return "skipped";
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
 *   attribution: Record<string, unknown>,
 *   verdictsJson?: string,
 *   verdictsMissing?: boolean,
 * }} input
 */
export function buildChairRecord(input) {
  const { attribution, verdictsJson, verdictsMissing = false, findingsMarkdown } = input;
  const base = {
    schemaVersion: SCHEMA_VERSION,
    ts: new Date().toISOString(),
    type: "review.chair",
    attribution,
  };
  if (verdictsMissing || verdictsJson === undefined) {
    return {
      ok: true,
      record: { ...base, dispositionsMissing: true },
    };
  }
  const parsed = parseChairVerdictsJson(verdictsJson);
  if (!parsed.ok) {
    return {
      ok: true,
      record: { ...base, dispositionsMissing: true },
    };
  }
  // A well-formed file is not the same as a complete one. Cross-check the ids
  // against what the council actually recorded: a set that omits, duplicates or
  // invents a finding is not a verdict on this run, and recording it with
  // dispositionsMissing:false would hand the promotion counter a claim no chair
  // made. `coverageUnverified` marks the case where the report carried no meta
  // block to check against, so a reader can tell "checked and complete" from
  // "nothing to check".
  const knownIds = findingsMarkdown === undefined ? null : parseFindingsMeta(findingsMarkdown);
  const coverage = verifyDispositionCoverage(parsed.dispositions, knownIds);
  if (!coverage.ok) {
    return {
      ok: true,
      record: { ...base, dispositionsMissing: true, dispositionsRejected: coverage.reason },
    };
  }
  return {
    ok: true,
    record: {
      ...base,
      dispositionsMissing: false,
      verdict: parsed.verdict,
      dispositions: parsed.dispositions,
      coverageUnverified: knownIds === null,
    },
  };
}
