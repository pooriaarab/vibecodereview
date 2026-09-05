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

// Two or more distinct roster lens names inside one parenthesis is an inventory.
const alternation = lenses.join("|");
const offenders = [];
for (const [, inner] of prompt.matchAll(/\(([^()]*)\)/g)) {
  const hits = new Set((inner.match(new RegExp(`\\b(?:${alternation})\\b`, "gi")) || []).map((w) => w.toLowerCase()));
  if (hits.size >= 2) offenders.push(inner.replace(/\s+/g, " ").trim());
}
// ...as is a bare comma/and/or list of them outside parentheses.
for (const [match] of prompt.matchAll(new RegExp(`\\b(?:${alternation})\\b(?:\\s*(?:,|and|or)\\s*\\b(?:${alternation})\\b)+`, "gi"))) {
  offenders.push(match.replace(/\s+/g, " ").trim());
}

assert.deepEqual(
  offenders,
  [],
  `chair prompt names lenses inline; the roster is ${lenses.join(", ")} and the findings file already ` +
    `heads each section with its lens. Drop the list rather than syncing it. Found: ${offenders.join(" | ")}`,
);

console.log("chair prompt tests passed");
