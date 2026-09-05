#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  EFFORT_ALIASES,
  parseEffortPosition,
  resolveRung,
  rungPosition,
} from "./lens-effort.mjs";
import { LADDERS_FOR_TESTS, offeredRungs } from "./model-effort-ladders.mjs";
import { withLensEffort } from "./lens-effort-config.mjs";
import { buildRequestBody } from "./council-members.mjs";
import { cacheKey } from "./council-cache.mjs";

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

console.log("lens effort tests passed");
