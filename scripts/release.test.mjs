#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const releaseScript = join(root, "bin/release.mjs");

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

const tmp = mkdtempSync(join(tmpdir(), "release-test-"));
const bare = join(tmp, "origin.git");
const clone = join(tmp, "clone");

mkdirSync(bare, { recursive: true });
mkdirSync(clone, { recursive: true });

try {
  git(bare, ["init", "--bare"]);

  git(clone, ["init"]);
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

  // Criterion 3: dry run prints the package.json edit and writes nothing.
  const dry = runRelease(clone, ["1.3.3"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes("package.json  0.1.1 -> 1.3.3"), dry.stdout);
  assert.ok(dry.stdout.includes("create    v1.3.3"), dry.stdout);
  assert.ok(dry.stdout.includes("v1 ->"), dry.stdout);
  assert.equal(git(clone, ["status", "--short"]), "");

  // Criterion 1: --apply updates package.json to the requested version.
  const first = runRelease(clone, ["1.3.3", "--apply"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(packageVersion(clone, "HEAD"), "1.3.3");

  // Criterion 2: the version commit is an ancestor of the immutable tag.
  git(clone, ["fetch", "origin", "--tags"]);
  assert.equal(packageVersion(clone, "v1.3.3"), "1.3.3");
  const versionCommit = git(clone, ["rev-list", "-1", "v1.3.3", "--", "package.json"]);
  git(clone, ["merge-base", "--is-ancestor", versionCommit, "v1.3.3"]);
  assert.equal(git(clone, ["tag", "-l", "v1.3.3"]), "v1.3.3");
  assert.equal(git(clone, ["tag", "-l", "v1"]), "v1");

  const commitCountBefore = Number(git(clone, ["rev-list", "--count", "HEAD"]));

  // Criterion 5: re-running the same version is refused (no new commit, no moved tag).
  const afterFirst = runRelease(clone, ["1.3.3", "--apply"]);
  assert.equal(afterFirst.status, 0, afterFirst.stderr);
  assert.ok(afterFirst.stdout.includes("v1.3.3 already exists at this sha, skipping"), afterFirst.stdout);
  const commitCountAfter = Number(git(clone, ["rev-list", "--count", "HEAD"]));
  assert.equal(commitCountBefore, commitCountAfter, "re-run created a new commit");
  assert.equal(packageVersion(clone, "v1.3.3"), "1.3.3");
  assert.equal(packageVersion(clone, "v1"), "1.3.3");

  // Older versions are still refused by the ordering guard.
  const older = runRelease(clone, ["1.3.2", "--apply"]);
  assert.notEqual(older.status, 0, older.stderr);
  assert.ok(older.stderr.includes("not newer"), older.stderr);
  assert.equal(git(clone, ["tag", "-l", "v1.3.2"]), "");

  console.log("release tests passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
