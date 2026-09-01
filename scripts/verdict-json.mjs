// Recovering a verdict from a chair reply that is not quite valid JSON: a model
// will emit a raw newline or a stray backslash inside a string. Split out of
// chair-fallback.mjs so neither file exceeds the 300-line budget.

export function truncate(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

const VALID_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const CONTROL_ESCAPE = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
const HEX4 = /^[0-9a-fA-F]{4}/;
// A backslash right before a quote is a genuine `\"` escape only if the string
// keeps going afterward. If what follows is unambiguously the START of the
// NEXT token — end of container (`}`/`]`), a bare `:` (this string was a key),
// or `,` followed by another quoted key and `:` — that quote is the real
// closing quote and the backslash is a stray one, e.g. a Windows path ending
// in `\`. A bare `,` is NOT enough on its own: prose routinely quotes a word
// and continues with a comma ("say \"hi\", and ..."), which is a `\"` mid-string,
// not a closing quote, even though a comma follows it too.
const STRUCTURAL_AFTER_STRING = /^\s*(?:[}\]]|:|,\s*"[^"\\]*"\s*:)/;

export function repairJsonStrings(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      inString = ch === '"';
      out += ch;
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) out += "\\\\";
      else if (next === '"' && STRUCTURAL_AFTER_STRING.test(text.slice(i + 2))) {
        out += "\\\\";
      } else if (next === "u" && !HEX4.test(text.slice(i + 2, i + 6))) {
        // `\u` is only a valid escape when 4 hex digits follow; otherwise it's
        // a path like `C:\users`, and only the backslash is invalid.
        out += "\\\\";
      } else if (VALID_ESCAPE.has(next)) {
        out += ch + next;
        i++;
      } else {
        // Only escape the backslash; leave `next` for the next iteration so a
        // control character right after an invalid escape still gets escaped
        // instead of being copied into the string raw.
        out += "\\\\";
      }
    } else if (ch < " ") {
      out += CONTROL_ESCAPE[ch] || `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

// A model told to emit JSON still sometimes wraps it in a fence or prose. Take
// the outermost braces rather than failing the whole review on formatting.
export function parseVerdict(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error(`no JSON object in chair reply: ${truncate(text, 200)}`);
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    try {
      return JSON.parse(repairJsonStrings(candidate));
    } catch (repairErr) {
      throw new Error(
        `chair reply is not JSON even after repair: ${err.message} (repair attempt: ${repairErr.message})`,
      );
    }
  }
}

// One normalization, used by both the rendered body and the verdict. Two
// call sites normalizing differently is how a parseable reply still throws.
