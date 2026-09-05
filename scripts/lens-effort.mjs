/**
 * Reasoning effort, stored as a POSITION rather than a name.
 *
 * A rung name is only meaningful inside the model that published it: `high` is
 * one model's floor and another's midpoint, and a model is free to call its rungs
 * anything at all. So a stored name is untransferable the moment the model
 * changes underneath the setting — which happens without anyone editing it when
 * OPENAI_MODEL / GEMINI_MODEL / SCOPE_MODEL / MUTATION_MODEL / COUNCIL_MODELS
 * repoint a lens's model.
 *
 * A position on [0, 1] has no such problem: 0 is whatever that model calls its
 * cheapest rung and 1 is whatever it calls its most expensive. Resolution is a
 * lookup into the model's own published ladder, so the result is always a rung
 * that model actually offers. An invalid effort is unrepresentable rather than
 * merely guarded against.
 */

/** @typedef {number} EffortPosition */

/** @type {EffortPosition} */
export const DEFAULT_EFFORT_POSITION = 0.5;

/** @type {Readonly<Record<string, EffortPosition>>} */
export const EFFORT_ALIASES = {
  low: 0,
  medium: 0.25,
  high: 0.5,
  xhigh: 0.75,
  max: 1,
};

/** @type {Readonly<Set<string>>} */
const DISABLING_RUNGS = new Set(["none", "minimal"]);

/** @param {number} value */
export function isEffortPosition(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * @param {string} raw
 * @returns {EffortPosition | undefined}
 */
export function parseEffortPosition(raw) {
  const normalized = raw.trim().toLowerCase();
  // Object.hasOwn, not a bare lookup: `constructor` and `__proto__` survive
  // toLowerCase unchanged and resolve to inherited prototype members, so a bare
  // index returns the Object constructor rather than undefined. The member is
  // then marked configured with a non-numeric position, resolveRung coerces it
  // to NaN, and the effort is dropped SILENTLY — the one outcome this module
  // exists to prevent.
  const key = normalized === "med" ? "medium" : normalized;
  const named = Object.hasOwn(EFFORT_ALIASES, key) ? EFFORT_ALIASES[key] : undefined;
  if (named !== undefined) return named;
  const numeric = Number(normalized);
  return normalized !== "" && isEffortPosition(numeric) ? numeric : undefined;
}

/** @param {readonly string[]} published */
export function offeredRungs(published) {
  return published.filter((rung) => !DISABLING_RUNGS.has(rung));
}

/**
 * @param {{ position: EffortPosition, published: readonly string[] }} params
 * @returns {string | undefined}
 */
export function resolveRung(params) {
  const rungs = offeredRungs(params.published);
  if (rungs.length === 0) return undefined;
  const clamped = Math.min(1, Math.max(0, params.position));
  return rungs[Math.floor(clamped * (rungs.length - 1))];
}

/**
 * @param {{ rung: string, published: readonly string[] }} params
 * @returns {EffortPosition | undefined}
 */
export function rungPosition(params) {
  const rungs = offeredRungs(params.published);
  const index = rungs.indexOf(params.rung);
  if (index === -1) return undefined;
  return rungs.length > 1 ? index / (rungs.length - 1) : 0;
}
