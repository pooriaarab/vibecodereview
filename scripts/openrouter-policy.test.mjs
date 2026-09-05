#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CHAIR_FALLBACK_MODEL,
  bannedOpenRouterReason,
  isClaudeSeatProvider,
  resolveChairFallbackModel,
  usesOpenRouterRoute,
} from "./openrouter-policy.mjs";
import { openRouterFallbackFor, mutationMember, PROVIDERS } from "./council-config.mjs";
import { callModel } from "./council-members.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function check(name, fn) {
  fn();
  console.log(`ok    ${name}`);
}

check("bans Claude ids on OpenRouter", () => {
  for (const id of [
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
    "claude-sonnet-5",
    "anthropic/claude-3.5-sonnet",
  ]) {
    assert.match(String(bannedOpenRouterReason(id)), /Claude/, id);
  }
});

check("bans Codex ids on OpenRouter", () => {
  for (const id of ["openai/codex-mini", "openai/gpt-5.3-codex", "openai/codex"]) {
    assert.match(String(bannedOpenRouterReason(id)), /Codex/, id);
  }
});

check("bans Grok ids on OpenRouter", () => {
  for (const id of ["x-ai/grok-4.5", "x-ai/grok-4.6", "grok-4.5"]) {
    assert.match(String(bannedOpenRouterReason(id)), /Grok/, id);
  }
});

check("allows cheap leftover OpenRouter ids", () => {
  for (const id of [
    "deepseek/deepseek-v4-flash",
    "z-ai/glm-5.3-flash",
    "moonshotai/kimi-k3",
    "google/gemini-3.1-pro-preview",
    "openai/gpt-5.6",
  ]) {
    assert.equal(bannedOpenRouterReason(id), null, id);
  }
});

check("default chair fallback is allowed and matches action.yml", () => {
  assert.equal(bannedOpenRouterReason(DEFAULT_CHAIR_FALLBACK_MODEL), null);
  assert.equal(resolveChairFallbackModel("").model, DEFAULT_CHAIR_FALLBACK_MODEL);
  const action = fs.readFileSync(path.join(root, "action.yml"), "utf8");
  assert.match(action, new RegExp(`default: "${DEFAULT_CHAIR_FALLBACK_MODEL}"`));
  assert.doesNotMatch(action, /default: "anthropic\/claude/);
  assert.doesNotMatch(action, /default: "x-ai\/grok/);
});

check("an explicit Grok chair fallback is refused", () => {
  const resolved = resolveChairFallbackModel("x-ai/grok-4.5");
  assert.ok(resolved.error);
  assert.match(resolved.error, /Grok/);
});

check("a dead native GPT key reroutes to cheap DeepSeek, not GPT", () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-test";
  try {
    const route = openRouterFallbackFor({
      provider: "openai",
      model: "gpt-5.6",
      name: "GPT-5.6 (Codex)",
      lens: "correctness",
    });
    assert.equal(route.provider, "openrouter");
    assert.equal(route.model, "deepseek/deepseek-v4-flash");
    assert.equal(bannedOpenRouterReason(route.model), null);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});

check("an explicit Claude chair fallback is refused", () => {
  const resolved = resolveChairFallbackModel("anthropic/claude-sonnet-5");
  assert.ok(resolved.error);
  assert.match(resolved.error, /Claude/);
});

check("Claude OAuth seats never reroute to OpenRouter", () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-test";
  try {
    for (const provider of ["claude", "claude2", "claude3", "claude4"]) {
      assert.equal(
        openRouterFallbackFor({ provider, model: "claude-sonnet-5", name: "C", lens: "correctness" }),
        null,
        provider,
      );
    }
    assert.equal(
      openRouterFallbackFor({
        provider: "openai",
        model: "anthropic/claude-sonnet-5",
        name: "Smuggled",
        lens: "correctness",
      }),
      null,
    );
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});

const bannedCall = await callModel(
  { provider: "openrouter", model: "anthropic/claude-sonnet-5", name: "Sonnet", lens: "correctness" },
  "diff",
);
check("callModel skips a banned OpenRouter id without needing a key", () => {
  assert.match(String(bannedCall.error), /skipped:.*Claude/);
});

check("mutation defaults to a Claude OAuth seat", () => {
  const savedLens = process.env.MUTATION_LENS;
  const savedModel = process.env.MUTATION_MODEL;
  const savedProvider = process.env.MUTATION_PROVIDER;
  try {
    delete process.env.MUTATION_MODEL;
    delete process.env.MUTATION_PROVIDER;
    process.env.MUTATION_LENS = "true";
    const member = mutationMember();
    assert.equal(member.provider, "claude");
    assert.equal(member.model, "claude-sonnet-5");
    // The CLI model name is a Claude id, so OpenRouter must refuse it
    // if anyone reroutes this seat. The seat itself is the allowed path.
    assert.ok(bannedOpenRouterReason(member.model));
    assert.equal(openRouterFallbackFor(member), null);
  } finally {
    if (savedLens === undefined) delete process.env.MUTATION_LENS;
    else process.env.MUTATION_LENS = savedLens;
    if (savedModel === undefined) delete process.env.MUTATION_MODEL;
    else process.env.MUTATION_MODEL = savedModel;
    if (savedProvider === undefined) delete process.env.MUTATION_PROVIDER;
    else process.env.MUTATION_PROVIDER = savedProvider;
  }
});

check("numbered Claude seats exist and extra tokens register", () => {
  assert.equal(PROVIDERS.claude3.keyEnv, "CLAUDE_CODE_OAUTH_TOKEN_3");
  assert.equal(PROVIDERS.claude4.keyEnv, "CLAUDE_CODE_OAUTH_TOKEN_4");
  assert.equal(isClaudeSeatProvider("claude"), true);
  assert.equal(isClaudeSeatProvider("claude4"), true);
  assert.equal(isClaudeSeatProvider("openrouter"), false);
});

check("council fan-out receives OAuth tokens 3 and 4", () => {
  const action = fs.readFileSync(path.join(root, "action.yml"), "utf8");
  assert.match(action, /CLAUDE_CODE_OAUTH_TOKEN_3: \$\{\{ inputs\.claude_code_oauth_token_3 \}\}/);
  assert.match(action, /CLAUDE_CODE_OAUTH_TOKEN_4: \$\{\{ inputs\.claude_code_oauth_token_4 \}\}/);
});

check("custom via openrouter.ai is treated as OpenRouter", () => {
  assert.equal(
    usesOpenRouterRoute({ provider: "custom" }, { url: "https://openrouter.ai/api/v1/chat/completions" }),
    true,
  );
  assert.equal(
    usesOpenRouterRoute({ provider: "custom" }, { url: "http://127.0.0.1:8080/v1/chat/completions" }),
    false,
  );
});

console.log("openrouter-policy tests passed");
