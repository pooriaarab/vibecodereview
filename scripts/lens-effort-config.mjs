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

/** @param {{ lens: string, effortConfigured?: boolean, effortPosition?: number }} model */
export function effortCacheSegment(model) {
  if (!model.effortConfigured || model.effortPosition === undefined) return "";
  return String(model.effortPosition);
}

/** @param {Array<{ lens: string } & Record<string, unknown>>} members */
export function withLensEffort(members) {
  return members.map((member) => {
    const envName = LENS_EFFORT_ENV[member.lens];
    if (!envName) return member;
    const raw = process.env[envName]?.trim();
    if (!raw) return member;
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
