#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/$/, "");
const releaseScript = join(root, "..", "bin", "release.mjs");
const workflowPath = join(root, "..", ".github", "workflows", "npm-publish.yml");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runRelease(cwd, args) {
  const res = spawnSync(process.execPath, [releaseScript, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function packageVersion(cwd, ref = "HEAD") {
  return JSON.parse(git(cwd, ["show", `${ref}:package.json`])).version;
}

function refSha(cwd, ref) {
  return git(cwd, ["rev-parse", ref]);
}

const tmp = mkdtempSync(join(tmpdir(), "release-test-"));
const bare = join(tmp, "origin.git");
const clone = join(tmp, "clone");

mkdirSync(bare, { recursive: true });
mkdirSync(clone, { recursive: true });

try {
  git(bare, ["init", "--bare"]);

  git(clone, ["init", "-b", "main"]);
  git(clone, ["remote", "add", "origin", bare]);
  git(clone, ["config", "user.email", "release-test@example.com"]);
  git(clone, ["config", "user.name", "Release Test"]);

  const initialPkg = JSON.stringify(
    {
      name: "vibecodereview",
      version: "0.1.1",
      publishConfig: { access: "public" },
    },
    null,
    2,
  );
  writeFileSync(join(clone, "package.json"), initialPkg + "\n");

  git(clone, ["add", "package.json"]);
  git(clone, ["commit", "-m", "init"]);
  git(clone, ["push", "-u", "origin", "main"]);

  const initialSha = refSha(clone, "origin/main");

  // Criterion 3: dry run prints the plan and writes nothing.
  const dry = runRelease(clone, ["1.3.3"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes("package.json  0.1.1 (npm workflow will set to 1.3.3)"), dry.stdout);
  assert.ok(dry.stdout.includes("create    v1.3.3"), dry.stdout);
  assert.ok(dry.stdout.includes("v1 ->"), dry.stdout);
  assert.equal(git(clone, ["status", "--short"]), "");

  // Criterion 1: --apply creates the immutable and major tags at the remote
  // main commit. Git is the source of truth for the manifest: package.json is
  // not committed, so the tag's tree still carries the original version. npm
  // gets the correct version at publish time from .github/workflows/npm-publish.yml.
  const first = runRelease(clone, ["1.3.3", "--apply"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(refSha(clone, "v1.3.3"), initialSha, "v1.3.3 did not point at main");
  assert.equal(refSha(clone, "v1"), initialSha, "v1 did not point at main");
  assert.equal(refSha(clone, "HEAD"), initialSha, "HEAD moved");
  assert.equal(packageVersion(clone, "v1.3.3"), "0.1.1", "tag manifest was modified");
  assert.equal(packageVersion(clone, "HEAD"), "0.1.1", "working tree was modified");

  const commitCountBefore = Number(git(clone, ["rev-list", "--count", "HEAD"]));

  // Criterion 5: re-running the same version is refused (no new commit, the
  // immutable tag is not re-pointed, the major tag stays on the same sha).
  const afterFirst = runRelease(clone, ["1.3.3", "--apply"]);
  assert.equal(afterFirst.status, 0, afterFirst.stderr);
  assert.ok(afterFirst.stdout.includes("v1.3.3 already exists at this sha, skipping"), afterFirst.stdout);
  const commitCountAfter = Number(git(clone, ["rev-list", "--count", "HEAD"]));
  assert.equal(commitCountBefore, commitCountAfter, "re-run created a new commit");
  assert.equal(refSha(clone, "v1.3.3"), initialSha, "immutable tag moved");
  assert.equal(refSha(clone, "v1"), initialSha, "major tag moved");
  assert.equal(packageVersion(clone, "v1.3.3"), "0.1.1");

  // Older versions are still refused by the ordering guard.
  const older = runRelease(clone, ["1.3.2", "--apply"]);
  assert.notEqual(older.status, 0, older.stderr);
  assert.ok(older.stderr.includes("not newer"), older.stderr);
  assert.equal(git(clone, ["tag", "-l", "v1.3.2"]), "");

  // Criterion 2: running from a different branch with a dirty working tree
  // refuses before any branch movement and leaves HEAD where it was.
  git(clone, ["checkout", "-b", "other-branch"]);
  writeFileSync(join(clone, "dirty.txt"), "dirty");
  const dirty = runRelease(clone, ["1.3.4", "--apply"]);
  assert.notEqual(dirty.status, 0, dirty.stderr);
  assert.ok(dirty.stderr.includes("uncommitted changes"), dirty.stderr);
  assert.equal(git(clone, ["branch", "--show-current"]), "other-branch", "HEAD moved");
  assert.ok(git(clone, ["status", "--short"]).includes("?? dirty.txt"), "working tree was cleaned");
  assert.equal(git(clone, ["tag", "-l", "v1.3.4"]), "", "tag was created from a dirty checkout");
  assert.equal(Number(git(clone, ["rev-list", "--count", "HEAD"])), commitCountBefore, "dirty run created a commit");

  // Criterion 4: the publish workflow writes the version from the tag before
  // npm publish, so the published artifact matches the git tag even though the
  // committed package.json does not change.
  assert.ok(existsSync(workflowPath), "npm-publish.yml missing");
  const workflow = readFileSync(workflowPath, "utf8");
  assert.ok(workflow.includes("Set package version from tag"), workflow);
  assert.ok(/github\.ref_name|GITHUB_REF_NAME/.test(workflow), workflow);
  assert.ok(workflow.includes("package.json"), workflow);
  assert.match(workflow, /npm publish/);

  console.log("release tests passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
