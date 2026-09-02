// Durable per-member storage lets a cancelled run retain paid results. The PR
// comment store is separate from the report so each result can be recorded on
// its own.

import { createHash } from "node:crypto";
import { PROMPT_VERSION } from "./council-config.mjs";

const CACHE_MARKER = "<!-- vibecodereview:council-result:";
const PAGE_SIZE = 100;

function githubConfig() {
  const token = process.env.GH_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const pullRequest = process.env.PR_NUMBER?.trim();
  if (!token || !repository || !/^\d+$/.test(pullRequest || "")) return null;
  const [owner, name] = repository.split("/", 2);
  if (!owner || !name) return null;
  const api = process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
  return {
    token,
    commentsUrl: `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pullRequest}/comments`,
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

export async function loadCouncilResults() {
  const config = githubConfig();
  if (!config) return new Map();
  const results = new Map();
  try {
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
        const entry = parseCacheComment(comment?.body);
        if (entry && !results.has(entry.key)) results.set(entry.key, entry);
      }
      if (comments.length < PAGE_SIZE) break;
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
