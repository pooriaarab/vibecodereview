// The council's configuration: which providers exist, which lens each member
// reviews through, and where to reroute a member whose native key is dead.
// This is data, and keeping it beside the engine pushed council-review.mjs past
// its file-size budget. One definition still, imported by the one engine.
export const PROVIDERS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY" },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyEnv: "GEMINI_API_KEY",
  },
  moonshot: { url: "https://api.moonshot.ai/v1/chat/completions", keyEnv: "MOONSHOT_API_KEY" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY" },
  // Generic OpenAI-compatible endpoint (OpenRouter, self-hosted proxy, local
  // OffRouter). URL comes from env at call time; unset means the member skips.
  custom: { url: process.env.CUSTOM_BASE_URL, keyEnv: "CUSTOM_API_KEY" },
};

// Diverse lenses so each model catches what the others miss.
export const LENSES = {
  correctness:
    "logic bugs, incorrect conditionals, off-by-one, unhandled edge cases, race conditions, and SILENT FAILURES (swallowed errors, empty catch, fallbacks that hide real errors)",
  performance:
    "performance and efficiency: N+1 queries, unindexed/full-table scans, unnecessary re-renders, blocking I/O, memory blowups, and weak type design (types that allow invalid states)",
  security:
    "security (OWASP-aligned): broken authz/authn, tenant isolation gaps, injection, SSRF, secret exposure, unsafe redirects, and missing server-side input validation",
  maintainability:
    "maintainability and data integrity: dead/duplicated code, migration and data-loss risks, wrong or missing error handling, missing input validation, and broken API contracts",
  scope:
    "scope and atomicity: the diff doing more than one thing (a fix plus a refactor plus a rename), changes with no connection to the stated purpose of the PR, opportunistic edits to files the stated change did not require, or a stated purpose the diff does not actually accomplish. Do NOT report bugs, performance, security, or style (other members cover those).",
};

// A native provider key that is present but out of credit answers in well under
// a second with 401/402/429 — the member simply vanishes from the council and
// the chair reviews alone. Measured on 2026-08-27: on 47 of the 48 repos running
// this action, three of the four default members were 429-ing (OpenAI
// `insufficient_quota`, Gemini monthly spend cap, Moonshot suspended balance),
// so the "council" was one model. OpenRouter fronts all of these vendors, so a
// single funded key can carry every lens. Map each native model to its
// OpenRouter id and retry there when the native call fails on auth or quota.
export const OPENROUTER_EQUIVALENT = {
  "gpt-5.6": "openai/gpt-5.6",
  "gpt-5.6-terra-pro": "openai/gpt-5.6-terra-pro",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "kimi-k3": "moonshotai/kimi-k3",
};

// Statuses that mean "this key will not work today", as opposed to a transient
// server fault. Retrying the SAME key on these is pointless; a different route
// is the only thing that can help.
export const CREDENTIAL_FAILURE_STATUSES = [401, 402, 403, 429];

export function openRouterFallbackFor(model) {
  if (model.provider === "openrouter") return null;
  if (!process.env.OPENROUTER_API_KEY?.trim()) return null;
  const mapped = OPENROUTER_EQUIVALENT[model.model] || (model.model.includes("/") ? model.model : null);
  if (!mapped) return null;
  return { ...model, provider: "openrouter", model: mapped };
}

export const DEFAULT_MODELS = [
  { provider: "openai", model: process.env.OPENAI_MODEL || "gpt-5.6", name: "GPT-5.6 (Codex)", lens: "correctness" },
  { provider: "gemini", model: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview", name: "Gemini 3 Pro", lens: "performance" },
  { provider: "moonshot", model: process.env.MOONSHOT_MODEL || "kimi-k3", name: "Kimi K3", lens: "security" },
  { provider: "openrouter", model: process.env.OPENROUTER_MODEL || "x-ai/grok-4.5", name: "Grok 4.5", lens: "maintainability" },
  // Scope rides OpenRouter, not the native OpenAI key that `correctness`
  // already uses. Two lenses behind one key means one `insufficient_quota`
  // takes out both, and on 2026-08-27 that key was 429-ing on 47 of the 48
  // repos running this action. Its own SCOPE_MODEL override keeps a change
  // here from silently re-pointing the correctness member too.
  { provider: "openrouter", model: process.env.SCOPE_MODEL || "openai/gpt-5.6", name: "GPT-5.6 (scope)", lens: "scope" },
];
