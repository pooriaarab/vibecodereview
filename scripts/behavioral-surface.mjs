// Classify a git diff by whether any changed path has behavioral surface.
// Used by the council engine to skip model calls on docs-only / lockfile pushes.

import { diffPaths } from "./review-delta.mjs";

const EDITOR_NOISE = new Set([
  ".gitignore", ".gitattributes", ".editorconfig", ".prettierignore",
  ".npmignore", ".dockerignore", ".cursorignore",
]);

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "Gemfile.lock",
  "composer.lock", "go.sum", "Pipfile.lock", "uv.lock", "flake.lock",
]);

const INERT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".mp4", ".mov", ".woff", ".woff2", ".ttf", ".otf",
]);

const AGENT_INSTRUCTION_NAMES = new Set([
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules", "SKILL.md",
]);

const BEHAVIORAL_DIRS = new Set([
  ".claude", ".agents", ".cursor", ".github",
  "skills", "commands", "prompts", "rules", "hooks",
]);

function basename(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function extensionOf(path) {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function isAgentInstructionPath(path) {
  if (AGENT_INSTRUCTION_NAMES.has(basename(path))) return true;
  return path.split("/").some((seg) => BEHAVIORAL_DIRS.has(seg));
}

function isInertPath(path) {
  if (isAgentInstructionPath(path)) return false;
  const base = basename(path);
  if (EDITOR_NOISE.has(base)) return true;
  if (base === "LICENSE" || base === "NOTICE") return true;
  // Exact name only. A `startsWith` here made `CHANGELOG_GENERATOR.py` inert,
  // which skips review on a source file — the one direction this gate must
  // never fail in. A real changelog with an extension is already covered by
  // INERT_EXTENSIONS below.
  if (base === "CHANGELOG") return true;
  if (LOCKFILES.has(base)) return true;
  return INERT_EXTENSIONS.has(extensionOf(path));
}

/** @returns {{ trivial: boolean, paths: string[], reason: string }} */
export function behavioralSurface(diff) {
  const paths = diffPaths(diff);
  if (paths.length === 0) {
    return { trivial: false, paths, reason: "no parseable paths in diff" };
  }
  const behavioral = paths.filter((p) => !isInertPath(p));
  if (behavioral.length > 0) {
    return {
      trivial: false,
      paths,
      reason: `changed paths include behavioral surface (${behavioral.join(", ")})`,
    };
  }
  return {
    trivial: true,
    paths,
    reason: "every changed path is inert (docs, lockfiles, assets, or editor noise)",
  };
}
