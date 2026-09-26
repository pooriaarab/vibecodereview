// Fail-closed guard for the checkout-root chair verdict scratch path (#194).
// info/exclude does not apply to tracked files; a consumer PR that tracks
// chair-verdicts.json must not be overwritten by the chair Write tool.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHAIR_VERDICTS_BASENAME = "chair-verdicts.json";

/**
 * @param {string} [cwd]
 */
export function defaultChairVerdictsPath(cwd = process.cwd()) {
  return path.join(cwd, CHAIR_VERDICTS_BASENAME);
}

/**
 * @param {string} file path relative to cwd or absolute
 * @param {string} [cwd]
 */
export function isGitTracked(file, cwd = process.cwd()) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve symlinks for an existing path so tracked checks apply to the write target.
 *
 * @param {string} file
 * @param {string} [cwd]
 */
export function resolveWriteTarget(file, cwd = process.cwd()) {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  try {
    if (fs.existsSync(abs)) {
      return fs.realpathSync(abs);
    }
    if (fs.lstatSync(abs).isSymbolicLink()) {
      return fs.realpathSync(abs);
    }
  } catch {
    // Missing path: the chair will create a new scratch file at abs.
  }
  return abs;
}

/**
 * @param {string} verdictsPath absolute or cwd-relative path
 * @param {string} [cwd]
 * @returns {string | null} human reason when unsafe; null when ok
 */
export function chairVerdictsPathUnsafeReason(verdictsPath, cwd = process.cwd()) {
  const abs = path.isAbsolute(verdictsPath) ? verdictsPath : path.resolve(cwd, verdictsPath);
  const candidates = new Set([abs]);
  try {
    candidates.add(resolveWriteTarget(abs, cwd));
  } catch {
    return "chair verdicts path could not be resolved";
  }
  for (const candidate of candidates) {
    if (isGitTracked(candidate, cwd)) {
      return `git-tracked path ${candidate}`;
    }
  }
  return null;
}

/**
 * @param {string} verdictsPath
 * @param {string} [cwd]
 */
export function assertChairVerdictsPathSafe(verdictsPath, cwd = process.cwd()) {
  const reason = chairVerdictsPathUnsafeReason(verdictsPath, cwd);
  if (reason) {
    return { ok: false, reason };
  }
  return { ok: true };
}

function runCli() {
  const args = process.argv.slice(2);
  if (args[0] !== "--assert" || !args[1]) {
    console.error("usage: chair-verdicts-path.mjs --assert <path>");
    process.exit(2);
  }
  const result = assertChairVerdictsPathSafe(args[1]);
  if (!result.ok) {
    console.error(
      `::error::chair verdicts path is unsafe (${result.reason}); refuse to use as scratch file`,
    );
    process.exit(1);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runCli();
}
