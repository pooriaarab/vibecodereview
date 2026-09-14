#!/usr/bin/env node
// Whether the resolved council roster contains at least one CLI-backed
// provider (claude*). Read from COUNCIL_MODELS alone -- no diff needed -- so
// action.yml can call this before the council fan-out and only pay the
// serial install cost when a CLI seat is actually in the roster. See
// scripts/council-order.test.mjs for the ordering this exists to keep, and
// the "Install Claude Code CLI (CLI council seats)" step in action.yml for
// the caller.
//
// Reuses parseModels()/PROVIDERS rather than re-parsing COUNCIL_MODELS, so
// this can never drift from what the council itself resolves the roster to.
import { PROVIDERS } from "./council-config.mjs";
import { parseModels } from "./council-members.mjs";

export function rosterHasCli(models) {
  return models.some((m) => PROVIDERS[m.provider]?.cli === true);
}

console.log(rosterHasCli(parseModels()) ? "true" : "false");
