// Route council lenses by the kind of file touched, not by diff size. A one-line
// auth change can need every lens; a lockfile-only push should not pay for
// performance. The classifier is pure — env and roster filtering live in the engine.

import {
  LOCKFILES,
  isAgentInstructionPath,
  isProseMediaPath,
} from "./behavioral-surface.mjs";
import { isTestPath } from "./council-config.mjs";
import { diffPaths } from "./review-delta.mjs";

const DEP_MANIFESTS = new Set([
  "package.json", "requirements.txt", "go.mod", "Cargo.toml", "pyproject.toml", "Gemfile",
]);

const STYLE_EXTENSIONS = new Set([".css", ".scss", ".less", ".sass"]);

// Same order as DEFAULT_MODELS so routed lenses match roster order, not alpha.
const ROUTED_LENS_ORDER = ["correctness", "performance", "security", "maintainability", "scope"];

const ALL_ROUTED_LENSES = [...ROUTED_LENS_ORDER];

const LENS_KINDS = {
  scope: null, // always dispatched — judged on the PR as a whole
  correctness: new Set(["source", "test", "ci", "deps", "agent"]),
  security: new Set(["source", "ci", "deps", "agent"]),
  maintainability: new Set(["source", "test", "agent", "ci"]),
  performance: new Set(["source", "style"]),
};

function basename(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function extensionOf(path) {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function isCiPath(path) {
  if (path.startsWith(".github/workflows/")) return true;
  const base = basename(path);
  if (base === "Dockerfile" || base === "action.yml") return true;
  return base.startsWith("docker-compose");
}

function isDepsPath(path) {
  const base = basename(path);
  if (LOCKFILES.has(base)) return true;
  return DEP_MANIFESTS.has(base);
}

function isDocsPath(path) {
  if (isAgentInstructionPath(path)) return false;
  return isProseMediaPath(path);
}

/** @returns {"docs"|"deps"|"ci"|"agent"|"test"|"style"|"source"} */
export function classifyPath(path) {
  // CI before agent: `.github` is a behavioral dir but workflow files need the ci lens.
  if (isCiPath(path)) return "ci";
  if (isAgentInstructionPath(path)) return "agent";
  if (isTestPath(path)) return "test";
  if (isDepsPath(path)) return "deps";
  if (STYLE_EXTENSIONS.has(extensionOf(path))) return "style";
  if (isDocsPath(path)) return "docs";
  // Unknown extensions are source, never docs — skipping review on real code is the
  // one direction this gate must never fail in.
  return "source";
}

/** @param {Iterable<string>} kinds */
export function lensesForKinds(kinds) {
  const kindSet = kinds instanceof Set ? kinds : new Set(kinds);
  return ROUTED_LENS_ORDER.filter((lens) => {
    if (lens === "scope") return true;
    return [...kindSet].some((kind) => LENS_KINDS[lens].has(kind));
  });
}

/** @returns {{ lenses: string[], kinds: string[] }} */
export function routeLenses(diff) {
  const paths = diffPaths(diff);
  if (paths.length === 0) {
    // Unparseable diff — fail open with the full council, never silently shrink coverage.
    return { lenses: ALL_ROUTED_LENSES, kinds: [] };
  }
  const kinds = [];
  for (const path of paths) {
    const kind = classifyPath(path);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { lenses: lensesForKinds(kinds), kinds };
}

export function isLensRoutingEnabled() {
  return String(process.env.VCR_LENS_ROUTING || "").trim().toLowerCase() !== "off";
}

// A lens this table does not know about. `COUNCIL_MODELS` accepts any lens
// string, and `mutation` has its own opt-in gate, so neither is ours to route:
// dropping a lens we cannot reason about would silently disable a roster the
// repo asked for, and blame it on paths that were in fact reviewable.
function isRoutable(lens) {
  return lens !== "mutation" && Object.hasOwn(LENS_KINDS, lens);
}

/** Filter roster members by kind routing; an unroutable lens passes through. */
export function filterMembersByKindRouting(members, diff, { routingEnabled = isLensRoutingEnabled() } = {}) {
  if (!routingEnabled) return { members, skippedLenses: [] };
  const { lenses } = routeLenses(diff);
  const allowed = new Set(lenses);
  const keeps = (m) => !isRoutable(m.lens) || allowed.has(m.lens);
  return {
    members: members.filter(keeps),
    skippedLenses: members.filter((m) => !keeps(m)).map((m) => m.lens),
  };
}
