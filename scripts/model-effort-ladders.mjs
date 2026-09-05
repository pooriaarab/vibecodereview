// Published reasoning-effort ladders for council models. Ascending order only —
// the array IS the scale. Match rules are checked in order; first hit wins.

import { offeredRungs, resolveRung } from "./lens-effort.mjs";

const GPT_LADDER = ["none", "low", "medium", "high", "xhigh", "max"];
const GEMINI_LADDER = ["low", "medium", "high"];
const KIMI_K3_LADDER = ["low", "high", "max"];
const GROK_LADDER = ["low", "medium", "high"];
const CLAUDE_LADDER = ["low", "medium", "high", "xhigh", "max"];

/** @type {ReadonlyArray<{ test: (id: string) => boolean, direct: readonly string[], openrouter?: readonly string[] }>} */
const LADDER_RULES = [
  { test: (id) => id.includes("gpt-5.6") || id === "gpt-5.6", direct: GPT_LADDER, openrouter: GPT_LADDER },
  { test: (id) => id.includes("gemini-3.1-pro"), direct: GEMINI_LADDER, openrouter: GEMINI_LADDER },
  { test: (id) => id.includes("kimi-k3"), direct: KIMI_K3_LADDER, openrouter: KIMI_K3_LADDER },
  { test: (id) => id.includes("grok-4"), direct: GROK_LADDER, openrouter: GROK_LADDER },
  {
    test: (id) => id.includes("claude-sonnet") || id.includes("claude-opus") || id.includes("claude-fable"),
    direct: CLAUDE_LADDER,
    openrouter: CLAUDE_LADDER,
  },
];

/** @param {{ provider: string, model: string }} member */
function useOpenRouterRoute(member) {
  return member.provider === "openrouter";
}

/**
 * @param {{ provider: string, model: string }} member
 * @returns {readonly string[] | undefined}
 */
export function publishedLadder(member) {
  const id = String(member.model || "").toLowerCase();
  for (const rule of LADDER_RULES) {
    if (!rule.test(id)) continue;
    if (useOpenRouterRoute(member)) return rule.openrouter ?? rule.direct;
    return rule.direct;
  }
  return undefined;
}

/** @param {{ provider: string, model: string, effortPosition?: number, effortConfigured?: boolean }} member */
export function resolveMemberRung(member) {
  if (!member.effortConfigured || member.effortPosition === undefined) return undefined;
  const published = publishedLadder(member);
  if (!published) return undefined;
  return resolveRung({ position: member.effortPosition, published });
}

/** @type {ReadonlyArray<{ name: string, published: readonly string[] }>} */
export const LADDERS_FOR_TESTS = [
  { name: "gpt-5.6", published: GPT_LADDER },
  { name: "gemini-3.1-pro", published: GEMINI_LADDER },
  { name: "kimi-k3", published: KIMI_K3_LADDER },
  { name: "grok-4.5", published: GROK_LADDER },
  { name: "claude-sonnet-5", published: CLAUDE_LADDER },
];

export { offeredRungs };
