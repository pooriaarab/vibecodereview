#!/usr/bin/env node
// LLM council: fan a PR diff out to several models — each on its own provider,
// each with a distinct review lens — and write their findings to a markdown
// file. Claude (in the workflow's claude-code-action step) reads that file,
// de-dupes, validates, fixes, and posts the combined review.
//
// This script never blocks the PR: a member with no API key, or a failed
// request, degrades to a note in the output, and the script always exits 0.
//
// Usage:
//   node council-review.mjs <diff-file> <out-file>
//   node council-review.mjs --selfcheck   # offline shape check, no network
//
// Env — one key per provider you want in the council (omit to drop that member):
//   OPENAI_API_KEY      GPT / Codex        (api.openai.com)
//   GEMINI_API_KEY      Gemini             (generativelanguage.googleapis.com)
//   MOONSHOT_API_KEY    Kimi               (api.moonshot.ai)
//   OPENROUTER_API_KEY  Grok / DeepSeek    (openrouter.ai)
//   CUSTOM_API_KEY      Any OpenAI-compatible gateway — set CUSTOM_BASE_URL
//                       to its /chat/completions URL (OpenRouter, a self-hosted
//                       proxy, or a local OffRouter endpoint).
// Optional per-member model override: OPENAI_MODEL, GEMINI_MODEL,
//   MOONSHOT_MODEL, OPENROUTER_MODEL.
// Optional full override: COUNCIL_MODELS = CSV of "provider|model|Name|lens".

import fs from "node:fs";
import { prepareDiff } from "./pr-context.mjs";
import os from "node:os";
import path from "node:path";

const MAX_DIFF_CHARS = 180_000; // bound tokens/cost on large PRs

// All providers expose an OpenAI-compatible /chat/completions endpoint
// (Gemini via its OpenAI-compat URL), so one request shape serves all.
import {
  PROVIDERS,
  DEFAULT_MODELS,
  openRouterFallbackFor,
  withMutationMember,
  diffAddsTestLines,
  selfcheckMutationRoster,
} from "./council-config.mjs";
import { buildFindingsMarkdown, lensCanReviewDiff } from "./review-delta.mjs";
import {
  REQUEST_TIMEOUT_MS,
  parseModels,
  callModel,
  hasNativeKey,
  callModelWithFallback,
} from "./council-members.mjs";
import { cacheKey, loadCouncilResults, saveCouncilResult } from "./council-cache.mjs";
import { withLensEffort } from "./lens-effort-config.mjs";
import { behavioralSurface } from "./behavioral-surface.mjs";
import { filterMembersByKindRouting, lensesForKinds, routeLenses } from "./lens-routing.mjs";
import { appendFindingsMeta } from "./file-findings.mjs";

async function main() {
  if (process.argv.includes("--selfcheck")) {
    const md = buildFindingsMarkdown(
      [
        { model: { name: "M1", lens: "security" }, text: "- **🔴 Critical** `a.ts:10` — bad. fix it." },
        { model: { name: "M2", lens: "performance" }, error: "timed out" },
      ],
      { diffTruncated: true, contextTruncated: false },
    );
    const ok =
      md.includes("M1 — security lens") &&
      md.includes("_timed out_") &&
      md.includes("Diff was truncated") &&
      !md.includes("context") &&
      md.includes("🔴 Critical");
    if (!ok) throw new Error("selfcheck failed:\n" + md);
    const metadata = buildFindingsMarkdown([], {
      reviewHeadSha: "a".repeat(40),
      memberDiffNote: "delta since `previous`.",
      skippedLenses: ["performance"],
      carriedFindings: "## old finding\n\nKeep this.",
    });
    if (!metadata.includes("Reviewed head") || !metadata.includes("Member diff") || !metadata.includes("performance") || !metadata.includes("Findings carried forward")) {
      throw new Error("selfcheck: delta metadata missing");
    }
    // Verify context-only truncation message too.
    const mdCtx = buildFindingsMarkdown(
      [{ model: { name: "M1", lens: "correctness" }, text: "ok" }],
      { diffTruncated: false, contextTruncated: true },
    );
    if (!mdCtx.includes("PR context")) throw new Error("selfcheck: context-only truncation message wrong");
    // Verify both-truncated message.
    const mdBoth = buildFindingsMarkdown(
      [{ model: { name: "M1", lens: "correctness" }, text: "ok" }],
      { diffTruncated: true, contextTruncated: true },
    );
    if (!mdBoth.includes("Diff and PR context")) throw new Error("selfcheck: both-truncated message wrong");
    // also verify a member with no key resolves to a skip, not a throw. Clear
    // the key for this call regardless of the ambient env so the check stays
    // offline even when OPENAI_API_KEY happens to be set in the shell.
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let r;
    try {
      r = await callModel({ provider: "openai", model: "x", name: "X", lens: "correctness" }, "diff");
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    }
    if (!r.error?.includes("OPENAI_API_KEY")) throw new Error("selfcheck: missing-key path wrong: " + r.error);
    // a custom member with no CUSTOM_BASE_URL must also skip, not throw — even
    // when the ambient env sets one, so the check stays offline.
    const savedUrl = PROVIDERS.custom.url;
    PROVIDERS.custom.url = undefined;
    let r2;
    try {
      r2 = await callModel({ provider: "custom", model: "x", name: "X", lens: "correctness" }, "diff");
    } finally {
      PROVIDERS.custom.url = savedUrl;
    }
    if (!r2.error?.includes("CUSTOM_BASE_URL")) throw new Error("selfcheck: custom no-url path wrong: " + r2.error);

    // Assert DEFAULT_MODELS, not parseModels(): parseModels reads COUNCIL_MODELS
    // from the environment, so a repo that legitimately overrides the member list
    // would fail the selfcheck that AGENTS.md requires it to run.
    if (!DEFAULT_MODELS.some((m) => m.lens === "scope")) throw new Error("selfcheck: scope lens missing from default members");
    selfcheckMutationRoster(buildFindingsMarkdown);

    const allRoutedLenses = ["correctness", "performance", "security", "maintainability", "scope"];
    const emptyRoute = routeLenses("");
    if (!allRoutedLenses.every((l) => emptyRoute.lenses.includes(l))) {
      throw new Error("selfcheck: empty diff must fail open with every routed lens");
    }
    if (!lensesForKinds(new Set(["docs"])).includes("scope")) {
      throw new Error("selfcheck: routing must never drop scope");
    }

    // A unique temp dir, not a fixed name in the working directory: the old
    // fixture would clobber a real test_ctx.tmp and broke concurrent runs.
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-selfcheck-"));
    const testCtx = path.join(testDir, "ctx.txt");
    fs.writeFileSync(testCtx, "my PR claim");
    try {
      const { diff } = prepareDiff("my diff", testCtx, MAX_DIFF_CHARS);
      if (!diff.includes("my PR claim") || !diff.includes("my diff")) throw new Error("selfcheck: context not prepended");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    const { diff: noCtxDiff } = prepareDiff("my diff", path.join(testDir, "nonexistent.tmp"), MAX_DIFF_CHARS);
    if (noCtxDiff !== "my diff") throw new Error("selfcheck: missing context file is not a no-op");

    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testCtx, "A".repeat(10000));
    try {
      const { diff: truncCtx } = prepareDiff("my diff", testCtx, MAX_DIFF_CHARS);
      if (!truncCtx.includes("context truncated") || truncCtx.length > 9000) throw new Error("selfcheck: context not truncated at 8000");
      const bigDiff = "D".repeat(MAX_DIFF_CHARS);
      const { diff: truncCombined, diffTruncated, contextTruncated } = prepareDiff(bigDiff, testCtx, MAX_DIFF_CHARS);
      // Context was cut but the diff (which fills the whole budget) is intact.
      if (diffTruncated) throw new Error("selfcheck: diff was truncated when it filled the budget");
      if (!contextTruncated) throw new Error("selfcheck: context should have been marked truncated");
      if (truncCombined.length > MAX_DIFF_CHARS) throw new Error("selfcheck: combined truncation failed");
      // A diff that already fills the budget must keep every character of it.
      if (truncCombined !== bigDiff) throw new Error("selfcheck: diff was truncated to make room for context");
      const { diff: partial } = prepareDiff("D".repeat(MAX_DIFF_CHARS - 4000), testCtx, MAX_DIFF_CHARS);
      if (!partial.startsWith("===== PR CONTEXT")) throw new Error("selfcheck: context dropped when it still fit");
      if (partial.length > MAX_DIFF_CHARS) throw new Error("selfcheck: partial context exceeded the cap");
      // A truncated context must still be closed by the DIFF marker, or author
      // text runs straight into a diff hunk.
      if (!partial.includes("\n===== DIFF =====\n")) throw new Error("selfcheck: truncation clipped the DIFF marker");
      // A second, tighter cut must announce itself too, not just the first.
      const ctxPart = partial.slice(0, partial.indexOf("===== DIFF ====="));
      if (!ctxPart.includes("context truncated")) throw new Error("selfcheck: second cut left no truncation marker");
      if (partial.split("===== DIFF =====").length !== 2) throw new Error("selfcheck: DIFF marker not exactly once");
      // Too little room for meaningful context means no context, not a fragment.
      const { diff: noRoom } = prepareDiff("D".repeat(MAX_DIFF_CHARS - 50), testCtx, MAX_DIFF_CHARS);
      if (noRoom.includes("===== PR CONTEXT")) throw new Error("selfcheck: shipped a context fragment with no room");
      // A short context (never hit the 8000-char cap) dropped whole for lack of
      // room must still be reported as truncated, or the scope lens silently
      // loses the claim with no warning anywhere in the findings.
      fs.writeFileSync(testCtx, "short claim");
      const { diff: shortNoRoom, contextTruncated: shortDropped } = prepareDiff(
        "D".repeat(MAX_DIFF_CHARS - 50),
        testCtx,
        MAX_DIFF_CHARS,
      );
      if (shortNoRoom.includes("===== PR CONTEXT")) throw new Error("selfcheck: shipped a short context fragment with no room");
      if (!shortDropped) throw new Error("selfcheck: short context dropped for lack of room was not marked truncated");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }

    // A CLI-backed seat with no oauth token must skip too, not shell out --
    // even when the ambient env sets one, so the check stays offline.
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    let cliSkip;
    try {
      cliSkip = await callModel({ provider: "claude", model: "x", name: "X", lens: "correctness" }, "diff");
    } finally {
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    }
    if (!cliSkip.error?.includes("CLAUDE_CODE_OAUTH_TOKEN")) {
      throw new Error("selfcheck: claude missing-token path wrong: " + cliSkip.error);
    }
    console.log("selfcheck ok");
    return;
  }

  const diffFile = process.argv[2];
  const outFile = process.argv[3] || "council-findings.md";

  // Read before ANY return below: every path out of main() — including the
  // config and empty-diff gates above the trivial-delta gate — must preserve
  // the carried-forward findings, or a cycle that exits early rewrites the
  // review-state comment with an empty carry and silently drops every
  // unresolved finding from earlier cycles.
  const priorFindings = process.env.VCR_PRIOR_FINDINGS_FILE && fs.existsSync(process.env.VCR_PRIOR_FINDINGS_FILE)
    ? fs.readFileSync(process.env.VCR_PRIOR_FINDINGS_FILE, "utf8")
    : "";
  // The ONLY way to write the report. It appends the findings metadata the
  // trace records read, and preserves the carry alongside the report, so a
  // future early return that uses `write` can forget neither.
  const write = (md, carry = priorFindings) => {
    fs.writeFileSync(outFile, appendFindingsMeta(md));
    if (process.env.VCR_CARRY_FILE) fs.writeFileSync(process.env.VCR_CARRY_FILE, carry);
  };

  const models = parseModels();
  if (models.length === 0) {
    write(
      "# 🧑‍⚖️ LLM Council findings\n\n_Council skipped: COUNCIL_MODELS parsed to no valid members (expected `provider|model|Name|lens`; providers: openai, gemini, moonshot, openrouter, custom)._\n",
    );
    console.log("No valid council members — skipped.");
    return;
  }
  const diffRaw = diffFile && fs.existsSync(diffFile) ? fs.readFileSync(diffFile, "utf8") : "";
  const memberDiffFile = process.env.COUNCIL_MEMBER_DIFF_FILE;
  const memberDiffRaw = memberDiffFile && fs.existsSync(memberDiffFile)
    ? fs.readFileSync(memberDiffFile, "utf8")
    : diffRaw;
  const { diff, diffTruncated, contextTruncated } = prepareDiff(diffRaw, process.env.PR_CONTEXT_FILE, MAX_DIFF_CHARS);
  const { diff: memberDiff, diffTruncated: memberDiffTruncated } = prepareDiff(
    memberDiffRaw,
    process.env.PR_CONTEXT_FILE,
    MAX_DIFF_CHARS,
  );

  if (!diff) {
    write("# 🧑‍⚖️ LLM Council findings\n\n_Council skipped: empty diff._\n");
    console.log("Empty diff — council skipped.");
    return;
  }

  // Every skip path from here on surfaces carried-forward findings in the
  // report (via `carriedFindings` below); the `write` helper preserves them in
  // the carry file too, or a delta that goes trivial right after a cycle that
  // left a real finding open silently drops it instead of carrying it on.
  const baseReportOptions = {
    reviewHeadSha: process.env.VCR_REVIEW_HEAD_SHA,
    memberDiffNote: process.env.VCR_MEMBER_DIFF_NOTE,
    carriedFindings: priorFindings,
    diffTruncated,
    contextTruncated,
  };

  const surface = behavioralSurface(memberDiffRaw);
  if (surface.trivial) {
    const listed = surface.paths.map((p) => `\`${p}\``).join(", ");
    write(buildFindingsMarkdown([], baseReportOptions) + `\n\n_Council skipped: trivial delta with no behavioral surface — ${surface.reason}. Paths: ${listed}._\n`);
    console.log(`Trivial delta — council skipped (${surface.paths.length} inert path(s)).`);
    return;
  }

  // Scope and proof need the whole PR. Other lenses receive only the delta, and
  // a lens with no applicable changed path must not pay for a no-op call.
  // Composed here rather than beside parseModels because applicability depends
  // on the diff read above.
  // Effort is applied AFTER the mutation member is appended, not beside
  // parseModels. withMutationMember adds a member that parseModels never
  // returned, so decorating before it left MUTATION_EFFORT set, documented and
  // never applied — a dead config key.
  let { members, mutationSkipped } = withMutationMember(models, memberDiffRaw);
  members = withLensEffort(members);
  const lensPathFilter = process.env.LENS_PATH_FILTER;
  let skippedLenses = [...new Set(
    members.filter((m) => !lensCanReviewDiff(m.lens, memberDiffRaw, lensPathFilter)).map((m) => m.lens),
  )];
  members = members.filter((m) => lensCanReviewDiff(m.lens, memberDiffRaw, lensPathFilter));
  // diffRaw only decides whether tests exist ANYWHERE in the PR; it says
  // nothing about whether those test hunks survived truncation into `diff`,
  // which is what the model actually receives. Dispatching on diffRaw's answer
  // while sending the truncated `diff` would burn a call on a member that
  // cannot see the tests it was enabled to review.
  if (members.some((m) => m.lens === "mutation") && memberDiffTruncated && !diffAddsTestLines(memberDiff)) {
    members = members.filter((m) => m.lens !== "mutation");
    mutationSkipped = "the member delta was truncated before its added test lines";
  }
  if (mutationSkipped) console.log(`Mutation lens enabled but not dispatched: ${mutationSkipped}`);
  const kindRouting = filterMembersByKindRouting(members, memberDiffRaw);
  members = kindRouting.members;
  skippedLenses.push(...kindRouting.skippedLenses);
  skippedLenses = [...new Set(skippedLenses)];
  const reportOptions = { ...baseReportOptions, skippedLenses, mutationSkipped };

  if (members.length === 0) {
    write(buildFindingsMarkdown([], reportOptions) + "\n\n_Council skipped: no configured lens applies to the member delta._\n");
    console.log("No applicable council lenses — skipped.");
    return;
  }
  // Cache keys use the exact input each member receives: scope sees the full
  // pull-request diff, while the other lenses see the reachable delta.
  const fullLenses = new Set(["scope"]);
  const memberInput = (m) => fullLenses.has(m.lens) ? diff : memberDiff;
  const cachedResults = await loadCouncilResults(memberDiff, members, memberInput);
  const cacheFor = (member) => cachedResults.get(cacheKey(memberInput(member), member));
  const servable = members.filter((m) => cacheFor(m) || hasNativeKey(m) || openRouterFallbackFor(m));
  if (servable.length === 0) {
    const missing = members.map((m) => PROVIDERS[m.provider]?.keyEnv).join(", ");
    write(buildFindingsMarkdown([], reportOptions) + `\n\n_Council skipped: no provider keys set (${missing})._\n`);
    console.log("No provider keys — council skipped.");
    return;
  }

  console.log(`Council: ${members.map((m) => `${m.name} [${m.provider}]`).join(", ")}`);
  const councilStartedAt = Date.now();
  const results = await Promise.all(members.map(async (m) => {
    const key = cacheKey(memberInput(m), m);
    const cached = cachedResults.get(key);
    if (cached) return { model: cached.model, text: cached.text, cached: true };
    if (!hasNativeKey(m) && !openRouterFallbackFor(m)) return callModelWithFallback(m, memberInput(m));
    const result = await callModelWithFallback(m, memberInput(m));
    if (!result.error) await saveCouncilResult(key, result);
    return result;
  }));
  for (const r of results) {
    const took = r.ms === undefined ? "" : ` (${(r.ms / 1000).toFixed(1)}s)`;
    console.log(`- ${r.model.name}${took}: ${r.error ? "SKIP/ERR " + r.error : "ok"}`);
  }
  console.log(
    `Council wall time: ${((Date.now() - councilStartedAt) / 1000).toFixed(1)}s (timeout ${REQUEST_TIMEOUT_MS / 1000}s)`,
  );

  const report = buildFindingsMarkdown(results, reportOptions);
  // Keep a flat list of every candidate from every cycle. The chair decides
  // which entries are fixed; dropping an older entry here would hide an
  // unresolved finding merely because the next delta did not repeat it.
  const current = results.map((r) => `## ${r.model.name} — ${r.model.lens} lens\n\n${r.error ? `_${r.error}_` : r.text}`).join("\n\n");
  let combined = [current, priorFindings].filter(Boolean).join("\n\n");
  // The workflow base64-encodes this into a single hidden PR comment, which
  // GitHub caps at 65536 characters. Newest content (this cycle's own
  // findings, then the most recently carried ones) sits at the front of
  // `combined`, so cutting the tail drops the oldest carried text first —
  // without this cap, an unbounded carry file makes the state-comment write
  // fail silently (it runs with continue-on-error) and the review boundary
  // goes stale.
  const CARRY_CHAR_BUDGET = 45_000;
  if (combined.length > CARRY_CHAR_BUDGET) {
    combined = combined.slice(0, CARRY_CHAR_BUDGET) + "\n\n_[older carried findings dropped to keep the review-state comment under GitHub's size limit]_";
  }
  write(report, combined);
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  // Never fail the workflow on council errors.
  console.error("Council error (non-fatal):", err);
  try {
    fs.writeFileSync(
      process.argv[3] || "council-findings.md",
      appendFindingsMeta(`# 🧑‍⚖️ LLM Council findings\n\n_Council errored: ${String(err?.message || err)}_\n`),
    );
  } catch {}
  process.exit(0);
});
