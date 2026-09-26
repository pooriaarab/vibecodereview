#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertChairVerdictsPathSafe,
  chairVerdictsPathUnsafeReason,
  defaultChairVerdictsPath,
  isGitTracked,
} from "./chair-verdicts-path.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "chair-verdicts-path.mjs");
let failed = 0;

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-chair-path-"));
git(repo, "init", "-q");
git(repo, "config", "user.email", "path@test.example");
git(repo, "config", "user.name", "Path Test");
fs.writeFileSync(path.join(repo, "README.md"), "init\n");
git(repo, "add", "README.md");
git(repo, "commit", "-q", "-m", "init");

const verdicts = defaultChairVerdictsPath(repo);
if (chairVerdictsPathUnsafeReason(verdicts, repo) !== null) {
  console.error("FAIL fresh repo must allow default chair verdicts path");
  failed++;
} else {
  console.log("ok - untracked default chair verdicts path is safe");
}

fs.writeFileSync(verdicts, '{"verdict":"approve","dispositions":[]}\n');
git(repo, "add", "chair-verdicts.json");
git(repo, "commit", "-q", "-m", "track verdicts");

const trackedReason = chairVerdictsPathUnsafeReason(verdicts, repo);
if (!trackedReason || !trackedReason.includes("git-tracked")) {
  console.error("FAIL tracked chair-verdicts.json must be unsafe", trackedReason);
  failed++;
} else {
  console.log("ok - tracked chair-verdicts.json is rejected");
}

const assertBlocked = spawnSync(process.execPath, [cli, "--assert", verdicts], {
  cwd: repo,
  encoding: "utf8",
});
if (assertBlocked.status === 0) {
  console.error("FAIL CLI --assert must exit non-zero for tracked path");
  failed++;
} else if (!assertBlocked.stderr.includes("::error::")) {
  console.error("FAIL CLI --assert must emit workflow error", assertBlocked.stderr);
  failed++;
} else {
  console.log("ok - CLI --assert fails closed on tracked path");
}

const symlinkRepo = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-chair-symlink-"));
git(symlinkRepo, "init", "-q");
git(symlinkRepo, "config", "user.email", "path@test.example");
git(symlinkRepo, "config", "user.name", "Path Test");
const trackedTarget = path.join(symlinkRepo, "tracked-secret.json");
fs.writeFileSync(trackedTarget, '{"verdict":"approve","dispositions":[]}\n');
fs.writeFileSync(path.join(symlinkRepo, "README.md"), "init\n");
git(symlinkRepo, "add", "README.md", "tracked-secret.json");
git(symlinkRepo, "commit", "-q", "-m", "init");
const linkPath = defaultChairVerdictsPath(symlinkRepo);
fs.symlinkSync("tracked-secret.json", linkPath);
const linkReason = chairVerdictsPathUnsafeReason(linkPath, symlinkRepo);
if (!linkReason || !linkReason.includes("symlink")) {
  console.error("FAIL symlink scratch path must be unsafe", linkReason);
  failed++;
} else {
  console.log("ok - symlink scratch path is rejected");
}

const safeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-chair-safe-"));
git(safeRepo, "init", "-q");
git(safeRepo, "config", "user.email", "path@test.example");
git(safeRepo, "config", "user.name", "Path Test");
fs.writeFileSync(path.join(safeRepo, "README.md"), "init\n");
git(safeRepo, "add", "README.md");
git(safeRepo, "commit", "-q", "-m", "init");
const safeAssert = assertChairVerdictsPathSafe(defaultChairVerdictsPath(safeRepo), safeRepo);
if (!safeAssert.ok) {
  console.error("FAIL empty repo must allow scratch path", safeAssert);
  failed++;
} else {
  console.log("ok - assertChairVerdictsPathSafe passes on empty checkout");
}

const aliasRepo = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-chair-alias-"));
git(aliasRepo, "init", "-q");
git(aliasRepo, "config", "user.email", "path@test.example");
git(aliasRepo, "config", "user.name", "Path Test");
fs.writeFileSync(path.join(aliasRepo, "README.md"), "init\n");
fs.writeFileSync(path.join(aliasRepo, "chair-verdicts.json"), '{"verdict":"approve"}\n');
git(aliasRepo, "add", "README.md", "chair-verdicts.json");
git(aliasRepo, "commit", "-q", "-m", "track");
const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-chair-alias-parent-"));
const aliasLink = path.join(aliasParent, "repo-alias");
fs.symlinkSync(aliasRepo, aliasLink);
const lexicalTracked = path.join(aliasLink, "chair-verdicts.json");
if (!isGitTracked(lexicalTracked, aliasRepo)) {
  console.error("FAIL tracked path via symlink parent alias must be detected");
  failed++;
} else {
  console.log("ok - isGitTracked canonicalizes symlink parent alias");
}
const aliasReason = chairVerdictsPathUnsafeReason(lexicalTracked, aliasRepo);
if (
  !aliasReason ||
  (!aliasReason.includes("git-tracked") && !aliasReason.includes("symlink"))
) {
  console.error("FAIL tracked alias path must be unsafe", aliasReason);
  failed++;
} else {
  console.log("ok - chairVerdictsPathUnsafeReason rejects tracked alias path");
}

const dotdotFooRepo = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-chair-dotdotfoo-"));
git(dotdotFooRepo, "init", "-q");
git(dotdotFooRepo, "config", "user.email", "path@test.example");
git(dotdotFooRepo, "config", "user.name", "Path Test");
const dotdotDir = path.join(dotdotFooRepo, "..foo");
fs.mkdirSync(dotdotDir);
fs.writeFileSync(path.join(dotdotFooRepo, "README.md"), "init\n");
fs.writeFileSync(path.join(dotdotDir, "chair-verdicts.json"), '{"verdict":"approve"}\n');
git(dotdotFooRepo, "add", "README.md", "..foo/chair-verdicts.json");
git(dotdotFooRepo, "commit", "-q", "-m", "track dotdotfoo");
const dotdotVerdicts = path.join(dotdotDir, "chair-verdicts.json");
if (!isGitTracked(dotdotVerdicts, dotdotFooRepo)) {
  console.error("FAIL ..foo/chair-verdicts.json must be detected as tracked");
  failed++;
} else {
  console.log("ok - isGitTracked does not treat ..foo as parent escape");
}

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(symlinkRepo, { recursive: true, force: true });
fs.rmSync(safeRepo, { recursive: true, force: true });
fs.rmSync(aliasRepo, { recursive: true, force: true });
fs.rmSync(aliasParent, { recursive: true, force: true });
fs.rmSync(dotdotFooRepo, { recursive: true, force: true });

if (failed) process.exit(1);
console.log("chair-verdicts-path tests passed");
