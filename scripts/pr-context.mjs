// Assembling the PR's stated claim and the diff into one prompt is its own
// concern, and keeping it here holds council-review.mjs under the file-size
// budget. There is still exactly one implementation; this is a split, not a
// fork.
import fs from "node:fs";

const CTX_CUT = "\n... (context truncated)";
const HEAD = "===== PR CONTEXT (title, body, linked issue) =====\n";
const FOOT = "\n===== DIFF =====\n";
const FRAME = HEAD.length + FOOT.length;
const MAX_CTX_CHARS = 8000;
// Below this there is too little room for context worth reading, so drop it
// whole rather than ship a framed sliver.
const MIN_CTX_ROOM = 200;

export function prepareDiff(diffText, ctxFile, maxChars) {
  if (!diffText.trim()) return { diff: "", diffTruncated: false, contextTruncated: false };

  let rawCtx = "";
  let contextTruncated = false;
  if (ctxFile && fs.existsSync(ctxFile)) {
    try {
      // The title and body are author-controlled text going verbatim into the
      // prompt, so instruction injection is possible in principle. Three things
      // bound it: the action only runs on the repo owner's own PRs, the system
      // prompt tells every member to treat this as a claim rather than ground
      // truth, and the council's output is advisory. The chair verifies each
      // finding against the code before acting on it. Accepted residual risk.
      rawCtx = fs.readFileSync(ctxFile, "utf8").trim();
      // Slice to leave room for the marker, so the result honours the cap it
      // advertises instead of exceeding it by the marker's own length.
      if (rawCtx.length > MAX_CTX_CHARS) {
        rawCtx = rawCtx.slice(0, MAX_CTX_CHARS - CTX_CUT.length) + CTX_CUT;
        contextTruncated = true;
      }
    } catch {
      // An unreadable context file is a no-op, never an error. Same discipline
      // as a missing API key: the council degrades, it does not fail the PR.
      rawCtx = "";
    }
  }

  // The diff is the evidence; the context is only the author's claim about it.
  // So when the two do not both fit, the context yields first, all the way to
  // nothing. Only rawCtx is ever cut, never the assembled string: slicing that
  // could clip the closing marker and run author text into a diff hunk.
  let ctxText = "";
  if (rawCtx) {
    const room = maxChars - diffText.length - FRAME;
    if (rawCtx.length <= room || room >= MIN_CTX_ROOM) {
      let ctx = rawCtx;
      // Mark this cut too. An unmarked truncation hands the scope lens half a
      // claim and lets it read that as the whole claim, so it can report a
      // mismatch against a sentence that simply stopped early.
      if (ctx.length > room) {
        ctx = ctx.slice(0, Math.max(0, room - CTX_CUT.length)) + CTX_CUT;
        contextTruncated = true;
      }
      ctxText = HEAD + ctx + FOOT;
    } else {
      // No room at all: the context is dropped whole, not merely cut. Still a
      // truncation — the scope lens gets no claim and must be told why.
      contextTruncated = true;
    }
  }
  const diffTruncated = diffText.length > maxChars - ctxText.length;
  const finalDiff = diffText.slice(0, maxChars - ctxText.length);
  return { diff: ctxText + finalDiff, diffTruncated, contextTruncated };
}
