#!/usr/bin/env node
// Decide whether this pull request edits the workflow file that invoked the
// action.
//
// anthropics/claude-code-action gets its GitHub token by exchanging an OIDC
// token for an Anthropic GitHub App token, and that exchange is refused when
// the invoking workflow file differs from the copy on the default branch. The
// control is right — a pull request must not edit the reviewer that judges it
// — but upstream treats the refusal as a SKIP, not an error: `token.ts` raises
// `WorkflowValidationSkipError`, `run.ts` catches it and returns normally, and
// the step exits 0 having reviewed nothing.
//
// action.yml decides failover from `steps.chair_*.outcome`, so that self-skip
// reads as a success and every later chair is skipped. The chair result gate
// then catches the empty result and fails the check — correctly, but with no
// review, which is how alongside #300, #314, #333, #343 and #378 were all
// merged over a red check.
//
// Upstream does set a `skipped_due_to_workflow_validation_mismatch` output,
// but does not re-export it from its composite `outputs:` block, so a caller
// cannot read it after the fact. Detect the condition up front instead, and
// hand those chairs a token that needs no exchange.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { diffPaths } from "./review-delta.mjs";

// `github.workflow_ref` is `owner/repo/.github/workflows/name.yml@refs/...`.
// Strip the git ref, then the `owner/repo/` prefix, and what is left is the
// repository-relative path of the workflow that is running.
//
// Split on `@refs/`, not on `@`. Both halves can carry an `@`: a workflow file
// may be named `review@v2.yml`, and a branch may be named `feature@2`. Cutting
// at the first `@` truncates the path, cutting at the last one eats the
// filename when the branch carries it, and either way the path stops matching,
// `self_edit` reads false, and the chair goes back to self-skipping in silence
// — this bug wearing the costume of its own fix. The ref half of
// `workflow_ref` is always a FULL ref, so `@refs/` is an anchor neither half
// can forge: a path segment cannot contain `/`.
export function workflowPathFromRef(ref) {
  const value = String(ref ?? "");
  const separator = value.lastIndexOf("@refs/");
  const withoutRef = separator === -1 ? value : value.slice(0, separator);
  if (!withoutRef) return "";
  const parts = withoutRef.split("/");
  // owner + repo + at least one path segment.
  if (parts.length < 3) return "";
  return parts.slice(2).join("/");
}

// The diff, not the file content, is what decides. A `pull_request` run
// executes the MERGE of head into base, so a workflow file this pull request
// leaves alone always matches the default branch even when the branch is
// behind. Only a path this pull request actually touches can differ.
export function selfEditsWorkflow(diff, workflowRef) {
  const path = workflowPathFromRef(workflowRef);
  if (!path) return false;
  return diffPaths(diff).includes(path);
}

export function selfEditsWorkflowFile(diffFile, workflowRef) {
  let diff = "";
  try {
    diff = fs.readFileSync(diffFile, "utf8");
  } catch {
    // No diff on disk means no evidence of a self-edit. Answering "false"
    // keeps the OIDC path, which is the identity the fleet's budget counter
    // reads; a wrong "true" would silently re-attribute every review.
    return false;
  }
  return selfEditsWorkflow(diff, workflowRef);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const diffFile = process.argv[2] || "pr.diff";
  process.stdout.write(
    selfEditsWorkflowFile(diffFile, process.env.GITHUB_WORKFLOW_REF) ? "true" : "false",
  );
}
