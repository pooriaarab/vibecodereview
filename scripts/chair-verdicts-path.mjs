// Fail-closed guard for the checkout-root chair verdict scratch path (#194, #201).
// info/exclude does not apply to tracked files; a consumer PR that tracks
// chair-verdicts.json must not be overwritten by the chair Write tool.
import { spawnSync } from "node:child_process";
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

function runRevParseTopLevel(cwd) {
  return spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
}

/**
 * @param {string} cwd
 * @returns {string | null} human reason when not a git checkout; null when ok
 */
export function gitCheckoutUnsafeReason(cwd = process.cwd()) {
  const r = runRevParseTopLevel(cwd);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim();
    return detail
      ? `checkout is not a git repository (${detail})`
      : "checkout is not a git repository";
  }
  if (!r.stdout?.trim()) {
    return "checkout is not a git repository";
  }
  return null;
}

function gitRepositoryTopLevel(cwd = process.cwd()) {
  const r = runRevParseTopLevel(cwd);
  if (r.status !== 0 || !r.stdout?.trim()) {
    const detail = (r.stderr || r.stdout || "").trim();
    throw new Error(detail || "checkout is not a git repository");
  }
  return r.stdout.trim();
}

function isOutsideRepository(rel) {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function canonicalPathForGitTracking(abs) {
  try {
    return fs.realpathSync.native(abs);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      const parent = path.dirname(abs);
      const base = path.basename(abs);
      return path.join(fs.realpathSync.native(parent), base);
    }
    throw err;
  }
}

/**
 * @param {string} file path relative to cwd or absolute
 * @param {string} [cwd]
 * @returns {boolean}
 * @throws when git cannot answer tracked vs untracked
 */
export function isGitTracked(file, cwd = process.cwd()) {
  const topLevel = gitRepositoryTopLevel(cwd);
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const canonicalAbs = canonicalPathForGitTracking(abs);
  const rel = path.relative(topLevel, canonicalAbs);
  if (isOutsideRepository(rel)) {
    return false;
  }
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
    cwd: topLevel,
    encoding: "utf8",
  });
  if (r.status === 0) {
    return true;
  }
  if (r.status === 1) {
    return false;
  }
  const detail = (r.stderr || r.stdout || "").trim();
  throw new Error(detail || `git ls-files failed with exit ${r.status ?? "unknown"}`);
}

/**
 * Resolve a non-symlink path for reads. Symlinks are refused (#201).
 *
 * @param {string} file
 * @param {string} [cwd]
 */
export function resolveWriteTarget(file, cwd = process.cwd()) {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return abs;
    }
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symlink refused at ${abs}`);
  }
  if (stat.isFile() || stat.isDirectory()) {
    return fs.realpathSync(abs);
  }
  return abs;
}

function isEnoent(err) {
  return err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}

/**
 * @param {string} probe
 * @param {string} originalAbs
 */
function symlinkReasonAt(probe, originalAbs) {
  if (!fs.lstatSync(probe).isSymbolicLink()) {
    return null;
  }
  if (probe === originalAbs) {
    return `symlink at chair verdicts path ${originalAbs}`;
  }
  return `symlink in chair verdicts path at ${probe}`;
}

function scratchSymlinkUnsafeReason(abs) {
  const root = path.parse(abs).root;
  let probe = abs;
  while (true) {
    let linkReason;
    try {
      linkReason = symlinkReasonAt(probe, abs);
    } catch (err) {
      if (!isEnoent(err) || probe !== abs) {
        return `chair verdicts path could not be inspected (${abs})`;
      }
      const parent = path.dirname(probe);
      if (parent === probe || parent === root) {
        return null;
      }
      probe = parent;
      continue;
    }
    if (linkReason) {
      return linkReason;
    }
    if (probe === root) {
      return null;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      return null;
    }
    probe = parent;
  }
}

/**
 * @param {string} verdictsPath absolute or cwd-relative path
 * @param {string} [cwd]
 * @returns {string | null} human reason when unsafe; null when ok
 */
export function chairVerdictsPathUnsafeReason(verdictsPath, cwd = process.cwd()) {
  const repoReason = gitCheckoutUnsafeReason(cwd);
  if (repoReason) {
    return repoReason;
  }

  const abs = path.isAbsolute(verdictsPath) ? verdictsPath : path.resolve(cwd, verdictsPath);

  const symlinkReason = scratchSymlinkUnsafeReason(abs);
  if (symlinkReason) {
    return symlinkReason;
  }

  try {
    if (isGitTracked(abs, cwd)) {
      return `git-tracked path ${abs}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `git tracked check failed (${msg})`;
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
