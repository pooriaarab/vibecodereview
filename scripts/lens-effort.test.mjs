#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  EFFORT_ALIASES,
  parseEffortPosition,
  resolveRung,
  rungPosition,
} from "./lens-effort.mjs";
import { LADDERS_FOR_TESTS, offeredRungs } from "./model-effort-ladders.mjs";
import {
  cliEffortRung,
  effortCacheSegment,
  effortWireExtras,
  withLensEffort,
} from "./lens-effort-config.mjs";
import { withMutationMember } from "./council-config.mjs";
import { buildRequestBody } from "./council-members.mjs";
import { cacheKey } from "./council-cache.mjs";
import { claudeCliArgs } from "./claude-cli-seat.mjs";

const member = {
  provider: "openai",
  model: "gpt-5.6",
  name: "GPT-5.6 (Codex)",
  lens: "correctness",
};
const diff = "diff --git a/app.js b/app.js\n+return true;\n";

// --- round-trip every defined ladder ---
for (const { name, published } of LADDERS_FOR_TESTS) {
  for (const rung of offeredRungs(published)) {
    const position = rungPosition({ rung, published });
    assert.notEqual(position, undefined, `${name}: ${rung} has no position`);
    assert.equal(
      resolveRung({ position, published }),
      rung,
      `${name}: ${rung} at ${position} did not round-trip`,
    );
  }
}

// --- between-rungs positions round DOWN ---
assert.equal(
  resolveRung({ position: 0.5, published: ["low", "medium", "high", "xhigh"] }),
  "medium",
);
assert.equal(resolveRung({ position: 0.9, published: ["low", "medium", "high"] }), "medium");
assert.equal(
  resolveRung({ position: 0.99, published: ["low", "medium", "high", "xhigh", "max"] }),
  "xhigh",
);

// --- typos stay undefined ---
for (const bad of ["", "  ", "bogus", "1.5", "-0.2", "NaN", "Infinity", "high-ish"]) {
  assert.equal(parseEffortPosition(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`);
}
assert.equal(parseEffortPosition("high"), EFFORT_ALIASES.high);

// --- cache key includes effort ---
const lowEffort = { ...member, effortConfigured: true, effortPosition: 0 };
const highEffort = { ...member, effortConfigured: true, effortPosition: 1 };
assert.notEqual(cacheKey(diff, lowEffort), cacheKey(diff, highEffort));
assert.notEqual(cacheKey(diff, member), cacheKey(diff, lowEffort));

// --- default effort leaves the HTTP body byte-identical ---
const legacyBody = JSON.stringify({
  model: member.model,
  messages: [
    { role: "system", content: buildRequestBody(member, diff).messages[0].content },
    { role: "user", content: `PR diff:\n\n${diff}` },
  ],
});
assert.equal(JSON.stringify(buildRequestBody(member, diff)), legacyBody);

// --- configured effort reaches the wire when the route supports it ---
const configured = { ...member, effortConfigured: true, effortPosition: 0 };
const wired = buildRequestBody(configured, diff);
assert.equal(wired.reasoning_effort, "low");

// --- OpenRouter gets the nested reasoning.effort shape, not reasoning_effort ---
const openRouterMember = { ...member, provider: "openrouter", effortConfigured: true, effortPosition: 0 };
const openRouterBody = buildRequestBody(openRouterMember, diff);
assert.deepEqual(openRouterBody.reasoning, { effort: "low" });
assert.equal(openRouterBody.reasoning_effort, undefined);

// --- Claude CLI seats resolve a rung from their own published ladder ---
const claudeMember = {
  provider: "claude",
  model: "claude-sonnet-5",
  name: "Sonnet 5",
  lens: "correctness",
  effortConfigured: true,
  effortPosition: 0,
};
assert.equal(cliEffortRung(claudeMember), "low");
assert.equal(cliEffortRung({ ...claudeMember, effortConfigured: false }), undefined);
// An unpublished model must not send a rung the CLI's own flag would reject.
assert.equal(cliEffortRung({ ...claudeMember, model: "claude-unknown-9" }), undefined);
// A non-CLI provider never resolves a CLI rung even with the same ladder.
assert.equal(cliEffortRung({ ...claudeMember, provider: "openai" }), undefined);

// --- the configured rung reaches the CLI's own argv, and an unset rung
// leaves argv exactly as it was before this PR ---
const cliArgsWithEffort = claudeCliArgs(claudeMember, "review the diff", "low");
assert.deepEqual(cliArgsWithEffort.slice(-2), ["--effort", "low"]);
const cliArgsWithoutEffort = claudeCliArgs(claudeMember, "review the diff", undefined);
assert.equal(cliArgsWithoutEffort.includes("--effort"), false);
assert.deepEqual(cliArgsWithoutEffort, [
  "-p",
  "review the diff",
  "--model",
  claudeMember.model,
  "--allowed-tools",
  "",
  "--max-turns",
  "1",
]);

// --- invalid env stays visible on the member ---
const saved = process.env.CORRECTNESS_EFFORT;
try {
  process.env.CORRECTNESS_EFFORT = "high-ish";
  const [parsed] = withLensEffort([member]);
  assert.match(String(parsed.effortParseError), /invalid CORRECTNESS_EFFORT: high-ish/);
} finally {
  if (saved === undefined) delete process.env.CORRECTNESS_EFFORT;
  else process.env.CORRECTNESS_EFFORT = saved;
}

// --- a present-but-empty (or whitespace-only) env var is a visible config
// error, not silently equivalent to the var being unset entirely ---
try {
  for (const blank of ["", "   "]) {
    process.env.CORRECTNESS_EFFORT = blank;
    const [parsed] = withLensEffort([member]);
    assert.ok(parsed.effortParseError, `blank ${JSON.stringify(blank)} should surface a parse error`);
    assert.equal(parsed.effortConfigured, undefined);
  }
} finally {
  if (saved === undefined) delete process.env.CORRECTNESS_EFFORT;
  else process.env.CORRECTNESS_EFFORT = saved;
}

// --- an invalid effort must never key the same as unset — a stale cache hit
// would skip callModel entirely and never surface the parse error ---
const parseErrorMember = { ...member, effortParseError: "invalid CORRECTNESS_EFFORT: high-ish" };
assert.notEqual(effortCacheSegment(parseErrorMember), effortCacheSegment(member));
assert.notEqual(cacheKey(diff, parseErrorMember), cacheKey(diff, member));

// MUTATION_EFFORT must reach the mutation member. That member is appended by
// withMutationMember, which parseModels never returns, so decorating with
// effort before the append leaves this env var set, documented and dead.
{
  const savedLens = process.env.MUTATION_LENS;
  const savedEffort = process.env.MUTATION_EFFORT;
  try {
    process.env.MUTATION_LENS = "true";
    process.env.MUTATION_EFFORT = "max";
    const diff = "diff --git a/a.test.mjs b/a.test.mjs\n--- a/a.test.mjs\n+++ b/a.test.mjs\n+assert(1);\n";
    const { members } = withMutationMember(
      [{ provider: "openai", model: "gpt-5.6", name: "G", lens: "security" }],
      diff,
    );
    const decorated = withLensEffort(members);
    const mutation = decorated.find((m) => m.lens === "mutation");
    assert.ok(mutation, "mutation member should be appended for a diff that adds tests");
    assert.equal(mutation.effortConfigured, true, "MUTATION_EFFORT must reach the appended mutation member");
    assert.equal(mutation.effortPosition, 1);
    assert.ok(effortWireExtras(mutation), "a configured mutation member must carry effort onto the wire");
  } finally {
    if (savedLens === undefined) delete process.env.MUTATION_LENS; else process.env.MUTATION_LENS = savedLens;
    if (savedEffort === undefined) delete process.env.MUTATION_EFFORT; else process.env.MUTATION_EFFORT = savedEffort;
  }
}

console.log("lens effort tests passed");
