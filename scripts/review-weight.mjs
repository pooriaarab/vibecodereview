// After kind routing, shrink the council further by how risky the delta is.
// Kind routing asks "can this lens speak to these files?". This asks "does
// this delta need more than one or two speakers?". A CSS tweak does not need
// five models; an auth change still does.
//
// Fail open: an unparseable diff, or VCR_REVIEW_WEIGHT=off, keeps the roster
// kind routing already chose. Wrongly shrinking a risky review is worse than
// paying for one extra member.

import { diffPaths } from "./review-delta.mjs";
import { routeLenses } from "./lens-routing.mjs";

const HIGH_RISK_SEGMENTS = new Set([
  "acl", "auth", "authentication", "authorization", "authorize",
  "billing", "credential", "credentials", "crypto", "iam", "invoice",
  "jwt", "kms", "migrate", "migration", "migrations", "oauth", "oidc",
  "passwd", "password", "payment", "payments", "pem", "rbac", "saml",
  "schema", "secret", "secrets", "session", "sessions", "stripe",
  "webhook", "webhooks",
]);

const WEIGHT_REASON = {
  chair: "style-only; the chair reviews alone",
  light: "tests or manifests; a short specialist pass",
  core: "ordinary source; correctness and security",
  full: "CI, agent instructions, high-risk paths, or unparseable",
};

function basename(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function extensionOf(path) {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function pathSegments(path) {
  return String(path).toLowerCase().split(/[/_.-]+/).filter(Boolean);
}

/** A path that must never take the cheap roster. */
export function isHighRiskPath(path) {
  const base = basename(path);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (extensionOf(path) === ".sql" || extensionOf(path) === ".pem") return true;
  return pathSegments(path).some((seg) => HIGH_RISK_SEGMENTS.has(seg));
}

export function isReviewWeightEnabled() {
  return String(process.env.VCR_REVIEW_WEIGHT || "").trim().toLowerCase() !== "off";
}

function lightLenses(kinds) {
  const keep = new Set(["correctness"]);
  if (kinds.includes("deps")) keep.add("security");
  if (kinds.includes("test")) keep.add("maintainability");
  return [...keep];
}

/**
 * @param {string[]} kinds
 * @param {string[]} paths
 * @returns {{ weight: "chair"|"light"|"core"|"full", keep: string[]|null }}
 */
export function decideWeight(kinds, paths) {
  if (!kinds.length) return { weight: "full", keep: null };
  const set = new Set(kinds);
  const onlyQuiet = [...set].every((k) => k === "style" || k === "docs");
  if (onlyQuiet) return { weight: "chair", keep: [] };
  if (set.has("ci") || set.has("agent")) return { weight: "full", keep: null };
  if (set.has("source")) {
    if (paths.some(isHighRiskPath)) return { weight: "full", keep: null };
    return { weight: "core", keep: ["correctness", "security"] };
  }
  return { weight: "light", keep: lightLenses(kinds) };
}

/**
 * Filter a kind-routed roster. Unknown / mutation lenses drop on every
 * weight except full — they are opt-in extras, not a reason to fail open.
 * @param {Array<{ lens: string }>} members
 * @param {string} diff
 */
export function filterMembersByWeight(members, diff, { enabled = isReviewWeightEnabled() } = {}) {
  if (!enabled) {
    return { members, skippedLenses: [], weight: "full", reason: "disabled" };
  }
  const { kinds } = routeLenses(diff);
  const { weight, keep } = decideWeight(kinds, diffPaths(diff));
  if (keep === null) {
    return { members, skippedLenses: [], weight, reason: WEIGHT_REASON[weight] };
  }
  const allowed = new Set(keep);
  const keeps = (m) => allowed.has(m.lens);
  return {
    members: members.filter(keeps),
    skippedLenses: members.filter((m) => !keeps(m)).map((m) => m.lens),
    weight,
    reason: WEIGHT_REASON[weight],
  };
}
