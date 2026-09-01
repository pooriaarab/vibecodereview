#!/usr/bin/env node
/**
 * rollout.mjs — roll out the vibecodereview council PR review to many repos.
 *
 * For each repo (owned by pooriaarab), in order:
 *   1. Set the GitHub Actions secrets vibecodereview needs, from this process env.
 *   2. Skip the PR if `.github/workflows/vibecodereview.yml` already exists on the
 *      default branch.
 *   3. Otherwise open a PR that adds the workflow (branch `add-vibecodereview`).
 *      PRs are never merged here — a human reviews them.
 *
 * Usage:
 *   node rollout.mjs [--dry-run] <owner/repo> [<owner/repo> ...]
 *
 *   Repos may also come from the REPOS env var (comma-separated).
 *   argv repos win when both are given.
 *
 *   --dry-run prints what WOULD run and changes nothing.
 *
 * Secrets read from the environment (empty ones are skipped, with a log line):
 *   CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY
 *   MOONSHOT_API_KEY OPENROUTER_API_KEY
 *
 * Requires Node >= 20 and an authenticated `gh` CLI. Zero dependencies.
 * Idempotent: re-running re-sets secrets, reuses the branch and PR, and skips
 * repos whose default branch already has the workflow.
 */

import { execFileSync } from "node:child_process";

const SECRET_NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  // The failover tokens. Leaving these out of the roster meant a rollout
  // wrote a workflow that could only ever use ONE subscription, so the whole
  // fleet went down together the moment that one capped out.
  "CLAUDE_CODE_OAUTH_TOKEN_2",
  "CLAUDE_CODE_OAUTH_TOKEN_3",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENROUTER_API_KEY",
];

const WORKFLOW_PATH = ".github/workflows/vibecodereview.yml";
const BRANCH = "add-vibecodereview";
const COMMIT_MESSAGE = "Add vibecodereview council PR review";
const PR_TITLE = "Add vibecodereview council PR review";
const PR_BODY =
  "Adds owner-gated LLM-council PR review (pooriaarab/vibecodereview@v1). " +
  "Set secrets are handled separately. Review before merge.";

// The `${{ ... }}` sequences are literal GitHub Actions syntax. They sit in
// plain JS strings, so JS never evaluates them. Do not convert to a template
// literal.
const WORKFLOW_YAML =
  [
    "name: vibecodereview",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, review_requested]",
    '    paths-ignore: ["**.md", "docs/**"]',
    "concurrency:",
    "  group: vibecodereview-${{ github.event.pull_request.number }}",
    "  cancel-in-progress: true",
    "jobs:",
    "  review:",
    "    # Only review the repo owner's own PRs (cost + injection guard on public repos).",
    "    if: github.event.pull_request.user.login == github.repository_owner",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "      id-token: write",
    "    steps:",
    "      - uses: pooriaarab/vibecodereview@v1",
    "        with:",
    "          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    "          claude_code_oauth_token_2: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_2 }}",
    "          claude_code_oauth_token_3: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN_3 }}",
    "          github_token: ${{ github.token }}",
    "          openai_api_key: ${{ secrets.OPENAI_API_KEY }}",
    "          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}",
    "          moonshot_api_key: ${{ secrets.MOONSHOT_API_KEY }}",
    "          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}",
  ].join("\n") + "\n";

function stderrOf(err) {
  return String(err.stderr || "").trim() || String(err.code || "unknown error");
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function tryGh(args) {
  try {
    return { ok: true, stdout: gh(args) };
  } catch (err) {
    return { ok: false, stderr: stderrOf(err) };
  }
}

function setSecrets(repo, log, dryRun) {
  // 1. Secrets. Empty env values are skipped with a log line.
  for (const name of SECRET_NAMES) {
    const value = process.env[name];
    if (!value) {
      log(`secret ${name} is empty in env, skipping`);
      continue;
    }
    if (dryRun) {
      log(`[dry-run] would run: gh secret set ${name} --repo ${repo} --body ***`);
      continue;
    }
    // The value goes as its own argv element, never through a shell string.
    // Do not rethrow the raw error: execFileSync error messages quote the
    // full command line, which would leak the secret.
    try {
      gh(["secret", "set", name, "--repo", repo, "--body", value]);
    } catch (err) {
      throw new Error(`gh secret set ${name} failed: ${stderrOf(err)}`);
    }
    log(`secret ${name} set`);
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    log("WARNING: CLAUDE_CODE_OAUTH_TOKEN is empty; the chair reviewer will fail without it");
  }
}

function workflowExists(repo, log, dryRun) {
  // 2. Workflow already on the default branch?
  if (dryRun) {
    log(`[dry-run] would run: gh api repos/${repo}/contents/${WORKFLOW_PATH}`);
    return false;
  }
  const check = tryGh(["api", `repos/${repo}/contents/${WORKFLOW_PATH}`]);
  if (check.ok) {
    log("workflow exists, skipping PR");
    return true;
  }
  return false;
}

function resolveHead(repo, log, dryRun) {
  // 3a. Default branch.
  let defaultBranch;
  if (dryRun) {
    log(
      `[dry-run] would run: gh repo view ${repo} --json defaultBranchRef --jq .defaultBranchRef.name`,
    );
    defaultBranch = "<default>";
  } else {
    defaultBranch = gh([
      "repo",
      "view",
      repo,
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]).trim();
    log(`default branch: ${defaultBranch}`);
  }

  // 3b. Head sha of the default branch.
  let sha;
  if (dryRun) {
    log(`[dry-run] would run: gh api repos/${repo}/git/ref/heads/<default> --jq .object.sha`);
    sha = "<sha>";
  } else {
    sha = gh(["api", `repos/${repo}/git/ref/heads/${defaultBranch}`, "--jq", ".object.sha"]).trim();
  }
  return { defaultBranch, sha };
}

function ensureBranch(repo, log, dryRun, sha) {
  // 3c. Create the scratch branch (reuse it if it already exists).
  if (dryRun) {
    log(
      `[dry-run] would run: gh api --method POST repos/${repo}/git/refs -f ref=refs/heads/${BRANCH} -f sha=<sha>`,
    );
  } else {
    const res = tryGh([
      "api",
      "--method",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${BRANCH}`,
      "-f",
      `sha=${sha}`,
    ]);
    if (res.ok) {
      log(`branch ${BRANCH} created`);
    } else if (/already exists|422/.test(res.stderr)) {
      log(`branch ${BRANCH} already exists, reusing it`);
    } else {
      throw new Error(`failed to create branch ${BRANCH}: ${res.stderr}`);
    }
  }
}

function writeWorkflowFile(repo, log, dryRun) {
  // 3d. Write the workflow file on the scratch branch.
  const contentB64 = Buffer.from(WORKFLOW_YAML).toString("base64");
  if (dryRun) {
    log(
      `[dry-run] would run: gh api --method PUT repos/${repo}/contents/${WORKFLOW_PATH} -f message="${COMMIT_MESSAGE}" -f branch=${BRANCH} -f content=<BASE64>`,
    );
  } else {
    const putArgs = [
      "api",
      "--method",
      "PUT",
      `repos/${repo}/contents/${WORKFLOW_PATH}`,
      "-f",
      `message=${COMMIT_MESSAGE}`,
      "-f",
      `branch=${BRANCH}`,
      "-f",
      `content=${contentB64}`,
    ];
    // Re-runs: if the file already exists on the scratch branch, the Contents
    // API needs its current sha to update it.
    const existing = tryGh([
      "api",
      `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${BRANCH}`,
      "--jq",
      ".sha",
    ]);
    if (existing.ok) putArgs.push("-f", `sha=${existing.stdout.trim()}`);
    gh(putArgs);
    log(`workflow file written to branch ${BRANCH}`);
  }
}

function openPr(repo, log, dryRun, defaultBranch) {
  // 3e. Open the PR.
  if (dryRun) {
    log(
      `[dry-run] would run: gh pr create --repo ${repo} --base <default> --head ${BRANCH} --title "${PR_TITLE}" --body "${PR_BODY}"`,
    );
    return "dry-run";
  }
  const pr = tryGh([
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    defaultBranch,
    "--head",
    BRANCH,
    "--title",
    PR_TITLE,
    "--body",
    PR_BODY,
  ]);
  if (pr.ok) {
    log(`PR opened: ${pr.stdout.trim()}`);
    return "PR opened";
  }
  if (/already exists/i.test(pr.stderr)) {
    log("PR already exists, nothing to do");
    return "PR already exists";
  }
  throw new Error(`gh pr create failed: ${pr.stderr}`);
}

function processRepo(repo, log, dryRun) {
  setSecrets(repo, log, dryRun);
  if (workflowExists(repo, log, dryRun)) {
    return "skipped (workflow exists)";
  }
  const { defaultBranch, sha } = resolveHead(repo, log, dryRun);
  ensureBranch(repo, log, dryRun, sha);
  writeWorkflowFile(repo, log, dryRun);
  return openPr(repo, log, dryRun, defaultBranch);
}

function collectRepos(argv) {
  const dryRun = argv.includes("--dry-run");
  const argvRepos = argv.filter((a) => a !== "--dry-run");

  const unknownFlags = argvRepos.filter((a) => a.startsWith("-"));
  if (unknownFlags.length) {
    console.error(`error: unknown flag(s): ${unknownFlags.join(", ")}`);
    process.exit(1);
  }

  const envRepos = (process.env.REPOS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // argv repos win when both sources are given.
  const repos = [...new Set(argvRepos.length ? argvRepos : envRepos)];

  if (!repos.length) {
    console.error("usage: node rollout.mjs [--dry-run] <owner/repo> [<owner/repo> ...]");
    console.error("       or:   REPOS=owner/repo,owner/repo2 node rollout.mjs [--dry-run]");
    process.exit(1);
  }
  for (const repo of repos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      console.error(`error: invalid repo "${repo}" (expected owner/repo)`);
      process.exit(1);
    }
  }

  if (!dryRun) {
    const ghOk = tryGh(["--version"]);
    if (!ghOk.ok) {
      console.error(
        "error: `gh` CLI not found or not working. Install it and run `gh auth login` first.",
      );
      process.exit(1);
    }
  }

  return repos;
}

function runAll(repos, dryRun) {
  const summary = [];
  for (const repo of repos) {
    const log = (msg) => console.log(`[${repo}] ${msg}`);
    let status;
    try {
      status = processRepo(repo, log, dryRun);
    } catch (err) {
      status = `failed: ${err.message}`;
      log(`ERROR: ${err.message}`);
    }
    summary.push({ repo, status });
    console.log("");
  }
  return summary;
}

function printSummary(summary) {
  console.log("Summary:");
  for (const { repo, status } of summary) {
    console.log(`  ${repo}: ${status}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const repos = collectRepos(argv);
  if (dryRun) console.log("[dry-run] no changes will be made\n");
  const summary = runAll(repos, dryRun);
  printSummary(summary);
}

main();
