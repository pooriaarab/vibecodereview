#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  cacheKey,
  loadCouncilResults,
  memberId,
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

const payload = Buffer.from(JSON.stringify({ model: member, text: "No findings." }), "utf8").toString("base64");
const comment = `<!-- vibecodereview:council-result:${key}\n${payload}\n-->`;
assert.deepEqual(parseCacheComment(comment), { key, model: member, text: "No findings." });
assert.equal(parseCacheComment(`<!-- vibecodereview:council-result:${key}\ninvalid\n-->`), null);
const corruptPayload = Buffer.from(JSON.stringify({ text: "bad" }), "utf8").toString("base64");
assert.equal(parseCacheComment(`<!-- vibecodereview:council-result:${key}\n${corruptPayload}\n-->`), null);
assert.equal(parseCacheComment("not a council cache comment"), null);

const savedEnv = {
  GH_TOKEN: process.env.GH_TOKEN,
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  PR_NUMBER: process.env.PR_NUMBER,
};
const savedFetch = globalThis.fetch;
try {
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "owner/repo";
  process.env.PR_NUMBER = "7";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { user: { login: "github-actions[bot]" }, body: comment },
      { user: { login: "contributor" }, body: comment },
      { user: { login: "github-actions[bot]" }, body: `<!-- vibecodereview:council-result:${key} -->\n{` },
    ],
  });
  const loaded = await loadCouncilResults();
  assert.equal(loaded.size, 1);
  assert.deepEqual(loaded.get(key), { key, model: member, text: "No findings." });
  let request;
  globalThis.fetch = async (_url, options) => {
    request = options;
    return { ok: true };
  };
  await saveCouncilResult(key, { model: member, text: "No findings." });
  assert.deepEqual(parseCacheComment(JSON.parse(request.body).body), {
    key,
    model: member,
    text: "No findings.",
  });
} finally {
  globalThis.fetch = savedFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("council cache tests passed");
