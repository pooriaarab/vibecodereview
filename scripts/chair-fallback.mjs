#!/usr/bin/env node
// Fallback chair. Runs ONLY when every Claude OAuth token has failed.
//
// The primary chair is anthropics/claude-code-action, which can read the repo,
// push fixes, and post inline comments. This one cannot: it is a single
// completion call through OpenRouter with no tools. It sees the diff and the
// council's findings, and it posts ONE summary review. That is deliberately
// less than the real chair — the point is that a subscription outage degrades
// the review instead of deleting it.
//
// Usage: node chair-fallback.mjs <diff-file> <council-findings-file>
// Env: OPENROUTER_API_KEY, GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER,
//      CHAIR_FALLBACK_MODEL (default anthropic/claude-sonnet-5)

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const MAX_DIFF_CHARS = 180_000;
const TIMEOUT_MS = Number(process.env.CHAIR_FALLBACK_TIMEOUT_MS) || 180_000;
const MODEL = process.env.CHAIR_FALLBACK_MODEL || "anthropic/claude-sonnet-5";
const SEVERITIES = { critical: "Critical", major: "Major", minor: "Minor" };

const SYSTEM = `You chair a multi-model code review council. You receive a pull request diff and
the council's per-lens findings. Produce ONE review.

You have NO tools: you cannot open files beyond the diff, run anything, or push
fixes. Judge only what the diff shows. When a council claim depends on code the
diff does not include, say so and drop it rather than guessing.

Rules:
- Each council item is an UNVERIFIED claim. De-dupe them (the same issue from
  several lenses is one issue). Discard a claim if a linter or type-checker
  already covers it, the path is unreachable, it is style or naming, it is
  pre-existing code this diff did not touch, or it names no concrete failure
  trigger.
- Assume the author is competent. Report only diff-introduced defects that have
  a concrete failure trigger.
- Severity: Critical (security, crash, data loss), Major (real bug or
  convention violation), Minor (everything else).

Reply with STRICT JSON and nothing else:
{"verdict":"approve"|"request_changes"|"comment","summary":"<markdown>","findings":[{"severity":"Critical"|"Major"|"Minor","file":"<path>","line":<number|null>,"body":"<markdown>"}]}

Use "request_changes" only when at least one finding is Critical. Use "approve"
when nothing Critical or Major survives. Otherwise "comment".`;

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

async function askChair(diff, council, diffTruncated) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "vibecodereview chair fallback",
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content:
              (diffTruncated ? "NOTE: this diff was truncated for length. Judge only what you can see.\n\n" : "") +
              `PR diff:\n\n${diff}\n\n---\n\nCouncil findings:\n\n${council}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(await res.text().catch(() => ""), 300)}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// A model writing markdown inside a JSON string breaks that string two ways:
// an escape JSON does not define (`\_`, `\*`, a lone backslash copied out of a
// diff or a regex) and a raw newline or tab. Both are recoverable, and losing
// an entire review to one stray backslash is exactly what a fallback exists to
// prevent. Repairs only what is invalid; a well-formed reply is unchanged.
const VALID_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const CONTROL_ESCAPE = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

function repairJsonStrings(text) {
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
      else {
        out += VALID_ESCAPE.has(next) ? ch + next : "\\\\" + next;
        i++;
      }
    } else if (ch < " ") {
      out += CONTROL_ESCAPE[ch] || `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

// A model told to emit JSON still sometimes wraps it in a fence or prose. Take
// the outermost braces rather than failing the whole review on formatting.
function parseVerdict(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`no JSON object in chair reply: ${truncate(text, 200)}`);
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    try {
      return JSON.parse(repairJsonStrings(candidate));
    } catch {
      throw new Error(`chair reply is not JSON even after repair: ${err.message}`);
    }
  }
}

// One normalization, used by both the rendered body and the verdict. Two
// call sites normalizing differently is how a parseable reply still throws.
function normalizeFindings(parsed) {
  const raw = parsed?.findings;
  if (raw === undefined || raw === null) return [];
  // Coercing a malformed shape to [] would silently discard a Critical or
  // Major and let verdictFlag fall through to the model's claimed verdict —
  // exactly the "never approve over a Major" guarantee this file exists to
  // keep. json_object mode guarantees valid JSON, not the instructed schema,
  // so treat a wrong shape as a hard failure rather than an empty review.
  if (!Array.isArray(raw)) throw new Error("chair reply had a malformed `findings` field (expected an array)");
  const bad = raw.filter((f) => !f || typeof f !== "object");
  if (bad.length) throw new Error(`chair reply had ${bad.length} finding(s) that were not objects`);
  // Severity is matched with === below, so "major" would slip past the gate
  // and let a substantive finding fall through to the model's own verdict.
  // Silently mapping an unrecognized severity to "Minor" would let "Critical "
  // (stray whitespace) or "blocker" score as nothing and clear the way for an
  // approve. Every downgrade path in this file is a way to lose a real finding,
  // so trim, then refuse what we do not recognize.
  for (const f of raw) {
    const severity = SEVERITIES[String(f.severity).trim().toLowerCase()];
    if (!severity) throw new Error(`chair reply used an unrecognized severity: ${JSON.stringify(f.severity)}`);
    f.severity = severity;
  }
  return raw;
}

// The model's `verdict` field is advisory; the findings are the evidence. It
// must never approve over a Major, which its own instructions forbid.
function verdictFlag(findings, claimed) {
  if (findings.some((f) => f.severity === "Critical")) return "--request-changes";
  if (findings.some((f) => f.severity === "Major")) return "--comment";
  return claimed === "approve" ? "--approve" : "--comment";
}

function renderBody(parsed, findings, { diffTruncated } = {}) {
  const order = { Critical: 0, Major: 1, Minor: 2 };
  const sorted = findings.toSorted((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  const icon = { Critical: "🔴", Major: "🟠", Minor: "🟡" };
  const lines = [
    "## 🧑‍⚖️ Council review",
    "",
    "> ⚠️ Posted by the **fallback chair**: every Claude subscription token failed, so this",
    "> review came from a single OpenRouter completion with no repo access. It saw the diff",
    "> and the council's findings only — it could not open other files, run anything, or push",
    "> fixes. Treat it as weaker than a normal review.",
    "",
    parsed.summary || "_No summary._",
    "",
  ];
  if (diffTruncated) {
    lines.push("> ⚠️ The diff was truncated for length; this review covers the first portion only.", "");
  }
  if (sorted.length) {
    lines.push("### Findings", "");
    for (const f of sorted) {
      const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
      lines.push(`- ${icon[f.severity] || "⚪"} **${f.severity}** ${where} — ${f.body}`);
    }
    lines.push("");
  }
  lines.push(`<sub>Fallback chair: \`${MODEL}\` via OpenRouter.</sub>`);
  return lines.join("\n");
}

// Offline shape check, no network: node chair-fallback.mjs --selfcheck
function selfcheck() {
  // The reply that lost a whole review on PR #27: markdown underscores escaped
  // the markdown way, which JSON does not define.
  const escaped = parseVerdict(String.raw`{"verdict":"comment","summary":"see \_foo\_ and C:\path","findings":[]}`);
  if (!escaped.summary.includes("foo")) throw new Error("selfcheck: invalid escape not repaired");

  // A raw newline inside a string is the other way a markdown-writing model
  // breaks its own JSON.
  const raw = parseVerdict('{"verdict":"comment","summary":"line one\nline two","findings":[]}');
  if (!raw.summary.includes("line two")) throw new Error("selfcheck: raw control character not repaired");

  // Well-formed JSON must survive untouched — the repair is a fallback, not a
  // rewrite. \n stays a newline; it must not become a literal backslash-n.
  const clean = parseVerdict('{"verdict":"approve","summary":"a\\nb","findings":[]}');
  if (clean.summary !== "a\nb") throw new Error("selfcheck: valid escape was mangled: " + JSON.stringify(clean.summary));

  // Repair is not a licence to accept anything: a truncated object still fails.
  let threw = false;
  try {
    parseVerdict('{"verdict":"comment","summary":');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("selfcheck: malformed JSON was accepted");

  console.log("chair-fallback selfcheck passed");
}

async function main() {
  if (process.argv.includes("--selfcheck")) return selfcheck();
  const [diffFile, councilFile] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY not set");
  if (!repo || !pr) throw new Error("GITHUB_REPOSITORY and PR_NUMBER are required");

  const diff = diffFile && fs.existsSync(diffFile) ? fs.readFileSync(diffFile, "utf8") : "";
  if (!diff.trim()) throw new Error("empty diff");
  const council =
    councilFile && fs.existsSync(councilFile) ? fs.readFileSync(councilFile, "utf8") : "_No council findings._";

  const diffTruncated = diff.length > MAX_DIFF_CHARS;
  const parsed = parseVerdict(await askChair(truncate(diff, MAX_DIFF_CHARS), council, diffTruncated));
  const findings = normalizeFindings(parsed);
  // A syntactically-valid but empty reply ({}) would otherwise post "_No
  // summary._" with no findings and still report the step as a success —
  // a hollow review that looks like a real one. Fail loudly instead, so the
  // gate reports the fallback as failed and the red check means something.
  if (!parsed.summary?.trim() && findings.length === 0) {
    throw new Error("chair reply had neither a summary nor any findings");
  }
  const body = renderBody(parsed, findings, { diffTruncated });
  const flag = verdictFlag(findings, parsed.verdict);

  fs.writeFileSync("chair-fallback-review.md", body);
  const post = (f) =>
    execFileSync("gh", ["pr", "review", String(pr), "--repo", repo, f, "--body-file", "chair-fallback-review.md"], {
      stdio: "inherit",
    });
  try {
    post(flag);
    console.log(`fallback chair posted ${flag} (${findings.length} findings, model ${MODEL})`);
  } catch (err) {
    if (flag === "--comment") throw err;
    // A repo with "Allow GitHub Actions to create and approve pull requests"
    // off cannot --approve or --request-changes. Post the findings as a plain
    // comment either way, so the review is never lost to a permission setting.
    console.log(`${flag} failed (${err?.message || err}); posting as a comment instead`);
    post("--comment");
    // But a downgraded --request-changes must NOT read as a pass: the verdict
    // said Critical, and a green check would silently drop the block.
    if (flag === "--request-changes") {
      throw new Error("posted the review as a comment, but could not request changes on a Critical finding", {
        cause: err,
      });
    }
    console.log(`fallback chair posted --comment (${findings.length} findings, model ${MODEL})`);
  }
}

main().catch((err) => {
  console.error("Fallback chair failed:", err?.message || err);
  process.exit(1);
});
