// Delta review helpers shared by the engine's member dispatch and its tests.
// The chair deliberately does not use these helpers: it always reads the full
// pull-request diff.

export const REVIEW_STATE_MARKER = "<!-- vibecodereview:review-state -->";

function patternsForLens(pathFilter, lens) {
  if (!pathFilter) return [];
  let filter = pathFilter;
  if (typeof filter === "string") {
    if (!filter.trim()) return [];
    try {
      filter = JSON.parse(filter);
    } catch {
      return [];
    }
  }
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return [];
  const patterns = filter[lens];
  if (typeof patterns === "string") return [patterns];
  return Array.isArray(patterns) ? patterns.filter((pattern) => typeof pattern === "string") : [];
}

export function diffPaths(diff) {
  const paths = [];
  for (const line of String(diff || "").split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    for (const path of [match[1], match[2]]) {
      if (path !== "/dev/null" && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

export function lensCanReviewPath(lens, path, pathFilter) {
  // Scope is about the PR as a whole, including documentation-only changes.
  if (lens === "scope") return true;
  // Path filtering is opt-in and supplied per lens by the consumer. In
  // particular, security has no built-in executable-file allowlist: a
  // lockfile or SVG may be exactly what it needs to inspect.
  return !patternsForLens(pathFilter, lens).some((pattern) => new RegExp(pattern, "i").test(path));
}

export function lensCanReviewDiff(lens, diff, pathFilter) {
  if (lens === "scope") return true;
  return diffPaths(diff).some((path) => lensCanReviewPath(lens, path, pathFilter));
}

export function shouldWriteReviewState(repositoryPrivate) {
  return repositoryPrivate === true;
}

export function buildFindingsMarkdown(
  results,
  { diffTruncated, contextTruncated, mutationSkipped, reviewHeadSha, memberDiffNote, skippedLenses, carriedFindings } = {},
) {
  const lines = ["# 🧑‍⚖️ LLM Council findings", ""];
  lines.push(
    "Independent per-lens reviews from council models. Treat as co-reviewer input: de-dupe, verify each claim against the code, discard false positives, and only fix confidently-real issues.",
    "",
  );
  if (reviewHeadSha) lines.push(`> Reviewed head: \`${reviewHeadSha}\`.`, "");
  if (memberDiffNote) lines.push(`> Member diff: ${memberDiffNote}`, "");
  if (skippedLenses?.length) {
    lines.push(`> Lenses not dispatched: ${skippedLenses.join(", ")} (the member delta did not touch files they review).`, "");
  }
  if (diffTruncated && contextTruncated) {
    lines.push("> ⚠️ Diff and PR context were truncated for length; council saw the first portion of each.", "");
  } else if (diffTruncated) {
    lines.push("> ⚠️ Diff was truncated for length; council saw the first portion only.", "");
  } else if (contextTruncated) {
    lines.push("> ⚠️ PR context (title, body, linked issues) was truncated for length; the diff is complete.", "");
  }
  if (mutationSkipped) {
    lines.push(`> ℹ️ Mutation lens enabled but not dispatched: ${mutationSkipped}.`, "");
  }
  for (const r of results) {
    const cached = r.cached ? " (cached)" : "";
    lines.push(`## ${r.model.name} — ${r.model.lens} lens${cached}`, "");
    if (r.error) lines.push(`_${r.error}_`, "");
    else lines.push(r.text, "");
  }
  if (carriedFindings?.trim()) {
    lines.push("## Findings carried forward", "", "The chair must re-check these prior findings and retain every one that remains unresolved.", "", carriedFindings.trim(), "");
  }
  return lines.join("\n");
}

export function buildReviewState(headSha, carry) {
  const encoded = Buffer.from(String(carry || ""), "utf8").toString("base64");
  return `${REVIEW_STATE_MARKER}\nsha:${headSha}\ncarry:${encoded}\n<!-- /vibecodereview:review-state -->`;
}

export function parseReviewState(body) {
  const lines = String(body || "").split("\n");
  if (lines[0] !== REVIEW_STATE_MARKER || lines[lines.length - 1] !== "<!-- /vibecodereview:review-state -->") {
    return null;
  }
  const sha = lines[1]?.startsWith("sha:") ? lines[1].slice(4) : "";
  if (!lines[2]?.startsWith("carry:")) return null;
  const encoded = lines.slice(2, -1).join("\n").slice(6);
  const compact = encoded.replaceAll("\n", "");
  if (!/^[0-9a-f]{40,64}$/.test(sha) || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  try {
    const carry = Buffer.from(compact, "base64").toString("utf8");
    const normalized = Buffer.from(carry, "utf8").toString("base64");
    if (normalized !== compact) return null;
    return { sha, carry };
  } catch {
    return null;
  }
}
