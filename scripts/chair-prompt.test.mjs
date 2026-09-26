#!/usr/bin/env node
// The chair prompt must not carry a hand-typed lens inventory. The roster is
// data (DEFAULT_MODELS), the findings file names each lens in its own heading,
// and a third copy in the prompt prose drifts from both — which is exactly what
// happened: it listed four lenses while five ran, omitting `scope`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS } from "./council-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const actionYml = readFileSync(`${here}/../action.yml`, "utf8");

const OPEN = "<<'VCR_PROMPT_EOF'\n";
const openAt = actionYml.indexOf(OPEN);
assert.notEqual(openAt, -1, "chair prompt heredoc opener not found in action.yml");

// Search for the terminator AFTER the opening delimiter ends, not after its
// first character: the opener contains the marker itself, so starting at
// openAt + 1 finds that same marker and yields an EMPTY prompt — a guard that
// silently scans nothing and can never fail.
const bodyAt = openAt + OPEN.length;
const closeAt = actionYml.indexOf("VCR_PROMPT_EOF", bodyAt);
assert.notEqual(closeAt, -1, "chair prompt heredoc terminator not found");

const prompt = actionYml.slice(bodyAt, closeAt);
assert.ok(prompt.length > 1000, `extracted prompt implausibly short (${prompt.length} chars) — the slice is wrong, not the prompt`);

const lenses = [...new Set(DEFAULT_MODELS.map((m) => m.lens))];
assert.ok(lenses.length >= 2, "roster must have at least two lenses for this guard to mean anything");

// An inventory is TWO OR MORE DISTINCT roster lens names anywhere in the prompt.
//
// Earlier versions of this guard enumerated the separator between them — first
// `,`/and/or, then `/ ; | - – — • *`. Each widening was prompted by a reviewer
// naming one more separator that slipped through, and `&` slipped through the
// second one. Enumerating separators is unwinnable: the defect is the writer
// re-typing the roster, and the punctuation between the words is incidental to
// it. Counting distinct names has no separator to miss, and no formatting
// (parentheses, a bullet list, a table row, prose) to special-case.
//
// One name is allowed, so the prompt can still refer to a single lens if it
// ever needs to. Two is the point at which prose becomes a list.
const alternation = lenses.join("|");
const named = [
  ...new Set(
    (prompt.match(new RegExp(`\\b(?:${alternation})\\b`, "gi")) || []).map((w) => w.toLowerCase()),
  ),
];

assert.ok(
  named.length < 2,
  `chair prompt names ${named.length} lenses (${named.join(", ")}); the roster is ` +
    `${lenses.join(", ")} and the findings file already heads each section with its lens. ` +
    `Drop the list rather than syncing it — syncing postpones the drift instead of removing it.`,
);

// LOOP GUARD must not tie can_push=false to a comment-only verdict. Step 6 owns
// disposition; the guard only blocks git pushes (issue #192, yaya run 36235965506).
const loopGuard = prompt.match(/LOOP GUARD:[^\n]+/);
assert.ok(loopGuard, "LOOP GUARD line missing from chair prompt");
assert.match(
  loopGuard[0],
  /skip step 5/i,
  "LOOP GUARD must tell the chair to skip pushes, not to pick a review disposition",
);
assert.doesNotMatch(
  loopGuard[0],
  /comment only/i,
  "LOOP GUARD must not instruct comment-only reviews when pushes are disabled",
);
assert.match(
  prompt,
  /step 6.*--approve/is,
  "chair prompt must still document step 6 --approve after LOOP GUARD",
);

console.log("chair prompt tests passed");
