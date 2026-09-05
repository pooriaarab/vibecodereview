#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_MODELS } from "./council-config.mjs";
import {
  decideWeight,
  filterMembersByWeight,
  isHighRiskPath,
  isReviewWeightEnabled,
} from "./review-weight.mjs";

function diffFor(path) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n+change\n`;
}

function lensesOf(members) {
  return members.map((m) => m.lens);
}

assert.equal(isHighRiskPath("src/auth/login.ts"), true, "auth segment is high-risk");
assert.equal(isHighRiskPath("src/author.ts"), false, "author must not match auth");
assert.equal(isHighRiskPath("src/payments/stripe.ts"), true);
assert.equal(isHighRiskPath("db/migrations/001.sql"), true);
assert.equal(isHighRiskPath(".env.production"), true);
assert.equal(isHighRiskPath("src/app.ts"), false);

assert.deepEqual(decideWeight(["style"], ["styles/main.css"]), { weight: "chair", keep: [] });
assert.deepEqual(decideWeight(["docs"], ["README.md"]), { weight: "chair", keep: [] });
assert.deepEqual(decideWeight(["test"], ["tests/app.test.ts"]), {
  weight: "light",
  keep: ["correctness", "maintainability"],
});
assert.deepEqual(decideWeight(["deps"], ["package.json"]), {
  weight: "light",
  keep: ["correctness", "security"],
});
assert.deepEqual(decideWeight(["source"], ["src/app.ts"]), {
  weight: "core",
  keep: ["correctness", "security"],
});
assert.deepEqual(decideWeight(["source"], ["src/auth/login.ts"]), { weight: "full", keep: null });
assert.deepEqual(decideWeight(["ci"], [".github/workflows/ci.yml"]), { weight: "full", keep: null });
assert.deepEqual(decideWeight(["agent"], ["AGENTS.md"]), { weight: "full", keep: null });
assert.deepEqual(decideWeight([], []), { weight: "full", keep: null }, "unparseable fails open");

const roster = structuredClone(DEFAULT_MODELS);

const css = filterMembersByWeight(roster, diffFor("styles/main.css"));
assert.equal(css.weight, "chair");
assert.deepEqual(css.members, []);
assert.ok(css.skippedLenses.includes("performance"));
assert.ok(css.skippedLenses.includes("scope"));

const test = filterMembersByWeight(roster, diffFor("tests/app.test.ts"));
assert.equal(test.weight, "light");
assert.deepEqual(lensesOf(test.members), ["correctness", "maintainability"]);

const src = filterMembersByWeight(roster, diffFor("src/app.ts"));
assert.equal(src.weight, "core");
assert.deepEqual(lensesOf(src.members), ["correctness", "security"]);
assert.ok(src.skippedLenses.includes("performance"));
assert.ok(src.skippedLenses.includes("scope"));

const auth = filterMembersByWeight(roster, diffFor("src/auth/login.ts"));
assert.equal(auth.weight, "full");
assert.deepEqual(lensesOf(auth.members), lensesOf(roster));

const saved = process.env.VCR_REVIEW_WEIGHT;
try {
  delete process.env.VCR_REVIEW_WEIGHT;
  assert.equal(isReviewWeightEnabled(), true, "unset means weight is on");
  process.env.VCR_REVIEW_WEIGHT = "off";
  assert.equal(isReviewWeightEnabled(), false);
  const off = filterMembersByWeight(roster, diffFor("styles/main.css"));
  assert.equal(off.weight, "full");
  assert.deepEqual(off.members, roster);
  assert.deepEqual(off.skippedLenses, []);
} finally {
  if (saved === undefined) delete process.env.VCR_REVIEW_WEIGHT;
  else process.env.VCR_REVIEW_WEIGHT = saved;
}

console.log("review weight tests passed");
