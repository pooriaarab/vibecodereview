// Durable per-member storage lets a cancelled run retain paid results. The PR
// comment store is separate from the report so each result can be recorded on
// its own.

import { createHash } from "node:crypto";
import { PROMPT_VERSION } from "./council-config.mjs";

const CACHE_MARKER = "<!-- vibecodereview:council-result:";
const PAGE_SIZE = 100;
export const MAX_COMMENT_BODY_CHARS = 65536;

function githubConfig() {
  const token = process.env.GH_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const pullRequest = process.env.PR_NUMBER?.trim();
  if (!token || !repository || !/^\d+$/.test(pullRequest || "")) return null;
  const [owner, name] = repository.split("/", 2);
  if (!owner || !name) return null;
  const api = process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return {
    token,
    repositoryUrl: `${api}${repoPath}`,
    commentsUrl: `${api}${repoPath}/issues/${pullRequest}/comments`,
    commentUrl: (id) => `${api}${repoPath}/issues/comments/${encodeURIComponent(id)}`,
  };
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vibecodereview-council",
  };
}

function isModel(model) {
  return (
    model &&
    [model.provider, model.model, model.name, model.lens].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  );
}

export function memberId(model) {
  return `${model.provider}|${model.model}|${model.name}`;
}

export function cacheKey(diff, model) {
  return createHash("sha256")
    .update(Buffer.from(String(diff), "utf8"))
    .update(Buffer.from(memberId(model), "utf8"))
    .update(Buffer.from(model.lens, "utf8"))
    .update(Buffer.from(PROMPT_VERSION, "utf8"))
    .digest("hex");
}

export function parseCacheComment(body) {
  const lines = String(body || "").split("\n");
  const first = lines.shift() || "";
  if (!first.startsWith(CACHE_MARKER) || lines.pop() !== "-->") return null;
  const key = first.slice(CACHE_MARKER.length);
  if (!/^[a-f0-9]{64}$/.test(key)) return null;
  try {
    const encoded = lines.join("").trim();
    const entry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!isModel(entry?.model) || typeof entry.text !== "string") return null;
    return { key, model: entry.model, text: entry.text };
  } catch {
    return null;
  }
}

async function cacheEnabled(config) {
  try {
    const response = await fetch(config.repositoryUrl, { headers: headers(config.token) });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    const repository = await response.json();
    if (typeof repository?.private !== "boolean") throw new Error("GitHub API returned no visibility");
    if (repository.private) {
      console.log("Council cache: repository is private; cache enabled");
      return true;
    }
    console.log("Council cache: repository is public; cache disabled");
    return false;
  } catch (error) {
    console.warn(`Council cache: repository visibility unavailable; treating it as public and disabling cache (${error.message})`);
    return false;
  }
}

async function listCacheComments(config) {
  const cacheComments = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${config.commentsUrl}?per_page=${PAGE_SIZE}&page=${page}`, {
      headers: headers(config.token),
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    const comments = await response.json();
    if (!Array.isArray(comments)) throw new Error("GitHub API returned invalid comments");
    for (const comment of comments) {
      const author = comment?.user?.login;
      if (author !== "github-actions[bot]" && author !== "vibecodereview[bot]") continue;
      if (!String(comment?.body || "").startsWith(CACHE_MARKER)) continue;
      cacheComments.push({ comment, entry: parseCacheComment(comment.body) });
    }
    if (comments.length < PAGE_SIZE) break;
  }
  return cacheComments;
}

async function deleteCacheComments(config, cacheComments, reason) {
  let deleted = 0;
  await Promise.all(cacheComments.map(async ({ comment }) => {
    if (comment?.id === undefined || comment?.id === null) return;
    try {
      const response = await fetch(config.commentUrl(comment.id), {
        method: "DELETE",
        headers: headers(config.token),
      });
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
      deleted += 1;
    } catch (error) {
      console.warn(`Council cache ${reason} unavailable for comment ${comment.id}; continuing (${error.message})`);
    }
  }));
  return deleted;
}

export async function loadCouncilResults(diff, models) {
  const config = githubConfig();
  if (!config || !(await cacheEnabled(config))) return new Map();
  const expectedKeys = typeof diff === "string" && Array.isArray(models)
    ? new Set(models.map((model) => cacheKey(diff, model)))
    : null;
  const results = new Map();
  try {
    const cacheComments = await listCacheComments(config);
    const stale = expectedKeys
      ? cacheComments.filter(({ entry }) => !entry || !expectedKeys.has(entry.key))
      : [];
    // Two overlapping runs (e.g. a cancelled run's in-flight save landing
    // alongside its successor's) can each save the same key. Every duplicate
    // still matches expectedKeys, so it would never be pruned as stale and
    // would accumulate as an orphaned comment on every future run. Keep the
    // first (oldest) comment per key — the same one `results` below keeps —
    // and prune the rest.
    const seenKeys = new Set();
    const duplicates = [];
    for (const item of cacheComments) {
      const { entry } = item;
      if (!entry || (expectedKeys && !expectedKeys.has(entry.key))) continue;
      if (seenKeys.has(entry.key)) duplicates.push(item);
      else seenKeys.add(entry.key);
    }
    const toPrune = [...stale, ...duplicates];
    if (toPrune.length > 0) await deleteCacheComments(config, toPrune, "prune");
    for (const { entry } of cacheComments) {
      if (entry && (!expectedKeys || expectedKeys.has(entry.key)) && !results.has(entry.key)) {
        results.set(entry.key, entry);
      }
    }
    if (toPrune.length > 0) {
      console.log(`Council cache: pruned ${stale.length} stale and ${duplicates.length} duplicate result comment(s)`);
    }
  } catch (error) {
    console.warn(`Council cache unavailable; using live results (${error.message})`);
    return new Map();
  }
  console.log(`Council cache: found ${results.size} reusable result(s)`);
  return results;
}

export async function saveCouncilResult(key, result) {
  const config = githubConfig();
  if (!config || result?.error || !isModel(result?.model) || typeof result.text !== "string") return;
  const payload = Buffer.from(JSON.stringify({ model: result.model, text: result.text }), "utf8").toString("base64");
  const body = `${CACHE_MARKER}${key}\n${payload}\n-->`;
  if (body.length > MAX_COMMENT_BODY_CHARS) {
    console.warn(`Council cache save skipped: comment body is ${body.length} characters, over the GitHub limit of ${MAX_COMMENT_BODY_CHARS}`);
    return;
  }
  if (!(await cacheEnabled(config))) return;
  try {
    const response = await fetch(config.commentsUrl, {
      method: "POST",
      headers: { ...headers(config.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  } catch (error) {
    console.warn(`Council cache save unavailable; keeping live result (${error.message})`);
  }
}

export async function clearCouncilResults() {
  // Deliberately does not gate on cacheEnabled: a repository can go from
  // private to public between runs, and any cache comments written while it
  // was private must still be deletable, or they become a permanent
  // disclosure of raw model output on the now-public repository.
  const config = githubConfig();
  if (!config) return;
  try {
    const cacheComments = await listCacheComments(config);
    const deleted = await deleteCacheComments(config, cacheComments, "cleanup");
    if (cacheComments.length > 0) console.log(`Council cache: cleared ${deleted}/${cacheComments.length} result comment(s)`);
  } catch (error) {
    console.warn(`Council cache cleanup unavailable; continuing (${error.message})`);
  }
}
