#!/usr/bin/env node
// vibecodereview CLI — set up council PR review in a repo, or review your local diff.
//
//   vibecodereview init [--dir .]       Write .github/workflows/vibecodereview.yml into a repo.
//   vibecodereview review [--base <ref>] Review your local diff with the council (prints findings).
//   vibecodereview review-prs [--post] [--repo <o/r>]... [<o/r>...]
//                                       Review every open PR across repos; --post comments findings.
//   vibecodereview doctor               Show which provider keys are set in the environment.
//   vibecodereview secrets [--repo o/r] Print the gh commands to set the required repo secrets.
//
// Provider keys (env or repo secrets): CLAUDE_CODE_OAUTH_TOKEN (chair, required for CI),
//   OPENAI_API_KEY, GEMINI_API_KEY, MOONSHOT_API_KEY, OPENROUTER_API_KEY (council members).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROVIDER_KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "MOONSHOT_API_KEY", "OPENROUTER_API_KEY"];
const REF = "pooriaarab/vibecodereview@v1"; // action ref repos pin to

const WORKFLOW = `name: vibecodereview
on:
  pull_request:
    types: [opened, synchronize, review_requested]
    paths-ignore: ["**.md", "docs/**"]
concurrency:
  group: vibecodereview-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  vibecodereview:
    # Only review PRs opened by the repo owner. On public repos this stops
    # arbitrary external PRs from spending your model budget (and blunts diff
    # prompt-injection from untrusted authors). Widen the allowlist if needed.
    if: github.event.pull_request.user.login == github.repository_owner
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions: { contents: write, pull-requests: write, id-token: write }
    steps:
      - uses: ${REF}
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_code_oauth_token_2: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_2 }}
          claude_code_oauth_token_3: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_3 }}
          github_token: \${{ github.token }}
          openai_api_key: \${{ secrets.OPENAI_API_KEY }}
          gemini_api_key: \${{ secrets.GEMINI_API_KEY }}
          moonshot_api_key: \${{ secrets.MOONSHOT_API_KEY }}
          openrouter_api_key: \${{ secrets.OPENROUTER_API_KEY }}
`;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function init() {
  const dir = path.resolve(arg("dir", "."));
  const dest = path.join(dir, ".github", "workflows", "vibecodereview.yml");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, WORKFLOW);
  console.log(`Wrote ${dest}`);
  console.log("\nNext: set repo secrets (see `vibecodereview secrets`), commit, open a PR.");
}

function secrets() {
  const repo = arg("repo", "<owner>/<repo>");
  console.log(`# Set on a PRIVATE repo only. Rotate any key you paste in a chat.`);
  console.log(`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}   # required — chair model`);
  for (const k of PROVIDER_KEYS) console.log(`gh secret set ${k} --repo ${repo}`);
}

function doctor() {
  console.log("Chair:");
  console.log(`  CLAUDE_CODE_OAUTH_TOKEN  ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "MISSING (required for CI)"}`);
  console.log("Council members:");
  for (const k of PROVIDER_KEYS) console.log(`  ${k.padEnd(22)} ${process.env[k] ? "set" : "not set (member dropped)"}`);
}

function review() {
  const base = arg("base", "");
  const diff = base ? sh("git", ["diff", `${base}...HEAD`]) : sh("git", ["diff", "HEAD"]);
  if (!diff.trim()) {
    console.log("No diff to review (try --base origin/main).");
    return;
  }
  const tmp = path.join(os.tmpdir(), `vibecodereview-${process.pid}.diff`);
  const out = path.join(os.tmpdir(), `vibecodereview-${process.pid}.md`);
  fs.writeFileSync(tmp, diff);
  sh("node", [path.join(ROOT, "scripts", "council-review.mjs"), tmp, out], { stdio: ["ignore", "inherit", "inherit"] });
  console.log("\n" + fs.readFileSync(out, "utf8"));
}

function reviewPrs() {
  const post = process.argv.includes("--post");
  const repos = [];
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo" && argv[i + 1]) repos.push(argv[++i]);
    else if (!argv[i].startsWith("--")) repos.push(argv[i]);
  }
  if (repos.length === 0) {
    console.log("Usage: vibecodereview review-prs [--post] [--repo <owner/repo>]... [<owner/repo>...]");
    return;
  }
  let reviewed = 0,
    errors = 0,
    seq = 0;
  for (const repo of repos) {
    let prs;
    try {
      prs = JSON.parse(sh("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number"]));
    } catch (err) {
      errors++;
      console.error(`${repo}: failed to list PRs: ${err?.message || err}`);
      continue;
    }
    for (const { number } of prs) {
      try {
        const diff = sh("gh", ["pr", "diff", String(number), "--repo", repo]);
        const tmp = path.join(os.tmpdir(), `vibecodereview-${process.pid}-${seq}.diff`);
        const out = path.join(os.tmpdir(), `vibecodereview-${process.pid}-${seq}.md`);
        seq++;
        fs.writeFileSync(tmp, diff);
        sh("node", [path.join(ROOT, "scripts", "council-review.mjs"), tmp, out], { stdio: ["ignore", "inherit", "inherit"] });
        console.log(`\n=== ${repo}#${number} ===\n`);
        console.log(fs.readFileSync(out, "utf8"));
        if (post) sh("gh", ["pr", "comment", String(number), "--repo", repo, "--body-file", out]);
        reviewed++;
      } catch (err) {
        errors++;
        console.error(`${repo}#${number}: ${err?.message || err}`);
      }
    }
  }
  console.log(`\nDone: ${repos.length} repo(s), ${reviewed} PR(s) reviewed, ${errors} error(s).`);
}

const cmd = process.argv[2];
try {
  if (cmd === "init") init();
  else if (cmd === "secrets") secrets();
  else if (cmd === "doctor") doctor();
  else if (cmd === "review") review();
  else if (cmd === "review-prs") reviewPrs();
  else {
    console.log("vibecodereview <init|review|review-prs|doctor|secrets>  (see `vibecodereview` header comment)");
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error("vibecodereview error:", err?.message || err);
  process.exit(1);
}
