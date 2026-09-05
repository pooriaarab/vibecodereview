// Parse chair-verdicts.json written by the Claude Code chair. The OpenRouter
// fallback has no Write tool, so a missing file is expected and must not be
// read as "zero findings".

/** @typedef {"confirmed-fixed"|"confirmed-open"|"rejected"|"unmentioned"} ChairDisposition */

/** @typedef {"approve"|"comment"|"request-changes"} ChairVerdict */

export const CHAIR_VERDICTS = new Set(["approve", "comment", "request-changes"]);

export const CHAIR_DISPOSITIONS = new Set([
  "confirmed-fixed",
  "confirmed-open",
  "rejected",
  "unmentioned",
]);

/**
 * @param {unknown} value
 * @returns {value is ChairDisposition}
 */
function isDisposition(value) {
  return typeof value === "string" && CHAIR_DISPOSITIONS.has(value);
}

/**
 * @param {string} raw
 * @returns {{ ok: true, verdict: ChairVerdict, dispositions: { id: string, disposition: ChairDisposition }[] } | { ok: false }}
 */
export function parseChairVerdictsJson(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || ""));
  } catch {
    return { ok: false };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false };
  }
  const verdict = /** @type {ChairVerdict} */ (data.verdict);
  if (!CHAIR_VERDICTS.has(verdict)) {
    return { ok: false };
  }
  if (!Array.isArray(data.dispositions)) {
    return { ok: false };
  }
  const dispositions = [];
  for (const item of data.dispositions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false };
    }
    const id = item.id;
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false };
    }
    if (!isDisposition(item.disposition)) {
      return { ok: false };
    }
    dispositions.push({ id, disposition: item.disposition });
  }
  return { ok: true, verdict, dispositions };
}
