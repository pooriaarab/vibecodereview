#!/usr/bin/env node
// Reads the council engine's run-stats sidecar (VCR_STATS_FILE) and prints
// "<memberCount> <cacheHitFlag>" to stdout. A missing/unreadable/malformed
// sidecar, or one with a non-integer memberCount, degrades to "0 0" -- never
// throws -- so the (continue-on-error) emit step can never fail on this.
// Extracted out of action.yml's inline `node -e` so council-stats.test.mjs
// can drive the exact code the action ships, not a copy of it.
import fs from "node:fs";

function readStats(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const m = Number(s.memberCount);
    if (!Number.isInteger(m) || m < 0) throw new Error("bad memberCount");
    return `${m} ${s.cacheHit === true ? "1" : "0"}`;
  } catch {
    return "0 0";
  }
}

console.log(readStats(process.env.VCR_STATS_FILE));
