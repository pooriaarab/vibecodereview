// OpenRouter is the cheap leftover route (DeepSeek, GLM, Kimi).
// It is not a back door onto a family that already has a subscription:
// Claude (OAuth seats), Codex (native OpenAI), or Grok (Grok CLI).
// One paid Claude/Grok completion per PR across ~80 repos is how the
// bill quietly doubled. This module is the hard stop.

// Last-resort chair when every OAuth token is dead. Must stay a model
// this policy allows — a Claude or Grok default here is the original leak.
export const DEFAULT_CHAIR_FALLBACK_MODEL = "deepseek/deepseek-v4-flash";

// Cheap OpenRouter ids used when a native key is dead. Never a metered
// copy of Claude, Codex, or Grok.
export const CHEAP_OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";
export const CHEAP_OPENROUTER_MODEL_ALT = "z-ai/glm-5.3-flash";

const CLAUDE_SEAT = /^claude\d*$/;

/** A subscription seat (claude, claude2, claude3, …), not a metered route. */
export function isClaudeSeatProvider(provider) {
  return CLAUDE_SEAT.test(String(provider || ""));
}

function tokens(modelId) {
  return String(modelId || "")
    .trim()
    .toLowerCase()
    .split(/[/:.]+/)
    .filter(Boolean);
}

function isClaudeModel(modelId) {
  return tokens(modelId).some((part) => part === "anthropic" || part === "claude" || part.startsWith("claude-"));
}

function isCodexModel(modelId) {
  return tokens(modelId).some((part) => part === "codex" || part.includes("codex"));
}

function isGrokModel(modelId) {
  return tokens(modelId).some((part) => part === "grok" || part.startsWith("grok-") || part === "x-ai");
}

/**
 * Why this model must not be sent to OpenRouter, or null if it is allowed.
 * Checked before the HTTP call so a banned roster never becomes a bill.
 */
export function bannedOpenRouterReason(modelId) {
  if (isClaudeModel(modelId)) {
    return "OpenRouter must not run Claude models; use a Claude OAuth seat (claude, claude2, claude3, claude4)";
  }
  if (isCodexModel(modelId)) {
    return "OpenRouter must not run Codex models; use the native openai provider";
  }
  if (isGrokModel(modelId)) {
    return "OpenRouter must not run Grok models; use the Grok CLI subscription";
  }
  return null;
}

/** True when this member's HTTP call would hit openrouter.ai. */
export function usesOpenRouterRoute(model, provider) {
  if (model.provider === "openrouter") return true;
  if (model.provider !== "custom") return false;
  const url = String(provider?.url || process.env.CUSTOM_BASE_URL || "");
  return /openrouter\.ai/i.test(url);
}

/**
 * Model the fallback chair will call, or an error string if the configured
 * id is a banned family. An empty override keeps the default.
 */
export function resolveChairFallbackModel(raw = process.env.CHAIR_FALLBACK_MODEL) {
  const model = String(raw || "").trim() || DEFAULT_CHAIR_FALLBACK_MODEL;
  const error = bannedOpenRouterReason(model);
  return error ? { model, error } : { model };
}
