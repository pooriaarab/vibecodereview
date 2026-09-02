#!/usr/bin/env node
// Cut a release: update package.json, commit it, then cut an immutable vX.Y.Z
// tag and force-move the vX pointer.
//
// Two tags, not one. The immutable tag is what makes "which version are we on"
// and "put it back" answerable; the moving major tag is what the ~80 consuming
// repos follow to get fixes without editing 80 workflows. Skipping the
// immutable one leaves no rollback target except a SHA dug out of git log,
// which is where this repo was until v1.0.0 was cut retroactively.
//
// Usage:
//   node bin/release.mjs 1.2.0            # dry run, prints the plan
//   node bin/release.mjs 1.2.0 --apply
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
const apply = process.argv.includes("--apply");

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || "")) {
  console.error("usage: release.mjs <major.minor.patch> [--apply]");
  process.exit(2);
}

const majorNum = version.split(".")[0];
const major = `v${majorNum}`;
const tag = `v${version}`;
const REMOTE = process.env.RELEASE_REMOTE || "origin";
const BRANCH = process.env.RELEASE_BRANCH || "main";
const PKG = "package.json";
const REPO = "pooriaarab/vibecodereview";

const git = (args, opts = {}) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch (err) {
    if (opts.ok) return "";
    console.error(String(err.stderr || err.message).trim());
    process.exit(1);
  }
};

// git merge-base --is-ancestor communicates through exit code, not stdout, so
// it needs its own success/failure check rather than the ok:true "" fallback above.
const isAncestor = (ancestor, descendant) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
};

// Read the remote so the plan and the guard checks are against the same tree
// the tags will eventually point to. In dry-run mode this fetches refs only;
// it does not touch the working tree. --force refreshes a local vX that a
// prior release already moved on the remote -- without it, a plain
// `--tags` fetch exits non-zero ("would clobber existing tag") and the
// script dies before the plan is even printed, on every checkout that has
// ever fetched a moving tag this repo later force-moved again.
git(["fetch", REMOTE, "--tags", "--force"]);

const mainSha = git(["rev-parse", `${REMOTE}/${BRANCH}`]);

const beforeVersion = (() => {
  try {
    return JSON.parse(git(["show", `${REMOTE}/${BRANCH}:${PKG}`])).version;
  } catch {
    return JSON.parse(readFileSync(PKG, "utf8")).version;
  }
})();

const tagSha = (name) => git(["rev-parse", "-q", "--verify", `refs/tags/${name}^{}`], { ok: true }) || null;

const existingTagSha = tagSha(tag);
if (existingTagSha && existingTagSha !== mainSha) {
  console.error(
    `${tag} already exists at ${existingTagSha.slice(0, 7)}, not main (${mainSha.slice(0, 7)}). ` +
      `Immutable tags are never moved. Pick the next version.`,
  );
  process.exit(1);
}
const tagExists = existingTagSha !== null;
const majorExists = tagSha(major) !== null;

// A brand-new major (e.g. the first 2.0.0) has no vX ref to move yet, so it
// must be created rather than moved, or the release half-completes.
// vX is documented as always pointing at the newest vX.Y.Z of that major line.
// Releasing an older/out-of-order version would force-move vX backward — a
// regression shipped to every consuming repo pinned to @vX. Refuse unless this
// version is at least as new as every other vX.*.* tag that exists.
const verRe = new RegExp(`^v${majorNum}\\.(\\d+)\\.(\\d+)$`);
const existingTags = git(["for-each-ref", "--format=%(refname:short)", `refs/tags/${major}.*`], { ok: true })
  .split("\n")
  .filter(Boolean)
  .filter((name) => name !== tag);
const existingVersions = existingTags
  .map((name) => name.match(verRe))
  .filter(Boolean)
  .map((m) => [Number(majorNum), Number(m[1]), Number(m[2])]);
const newVer = version.split(".").map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const highest = existingVersions.sort(cmp).pop();
if (highest && cmp(newVer, highest) <= 0) {
  console.error(
    `${tag} is not newer than existing v${highest.join(".")}. ` +
      `Moving ${major} backward would regress every repo pinned to @${major}. Pick a version above v${highest.join(".")}.`,
  );
  process.exit(1);
}

console.log(`main      ${mainSha.slice(0, 7)}`);
console.log(`package.json  ${beforeVersion === version ? `${version} (already)` : `${beforeVersion} -> ${version}`}`);
console.log(tagExists ? `exists    ${tag} -> ${mainSha.slice(0, 7)} (resuming)` : `create    ${tag} -> ${mainSha.slice(0, 7)}`);
console.log(`${majorExists ? "move     " : "create   "} ${major} -> ${mainSha.slice(0, 7)}`);

if (!apply) {
  console.log("\ndry run. Nothing was written. Re-run with --apply.");
  process.exit(0);
}

if (tagExists) {
  console.log(`${tag} already exists at this sha, skipping`);
  // tagExists only proves a local ref at the right sha -- a prior --apply may have
  // created the tag locally and then failed to push it (network blip). Pushing it
  // again is a safe no-op once the remote already has it at this sha.
  git(["push", REMOTE, tag]);
  // The immutable tag is already correct; make sure the moving major pointer is too.
  git(["tag", "-f", major, mainSha]);
  git(["push", REMOTE, `+refs/tags/${major}`]);
} else {
  // Check out a clean, up-to-date main. This is the release branch; any uncommitted
  // local changes would be ambiguous with the version bump we are about to make.
  // Refuse rather than resetting a local branch of the same name that has diverged
  // (e.g. unpushed local commits) -- `checkout -B` would otherwise silently rewind it.
  // A local branch that is merely BEHIND the remote (the common case after someone
  // else has merged to main) is not divergence -- `checkout -B` only fast-forwards
  // it there, so only refuse when local is not an ancestor of the remote.
  const localBranchSha = git(["rev-parse", "-q", "--verify", BRANCH], { ok: true });
  if (localBranchSha && localBranchSha !== mainSha && !isAncestor(localBranchSha, mainSha)) {
    console.error(
      `error: local ${BRANCH} (${localBranchSha.slice(0, 7)}) differs from ${REMOTE}/${BRANCH} ` +
        `(${mainSha.slice(0, 7)}); refusing to reset it`,
    );
    process.exit(1);
  }
  git(["checkout", "-B", BRANCH, `${REMOTE}/${BRANCH}`]);
  if (git(["status", "--short"])) {
    console.error("error: the working tree has uncommitted changes");
    process.exit(1);
  }

  const pkgText = readFileSync(PKG, "utf8");
  const versionFieldRe = /("version"\s*:\s*")[^"]*(")/;
  const match = pkgText.match(versionFieldRe);
  if (!match) {
    console.error("error: could not find a version field to update in package.json");
    process.exit(1);
  }
  // A prior --apply may have pushed this same version bump to main and then failed
  // before the tag push (see the tagExists branch above for the tag-only half of
  // this). Comparing the matched value (not just replacing) tells "already at the
  // target version" apart from "no version field found" so resuming doesn't error.
  if (match[0] !== `${match[1]}${version}${match[2]}`) {
    writeFileSync(PKG, pkgText.replace(versionFieldRe, `$1${version}$2`));
    git(["add", PKG]);
    git(["commit", "-m", `Release ${version}`]);
  }
  const releaseSha = git(["rev-parse", "HEAD"]);

  git(["push", REMOTE, BRANCH]);
  git(["tag", tag, releaseSha]);
  git(["push", REMOTE, tag]);
  git(["tag", "-f", major, releaseSha]);
  git(["push", REMOTE, `+refs/tags/${major}`]);
}

// Pull the new tags back into the local checkout so verification commands like
// `git show vX.Y.Z:package.json` and `git merge-base` work immediately.
git(["fetch", REMOTE, "--tags", "--force"]);
console.log(`\nNow write the release notes:\n  gh release create ${tag} --repo ${REPO} --title "${tag}" --notes "..."`);
