#!/usr/bin/env node
// Cut a release: an immutable vX.Y.Z tag, then move the vX pointer to it.
//
// Two tags, not one. The immutable tag is what makes "which version are we on"
// and "put it back" answerable; the moving major tag is what the 80 consuming
// repos follow to get fixes without editing 80 workflows. Skipping the
// immutable one leaves no rollback target except a SHA dug out of git log,
// which is where this repo was until v1.0.0 was cut retroactively.
//
// Usage:
//   node bin/release.mjs 1.2.0            # dry run, prints the plan
//   node bin/release.mjs 1.2.0 --apply
import { execFileSync } from "node:child_process";

const REPO = "pooriaarab/vibecodereview";
const version = process.argv[2];
const apply = process.argv.includes("--apply");

if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: release.mjs <major.minor.patch> [--apply]");
  process.exit(2);
}
const major = `v${version.split(".")[0]}`;
const tag = `v${version}`;

const gh = (args, input) =>
  execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] }).trim();

// Like `gh`, but captures stderr instead of inheriting it, so a 404 (ref
// missing) can be told apart from an auth/network/rate-limit/5xx failure.
// Returns the ref's sha, or null if the ref does not exist.
const refSha = (ref) => {
  try {
    const out = execFileSync("gh", ["api", `repos/${REPO}/git/refs/${ref}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out).object.sha;
  } catch (e) {
    if (typeof e.stderr === "string" && /HTTP 404/.test(e.stderr)) return null;
    console.error(e.stderr || e.message);
    process.exit(1);
  }
};

const sha = JSON.parse(gh(["api", `repos/${REPO}/git/refs/heads/main`])).object.sha;

// An immutable tag that already points at this same main sha means a
// previous --apply created it but failed before (or during) the vX step —
// resume from there instead of refusing. Only a tag pointing somewhere else
// is the immutability violation this guards against.
const existingTagSha = refSha(`tags/${tag}`);
if (existingTagSha && existingTagSha !== sha) {
  console.error(
    `${tag} already exists at ${existingTagSha.slice(0, 7)}, not main (${sha.slice(0, 7)}). ` +
      `Immutable tags are never moved. Pick the next version.`,
  );
  process.exit(1);
}
const tagExists = existingTagSha !== null;

// A brand-new major (e.g. the first 2.0.0) has no vX ref to move yet, so it
// must be created (POST) rather than moved (PATCH), or the release half-completes:
// vX.Y.Z gets tagged and the major pointer is never created.
const majorExists = refSha(`tags/${major}`) !== null;

// vX is documented as always pointing at the newest vX.Y.Z of that major line.
// Releasing an older/out-of-order version (a typo, or an old branch cut by
// mistake) would force-move vX backward — a regression shipped to every
// consuming repo pinned to @vX. Refuse unless this version is the highest
// vX.*.* tag that exists.
if (!tagExists) {
  const majorNum = major.slice(1);
  const siblingRefs = JSON.parse(gh(["api", `repos/${REPO}/git/matching-refs/tags/${major}.`]) || "[]");
  const verRe = new RegExp(`^v${majorNum}\\.(\\d+)\\.(\\d+)$`);
  const existingVersions = siblingRefs
    .map((r) => r.ref.split("/").pop().match(verRe))
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
}

console.log(`main      ${sha}`);
console.log(tagExists ? `exists    ${tag} -> ${sha.slice(0, 7)} (resuming)` : `create    ${tag} -> ${sha.slice(0, 7)}`);
console.log(`${majorExists ? "move     " : "create   "} ${major} -> ${sha.slice(0, 7)}`);
if (!apply) {
  console.log("\ndry run. Nothing was written. Re-run with --apply.");
  process.exit(0);
}

if (tagExists) {
  console.log(`${tag} already exists at this sha, skipping`);
} else {
  gh(["api", `repos/${REPO}/git/refs`, "-X", "POST", "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`]);
  console.log(`created ${tag}`);
}
// The major pointer is the only tag this force-updates, and it is the one
// consumers opted into by writing @v1 rather than a pinned version.
if (majorExists) {
  gh(["api", `repos/${REPO}/git/refs/tags/${major}`, "-X", "PATCH", "-f", `sha=${sha}`, "-F", "force=true"]);
  console.log(`moved ${major} -> ${tag}`);
} else {
  gh(["api", `repos/${REPO}/git/refs`, "-X", "POST", "-f", `ref=refs/tags/${major}`, "-f", `sha=${sha}`]);
  console.log(`created ${major} -> ${tag}`);
}
console.log(`\nNow write the release notes:\n  gh release create ${tag} --repo ${REPO} --title "${tag}" --notes "..."`);
