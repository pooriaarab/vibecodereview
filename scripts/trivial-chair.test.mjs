#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyDiff,
  classifyFile,
  reviewArgs,
  reviewBody,
  verdictsJson,
} from "./trivial-chair.mjs";
import { parseChairVerdictsJson } from "./chair-verdicts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "trivial-chair.mjs");

function diffFor(file) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n+change\n`;
}

assert.equal(classifyDiff(diffFor("README.md")), true);
assert.equal(classifyDiff(diffFor("src/app.ts")), false);
assert.equal(classifyDiff(""), false);
assert.equal(classifyFile(path.join(here, "no-such-diff.patch")), false);

const body = reviewBody({ reason: "docs only", paths: ["README.md"] }, "abc123");
assert.match(body, /Council: skipped/);
assert.match(body, /README\.md/);
assert.match(body, /Reviewed head: `abc123`/);
assert.doesNotMatch(body, /check-runs/);

const parsed = parseChairVerdictsJson(verdictsJson());
assert.equal(parsed.ok, true);
assert.equal(parsed.verdict, "comment");
assert.deepEqual(parsed.dispositions, []);

const args = reviewArgs(12, "owner/repo", "trivial-review.md");
assert.deepEqual(args.slice(0, 3), ["pr", "review", "12"]);
assert.ok(args.includes("--comment"));
assert.ok(!args.includes("--approve"));

function classifyCli(file, extra = {}) {
  return spawnSync(process.execPath, [script, "--classify", file], {
    encoding: "utf8",
    ...extra,
  });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-trivial-"));
const docs = path.join(work, "docs.diff");
const src = path.join(work, "src.diff");
fs.writeFileSync(docs, diffFor("docs/guide.md"));
fs.writeFileSync(src, diffFor("scripts/app.mjs"));
assert.equal(classifyCli(docs).stdout, "true");
assert.equal(classifyCli(src).stdout, "false");
assert.equal(classifyCli(path.join(work, "missing.diff")).stdout, "false");
assert.equal(classifyCli(docs).status, 0);

const bin = path.join(work, "bin");
fs.mkdirSync(bin);
const log = path.join(work, "gh.log");
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!/usr/bin/env bash
printf '%s\\n' "$*" > "${log}"
`,
  { mode: 0o755 },
);

function post(env, ghDir = bin) {
  return spawnSync(process.execPath, [script], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, ...env },
  });
}

const verdicts = path.join(work, "chair-verdicts.json");
fs.writeFileSync(path.join(work, "pr-delta.diff"), diffFor("README.md"));
const posted = post({
  GITHUB_REPOSITORY: "owner/repo",
  PR_NUMBER: "9",
  VCR_CHAIR_VERDICTS: verdicts,
  VCR_REVIEW_HEAD_SHA: "deadbeef",
});
assert.equal(posted.status, 0, posted.stderr);
const ghLine = fs.readFileSync(log, "utf8").trim();
assert.match(ghLine, /^pr review 9 --repo owner\/repo --comment --body-file trivial-review\.md$/);
assert.equal(fs.existsSync(verdicts), true);
assert.equal(parseChairVerdictsJson(fs.readFileSync(verdicts, "utf8")).verdict, "comment");
const postedBody = fs.readFileSync(path.join(work, "trivial-review.md"), "utf8");
assert.match(postedBody, /Council: skipped/);
assert.match(postedBody, /deadbeef/);

fs.rmSync(verdicts, { force: true });
const failBin = path.join(work, "fail-bin");
fs.mkdirSync(failBin);
fs.writeFileSync(path.join(failBin, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
const failed = post(
  { GITHUB_REPOSITORY: "owner/repo", PR_NUMBER: "9", VCR_CHAIR_VERDICTS: verdicts },
  failBin,
);
assert.notEqual(failed.status, 0);
assert.equal(fs.existsSync(verdicts), false, "a failed post must not write a verdict");

const srcText = fs.readFileSync(script, "utf8");
assert.doesNotMatch(srcText, /check-runs/);
assert.doesNotMatch(srcText, /checks\.create/);

fs.rmSync(work, { recursive: true, force: true });
console.log("trivial chair tests passed");
