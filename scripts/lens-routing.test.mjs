#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_MODELS } from "./council-config.mjs";
import {
  classifyPath,
  filterMembersByKindRouting,
  isLensRoutingEnabled,
  lensesForKinds,
  routeLenses,
} from "./lens-routing.mjs";

const ALL_LENSES = ["correctness", "performance", "security", "maintainability", "scope"];

function diffFor(path) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n+change\n`;
}

function assertScopePresent(lenses, label) {
  assert.ok(lenses.includes("scope"), `${label}: scope must always be dispatched`);
}

// Lockfile-only: scope + correctness + security; no performance or maintainability.
const lockRoute = routeLenses(diffFor("package-lock.json"));
assert.deepEqual(lockRoute.kinds, ["deps"]);
assert.deepEqual(lockRoute.lenses, ["correctness", "security", "scope"]);
assertScopePresent(lockRoute.lenses, "lockfile-only");

// Docs-only: scope alone.
const docsRoute = routeLenses(diffFor("README.md"));
assert.deepEqual(docsRoute.kinds, ["docs"]);
assert.deepEqual(docsRoute.lenses, ["scope"]);
assertScopePresent(docsRoute.lenses, "docs-only");

// TypeScript source: full council.
const tsRoute = routeLenses(diffFor("src/app.ts"));
assert.deepEqual(tsRoute.kinds, ["source"]);
assert.deepEqual(tsRoute.lenses, ALL_LENSES);
assertScopePresent(tsRoute.lenses, "source");

// Test-only: drops security and performance.
const testRoute = routeLenses(diffFor("tests/app.test.ts"));
assert.deepEqual(testRoute.kinds, ["test"]);
assert.deepEqual(testRoute.lenses, ["correctness", "maintainability", "scope"]);
assertScopePresent(testRoute.lenses, "test-only");

// CSS-only: performance + scope; security dropped.
const cssRoute = routeLenses(diffFor("styles/main.css"));
assert.deepEqual(cssRoute.kinds, ["style"]);
assert.deepEqual(cssRoute.lenses, ["performance", "scope"]);
assertScopePresent(cssRoute.lenses, "css-only");
assert.ok(!cssRoute.lenses.includes("security"), "css-only must drop security");

// Unknown extension is source, not docs.
assert.equal(classifyPath("src/thing.zig"), "source");
const zigRoute = routeLenses(diffFor("src/thing.zig"));
assert.deepEqual(zigRoute.lenses, ALL_LENSES);

// Empty / unparseable diff fails open.
assert.deepEqual(routeLenses("").lenses, ALL_LENSES);
assert.deepEqual(routeLenses("not a git diff").lenses, ALL_LENSES);
assertScopePresent(routeLenses("").lenses, "empty diff");

// lensesForKinds preserves roster order, not alphabetical.
assert.deepEqual(lensesForKinds(["deps"]), ["correctness", "security", "scope"]);

// VCR_LENS_ROUTING=off leaves the roster untouched.
const roster = structuredClone(DEFAULT_MODELS);
const lockDiff = diffFor("package-lock.json");
const savedRouting = process.env.VCR_LENS_ROUTING;
try {
  delete process.env.VCR_LENS_ROUTING;
  assert.equal(isLensRoutingEnabled(), true, "unset env means routing on");
  const on = filterMembersByKindRouting(roster, lockDiff);
  assert.ok(on.members.length < roster.length, "routing on should drop lenses on a lockfile diff");

  process.env.VCR_LENS_ROUTING = "off";
  assert.equal(isLensRoutingEnabled(), false);
  const off = filterMembersByKindRouting(roster, lockDiff);
  assert.deepEqual(off.members, roster);
  assert.deepEqual(off.skippedLenses, []);
} finally {
  if (savedRouting === undefined) delete process.env.VCR_LENS_ROUTING;
  else process.env.VCR_LENS_ROUTING = savedRouting;
}

// A ci path still earns maintainability: a workflow can carry the same missing
// error handling and broken contracts the lens looks for in source.
const ciRoute = routeLenses(diffFor(".github/workflows/build.yml"));
assert.deepEqual(ciRoute.kinds, ["ci"]);
assert.ok(ciRoute.lenses.includes("maintainability"), "ci must keep maintainability");

// COUNCIL_MODELS accepts any lens string. Routing knows only its own table, so
// an unknown lens must survive a diff that routing would otherwise shrink.
const customRoster = [
  { provider: "openrouter", model: "m", name: "Custom", lens: "accessibility" },
  { provider: "openrouter", model: "m", name: "Perf", lens: "performance" },
];
const custom = filterMembersByKindRouting(customRoster, diffFor("package-lock.json"));
assert.deepEqual(custom.members.map((m) => m.lens), ["accessibility"], "an unknown lens must pass through");
assert.deepEqual(custom.skippedLenses, ["performance"], "a known lens is still routed");

// Mutation has its own opt-in gate and is never routed away here.
const withMutation = filterMembersByKindRouting(
  [{ provider: "openrouter", model: "m", name: "Mut", lens: "mutation" }],
  diffFor("README.md"),
);
assert.deepEqual(withMutation.members.map((m) => m.lens), ["mutation"]);
assert.deepEqual(withMutation.skippedLenses, []);

console.log("lens routing tests passed");
