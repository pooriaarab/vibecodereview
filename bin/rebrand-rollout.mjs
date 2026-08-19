// Rename the rollout workflow job `review` -> `vibecodereview` on repos that got
// the earlier template, so the PR check reads "vibecodereview" everywhere.
//   node rebrand-rollout.mjs [--dry-run] <owner/repo> ...   (or REPOS env)
// Idempotent: skips repos already branded or without the workflow. Commits
// directly to the default branch; falls back to a PR if that branch is protected.
import { execFileSync } from "node:child_process";

const gh = (a) => execFileSync("gh", a, { encoding: "utf8" }).trim();
const ghTry = (a) => { try { return { ok: true, out: gh(a) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message).split("\n").filter(Boolean).pop() || "" }; } };
const dry = process.argv.includes("--dry-run");
const repos = (process.argv.slice(2).filter((a) => a !== "--dry-run").length
  ? process.argv.slice(2).filter((a) => a !== "--dry-run")
  : (process.env.REPOS || "").split(",")).map((s) => s.trim()).filter(Boolean);
const PATH = ".github/workflows/vibecodereview.yml";
const out = { rebranded: [], via_pr: [], already: [], nofile: [], error: [] };

for (const repo of repos) {
  try {
    const meta = ghTry(["api", `repos/${repo}/contents/${PATH}`]);
    if (!meta.ok) { out.nofile.push(repo); continue; }
    const { content, sha } = JSON.parse(meta.out);
    const yaml = Buffer.from(content, "base64").toString("utf8");
    if (/^\s{2}vibecodereview:\s*$/m.test(yaml)) { out.already.push(repo); continue; }
    if (!/^\s{2}review:\s*$/m.test(yaml)) { out.already.push(repo); continue; }
    const updated = yaml.replace(/^(\s{2})review:(\s*)$/m, "$1vibecodereview:$2");
    const b64 = Buffer.from(updated).toString("base64");
    if (dry) { console.log(`[dry] would rebrand ${repo}`); out.rebranded.push(repo); continue; }
    const def = gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
    const direct = ghTry(["api", "-X", "PUT", `repos/${repo}/contents/${PATH}`,
      "-f", "message=Brand PR-review check as vibecodereview", "-f", `content=${b64}`, "-f", `sha=${sha}`, "-f", `branch=${def}`]);
    if (direct.ok) { out.rebranded.push(repo); console.log(`rebranded ${repo}`); continue; }
    // protected default branch -> PR
    const headSha = gh(["api", `repos/${repo}/git/ref/heads/${def}`, "--jq", ".object.sha"]);
    ghTry(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", "ref=refs/heads/rebrand-vibecodereview", "-f", `sha=${headSha}`]);
    gh(["api", "-X", "PUT", `repos/${repo}/contents/${PATH}`, "-f", "message=Brand PR-review check as vibecodereview",
      "-f", `content=${b64}`, "-f", `sha=${sha}`, "-f", "branch=rebrand-vibecodereview"]);
    gh(["pr", "create", "--repo", repo, "--base", def, "--head", "rebrand-vibecodereview",
      "--title", "Brand PR-review check as vibecodereview", "--body", "Renames the workflow job review -> vibecodereview."]);
    out.via_pr.push(repo); console.log(`PR opened for ${repo} (protected branch)`);
  } catch (e) { out.error.push(`${repo}: ${String(e.message).split("\n")[0].slice(0, 100)}`); }
}
console.log("\n=== summary ===");
for (const k of Object.keys(out)) console.log(`${k} (${out[k].length}): ${out[k].join(", ")}`);
