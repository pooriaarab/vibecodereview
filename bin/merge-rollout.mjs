// Merge the add-vibecodereview rollout PRs.
//   node merge-rollout.mjs [--lenient] <owner/repo> ...   (or REPOS env, comma-separated)
//
// A rollout PR only adds one workflow file, so it can't break a repo's code CI.
// Default: merge when the vibecodereview check SUCCEEDED and no OTHER check is failing.
// --lenient: merge when the vibecodereview check SUCCEEDED, ignoring pre-existing
//            unrelated red CI on that repo (safe — the PR is additive-only).
// Never merges while the vibecodereview check is pending or failing.
import { execFileSync } from "node:child_process";

const gh = (a) => execFileSync("gh", a, { encoding: "utf8" }).trim();
const lenient = process.argv.includes("--lenient");
const repos = (
  process.argv.slice(2).filter((a) => a !== "--lenient").length
    ? process.argv.slice(2).filter((a) => a !== "--lenient")
    : (process.env.REPOS || "").split(",")
)
  .map((s) => s.trim())
  .filter(Boolean);

// The rolled-out workflow job is named `review` (older) or `vibecodereview`.
const isVibe = (c) => {
  const n = (c.name || c.workflowName || c.context || "").toLowerCase();
  return /vibecodereview/.test(n) || n === "review";
};
const state = (c) => (c.conclusion || c.status || "").toUpperCase();
const FAIL = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"];
const WAIT = ["PENDING", "QUEUED", "IN_PROGRESS", ""];

const out = { merged: [], pending: [], vibe_failed: [], other_red: [], nopr: [], error: [] };
for (const repo of repos) {
  try {
    const num = gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      "add-vibecodereview",
      "--state",
      "open",
      "--json",
      "number",
      "--jq",
      ".[0].number // empty",
    ]);
    if (!num) {
      out.nopr.push(repo);
      continue;
    }
    const checks =
      JSON.parse(gh(["pr", "view", num, "--repo", repo, "--json", "statusCheckRollup"]))
        .statusCheckRollup || [];
    const vibe = checks.filter(isVibe).map(state);
    const others = checks.filter((c) => !isVibe(c)).map(state);
    if (
      vibe.some((s) => WAIT.includes(s)) ||
      (!vibe.length && checks.some((c) => WAIT.includes(state(c))))
    ) {
      out.pending.push(`${repo}#${num}`);
      continue;
    }
    if (vibe.some((s) => FAIL.includes(s))) {
      out.vibe_failed.push(`${repo}#${num}`);
      continue;
    }
    if (!lenient && others.some((s) => FAIL.includes(s))) {
      out.other_red.push(`${repo}#${num}`);
      continue;
    }
    gh(["pr", "merge", num, "--repo", repo, "--squash", "--admin", "--delete-branch"]);
    out.merged.push(`${repo}#${num}`);
    console.log(`merged ${repo}#${num}`);
  } catch (e) {
    out.error.push(`${repo}: ${String(e.message).split("\n")[0].slice(0, 100)}`);
  }
}
console.log("\n=== summary ===");
for (const k of Object.keys(out)) console.log(`${k} (${out[k].length}): ${out[k].join(", ")}`);
