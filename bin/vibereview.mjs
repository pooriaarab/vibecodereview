#!/usr/bin/env node
// vibereview CLI — set up council PR review in a repo, or review your local diff.
//
//   vibereview init [--dir .]       Write .github/workflows/vibereview.yml into a repo.
//   vibereview review [--base <ref>] Review your local diff with the council (prints findings).
//   vibereview doctor               Show which provider keys are set in the environment.
//   vibereview secrets [--repo o/r] Print the gh commands to set the required repo secrets.
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
const REF = "pooriaarab/vibereview@v1"; // action ref repos pin to

const WORKFLOW = `name: vibereview
on:
  pull_request:
    types: [opened, synchronize, review_requested]
    paths-ignore: ["**.md", "docs/**"]
concurrency:
  group: vibereview-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
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
  const dest = path.join(dir, ".github", "workflows", "vibereview.yml");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, WORKFLOW);
  console.log(`Wrote ${dest}`);
  console.log("\nNext: set repo secrets (see `vibereview secrets`), commit, open a PR.");
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
  const tmp = path.join(os.tmpdir(), `vibereview-${process.pid}.diff`);
  const out = path.join(os.tmpdir(), `vibereview-${process.pid}.md`);
  fs.writeFileSync(tmp, diff);
  sh("node", [path.join(ROOT, "scripts", "council-review.mjs"), tmp, out], { stdio: ["ignore", "inherit", "inherit"] });
  console.log("\n" + fs.readFileSync(out, "utf8"));
}

const cmd = process.argv[2];
try {
  if (cmd === "init") init();
  else if (cmd === "secrets") secrets();
  else if (cmd === "doctor") doctor();
  else if (cmd === "review") review();
  else {
    console.log("vibereview <init|review|doctor|secrets>  (see `vibereview` header comment)");
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error("vibereview error:", err?.message || err);
  process.exit(1);
}
