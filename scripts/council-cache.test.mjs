#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  cacheKey,
  loadCouncilResults,
  memberId,
  MAX_COMMENT_BODY_CHARS,
  saveCouncilResult,
  parseCacheComment,
} from "./council-cache.mjs";

const member = {
  provider: "openai",
  model: "gpt-5.6",
  name: "GPT-5.6 (Codex)",
  lens: "correctness",
};
const diff = "diff --git a/app.js b/app.js\n+return true;\n";
const key = cacheKey(diff, member);

assert.match(key, /^[a-f0-9]{64}$/);
assert.equal(memberId(member), "openai|gpt-5.6|GPT-5.6 (Codex)");
assert.notEqual(cacheKey(`${diff} `, member), key);
assert.notEqual(cacheKey(diff, { ...member, lens: "security" }), key);
assert.notEqual(cacheKey(diff, { ...member, model: "gpt-5.5" }), key);

function makeComment(keyToUse, text = "No findings.") {
  const payload = Buffer.from(JSON.stringify({ model: member, text }), "utf8").toString("base64");
  return `<!-- vibecodereview:council-result:${keyToUse}\n${payload}\n-->`;
}

const comment = makeComment(key);
assert.deepEqual(parseCacheComment(comment), { key, model: member, text: "No findings." });
assert.equal(parseCacheComment(`<!-- vibecodereview:council-result:${key}\ninvalid\n-->`), null);
const corruptPayload = Buffer.from(JSON.stringify({ text: "bad" }), "utf8").toString("base64");
assert.equal(parseCacheComment(`<!-- vibecodereview:council-result:${key}\n${corruptPayload}\n-->`), null);
assert.equal(parseCacheComment("not a council cache comment"), null);

const savedEnv = {};
for (const name of ["GH_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER", "GITHUB_API_URL"]) {
  savedEnv[name] = process.env[name];
}
const savedFetch = globalThis.fetch;
try {
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "owner/repo";
  process.env.PR_NUMBER = "7";
  delete process.env.GITHUB_API_URL;

  // Private repositories may load, prune stale keys, and save results.
  const staleKey = cacheKey("stale diff", member);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/repos/owner/repo")) return { ok: true, json: async () => ({ private: true }) };
    if (options.method === "DELETE") return { ok: true };
    if (options.method === "POST") return { ok: true };
    return {
      ok: true,
      json: async () => [
        { id: 11, user: { login: "github-actions[bot]" }, body: comment },
        { id: 12, user: { login: "github-actions[bot]" }, body: makeComment(staleKey) },
        { id: 13, user: { login: "contributor" }, body: makeComment(staleKey) },
      ],
    };
  };
  const loaded = await loadCouncilResults(diff, [member]);
  assert.equal(loaded.size, 1);
  assert.deepEqual(loaded.get(key), { key, model: member, text: "No findings." });
  assert.deepEqual(calls.filter(({ options }) => options.method === "DELETE").map(({ url }) => url), [
    "https://api.github.com/repos/owner/repo/issues/comments/12",
  ]);

  const post = calls.length;
  await saveCouncilResult(key, { model: member, text: "No findings." });
  assert.equal(calls.length, post + 2);
  const postRequest = calls.at(-1).options;
  assert.deepEqual(parseCacheComment(JSON.parse(postRequest.body).body), {
    key,
    model: member,
    text: "No findings.",
  });

  // Public repositories fail closed: do not read or write the comment store.
  const publicCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    publicCalls.push({ url, options });
    return { ok: true, json: async () => ({ private: false }) };
  };
  assert.equal((await loadCouncilResults(diff, [member])).size, 0);
  await saveCouncilResult(key, { model: member, text: "No findings." });
  assert.equal(publicCalls.length, 2);
  assert.ok(publicCalls.every(({ url }) => url.endsWith("/repos/owner/repo")));

  // An unavailable visibility response is also public, never an invitation to cache.
  let visibilityCalls = 0;
  globalThis.fetch = async () => {
    visibilityCalls += 1;
    return { ok: false, status: 503 };
  };
  assert.equal((await loadCouncilResults(diff, [member])).size, 0);
  assert.equal(visibilityCalls, 1);

  // Check the assembled body before any POST; base64 expansion must not make a
  // permanently oversized member fail silently on every run.
  let oversizedCalls = 0;
  globalThis.fetch = async () => {
    oversizedCalls += 1;
    return { ok: true, json: async () => ({ private: true }) };
  };
  const oversizedText = "x".repeat(50_000);
  await saveCouncilResult(key, { model: member, text: oversizedText });
  assert.ok(MAX_COMMENT_BODY_CHARS < Buffer.byteLength(makeComment(key, oversizedText)));
  assert.equal(oversizedCalls, 0);
} finally {
  globalThis.fetch = savedFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("council cache tests passed");
