#!/usr/bin/env node
// Cut a release: create an immutable vX.Y.Z tag and force-move the vX pointer.
// Does not commit package.json. The npm manifest version is written at publish
// time by .github/workflows/npm-publish.yml, derived from the tag that triggers
// the run. Git stays the source of truth; npm is a downstream artifact.
//
// Two tags, not one. The immutable tag is what makes "which version are we on"
// and "put it back" answerable; the moving major tag is what the ~80 consuming
// repos follow to get fixes without editing 80 workflows. Skipping the
// immutable one leaves no rollback target except a SHA dug out of `git log`,
// which is where this repo was until v1.0.0 was cut retroactively.
//
// Usage:
//   node bin/release.mjs 1.2.0            # dry run, prints the plan
//   node bin/release.mjs 1.2.0 --apply    # create v1.2.0, move v1 to it
import { execFileSync } from "node:child_process";

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

// Never run while the working tree is dirty. The script does not move the
// caller's HEAD, but it still should not run from an ambiguous checkout.
if (git(["status", "--short"])) {
  console.error("error: the working tree has uncommitted changes");
  process.exit(1);
}

// Resolve everything against the remote tracking ref. The transport moved from
// `gh api` to local `git` so this works offline and from a throwaway clone.
git(["fetch", REMOTE, "--tags"]);

const mainSha = git(["rev-parse", `${REMOTE}/${BRANCH}`]);

const beforeVersion = (() => {
  try {
    const remotePkg = git(["show", `${REMOTE}/${BRANCH}:package.json`], { ok: true });
    return remotePkg ? JSON.parse(remotePkg).version : null;
  } catch {
    return null;
  }
})();

// Resolve through to the commit (^{}) so an annotated tag compares against the
// commit sha, not the tag object sha.
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
if (beforeVersion === version) {
  console.log(`package.json  ${version} (already)`);
} else if (beforeVersion) {
  console.log(`package.json  ${beforeVersion} (npm workflow will set to ${version})`);
} else {
  console.log(`package.json  (npm workflow will set to ${version})`);
}
console.log(tagExists ? `exists    ${tag} -> ${mainSha.slice(0, 7)} (resuming)` : `create    ${tag} -> ${mainSha.slice(0, 7)}`);
console.log(`${majorExists ? "move     " : "create   "} ${major} -> ${mainSha.slice(0, 7)}`);

if (!apply) {
  console.log("\ndry run. Nothing was written. Re-run with --apply.");
  process.exit(0);
}

if (tagExists) {
  console.log(`${tag} already exists at this sha, skipping`);
  // A prior run may have created the local tag but failed to push it. Make sure
  // the remote has it before we update the major pointer.
  git(["push", REMOTE, tag]);
  git(["tag", "-f", major, mainSha]);
  git(["push", REMOTE, `+refs/tags/${major}`]);
} else {
  git(["tag", tag, mainSha]);
  git(["push", REMOTE, tag]);
  git(["tag", "-f", major, mainSha]);
  git(["push", REMOTE, `+refs/tags/${major}`]);
}

// Pull the new tags back into the local checkout so verification commands like
// `git show vX.Y.Z:package.json` and `git merge-base` work immediately.
git(["fetch", REMOTE, "--tags"]);
console.log(`\nNow write the release notes:\n  gh release create ${tag} --repo ${REPO} --title "${tag}" --notes "..."`);
