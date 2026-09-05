// Per-lens effort positions from env, plus wire-format resolution at call time.

import { parseEffortPosition } from "./lens-effort.mjs";
import { publishedLadder, resolveMemberRung } from "./model-effort-ladders.mjs";

/** @type {Readonly<Record<string, string>>} */
export const LENS_EFFORT_ENV = {
  correctness: "CORRECTNESS_EFFORT",
  performance: "PERFORMANCE_EFFORT",
  security: "SECURITY_EFFORT",
  maintainability: "MAINTAINABILITY_EFFORT",
  scope: "SCOPE_EFFORT",
  mutation: "MUTATION_EFFORT",
};

/** @param {{ lens: string, effortConfigured?: boolean, effortPosition?: number, effortParseError?: string }} model */
export function effortCacheSegment(model) {
  // An invalid *_EFFORT must never key the same as unset — a stale cache hit
  // would return the old cached completion and callModel's effortParseError
  // check (which surfaces the typo) would never run.
  if (model.effortParseError) return `error:${model.effortParseError}`;
  if (!model.effortConfigured || model.effortPosition === undefined) return "";
  return String(model.effortPosition);
}

/** @param {Array<{ lens: string } & Record<string, unknown>>} members */
export function withLensEffort(members) {
  return members.map((member) => {
    const envName = LENS_EFFORT_ENV[member.lens];
    if (!envName) return member;
    const value = process.env[envName];
    if (value === undefined) return member;
    const raw = value.trim();
    if (raw === "") {
      return { ...member, effortParseError: `invalid ${envName}: (empty)` };
    }
    const position = parseEffortPosition(raw);
    if (position === undefined) {
      return { ...member, effortParseError: `invalid ${envName}: ${raw}` };
    }
    return { ...member, effortConfigured: true, effortPosition: position };
  });
}

/**
 * Provider-specific wire extras. Returns null when effort is unset or this route
 * has no documented effort parameter — the request body stays unchanged.
 *
 * @param {{ provider: string, model: string, effortConfigured?: boolean, effortPosition?: number }} model
 * @returns {Record<string, unknown> | null}
 */
export function effortWireExtras(model) {
  const rung = resolveMemberRung(model);
  if (!rung) return null;
  if (model.provider === "openrouter") return { reasoning: { effort: rung } };
  if (model.provider === "openai" || model.provider === "gemini" || model.provider === "moonshot") {
    return { reasoning_effort: rung };
  }
  return null;
}

/** @param {{ provider: string, model: string, effortConfigured?: boolean, effortPosition?: number }} model */
export function cliEffortRung(model) {
  if (model.provider !== "claude" && model.provider !== "claude2") return undefined;
  if (!publishedLadder(model)) return undefined;
  return resolveMemberRung(model);
}
