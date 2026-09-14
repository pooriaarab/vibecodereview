// A Claude subscription seat: there is no OpenAI-compatible URL that accepts a
// Claude Code OAuth token, so this seat shells the Claude Code CLI the action
// already installs for the chair instead of POSTing to a chat endpoint.

// Pulled out so the argv it builds — in particular, whether --effort is
// present at all — can be asserted directly, without stubbing execFile.
export function claudeCliArgs(model, instructions, effortRung) {
  return [
    "-p",
    instructions,
    "--model",
    // Strip an anthropic/ prefix so a leftover OpenRouter id still
    // reaches the CLI as the model name it actually accepts.
    String(model.model || "").replace(/^anthropic\//, ""),
    // No tools: the seat needs nothing but the diff on stdin. This also
    // keeps an agentic loop from eating the timeout.
    "--allowed-tools",
    "",
    "--max-turns",
    "1",
    ...(effortRung ? ["--effort", effortRung] : []),
  ];
}

// Every credential the seat's child process gets, decided in one place.
// `auth` is `{ oauthToken }` (a subscription seat) or `{ apiKey }` (the
// caller's own key, from the `anthropic_api_key` input).
//
// Strip every Anthropic auth source the ambient environment carries, THEN put
// back the one this seat was told to use. The CLI PREFERS ANTHROPIC_API_KEY
// (and the Bedrock/Vertex switches) over a claude.ai login, so a caller who
// sets one at job level would silently take both seats off their own
// subscriptions — the precedence hole is invisible from the output.
//
// The strip still does that job, and now coexists with a supported key path,
// because the two cases are not the same act. A key that arrives as the INPUT
// was put in the workflow on purpose, so it becomes the auth and no seat is
// consumed. A key merely present in the environment was not aimed at this
// action: it is still stripped, and can never arrive here as `auth.apiKey`,
// because the input travels under VCR_ANTHROPIC_API_KEY and nothing reads
// ANTHROPIC_API_KEY back out of the environment.
//
// Also strip the unrelated secrets this step's env carries (GH_TOKEN, the
// other provider API keys). --allowed-tools "" and the os.tmpdir() cwd below
// already close the known ways a prompt-injected diff could get the CLI to
// read its env, but the seat never needs these values to do its job — don't
// leave them reachable as a second line of defense against a bypass in either
// of those controls.
export function seatEnv(baseEnv, auth) {
  const env = { ...baseEnv };
  // A seat must only ever hold its own token. Drop every OAuth slot
  // (unnumbered plus _2, _3, _4, …) before putting this seat's credential
  // in the name the CLI actually reads.
  for (const k of Object.keys(env)) {
    if (k === "CLAUDE_CODE_OAUTH_TOKEN" || k.startsWith("CLAUDE_CODE_OAUTH_TOKEN_")) delete env[k];
  }
  for (const k of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    // The input's own carrier. The CLI does not read this name, and the key is
    // already going in under ANTHROPIC_API_KEY below when it is the auth.
    "VCR_ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENROUTER_API_KEY",
    "CUSTOM_API_KEY",
  ]) {
    delete env[k];
  }
  if (auth.apiKey) env.ANTHROPIC_API_KEY = auth.apiKey;
  else env.CLAUDE_CODE_OAUTH_TOKEN = auth.oauthToken;
  return env;
}

// A failed seat reports what the CLI said, and that text lands in
// council-findings.md, which the chair posts on the pull request. GitHub's log
// mask does not reach a comment body, so the one string that must never
// survive that trip is removed here rather than trusted not to appear.
export function redactCredential(text, credential) {
  return credential ? String(text).split(credential).join("[redacted]") : String(text);
}

export async function callClaudeCli(model, diff, auth, { instructions, timeoutMs, effortRung }) {
  const { execFile } = await import("node:child_process");
  const os = await import("node:os");
  // Short lens instructions on argv, the diff on stdin. Both forms work —
  // `claude -p` does read a stdin-only prompt — but keeping the diff off argv
  // is what avoids ARGV_MAX at MAX_DIFF_CHARS.
  const env = seatEnv(process.env, auth);
  return new Promise((resolve) => {
    const child = execFile(
      "claude",
      claudeCliArgs(model, instructions, effortRung),
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env,
        // NOT the PR checkout. `claude -p` skips the workspace-trust prompt and
        // WILL execute a repo-local .claude/settings.json hook, and this step's
        // env holds every API key plus GH_TOKEN. Running in the untrusted head
        // branch would hand a PR author arbitrary execution with those secrets.
        cwd: os.tmpdir(),
      },
      (err, stdout, stderr) => {
        if (err) {
          // ENOENT means the `claude` binary itself is missing -- the install
          // step did not run, or did not finish, before this seat spawned
          // (VCR-163). That is an infrastructure failure, not a review
          // verdict, and reads as one only if this branch is skipped: the
          // member would otherwise carry a bare "spawn claude ENOENT" string
          // indistinguishable from any other rejected call, and a clean
          // "0 findings" council run would look identical to a council that
          // never ran. Tag it the same way callModelWithFallback already
          // tags an absent key ("skipped: X not set") so a member that never
          // even tried is never confused with one that tried and found
          // nothing -- `infra: true` here is the machine-readable form of
          // that same distinction.
          if (err.code === "ENOENT") {
            return resolve({
              model,
              error: "infra: claude CLI binary not found (spawn ENOENT) -- the install step did not run before this council seat",
              infra: true,
            });
          }
          // The CLI reports auth failures on STDOUT and exits 1, so stderr is
          // empty exactly when the reason matters most (dead/expired token).
          const why = err.killed
            ? "timed out"
            : redactCredential(stderr || stdout || err.message, auth.apiKey || auth.oauthToken).slice(0, 300);
          return resolve({ model, error: why });
        }
        const text = String(stdout || "").trim();
        resolve(text ? { model, text } : { model, error: "empty response" });
      },
    );
    // A pending write to a child killed mid-stream emits EPIPE. Unhandled, that
    // is an uncaughtException that exits non-zero BEFORE the findings file is
    // written — one hung seat would destroy every other seat's review.
    child.stdin?.on("error", () => {});
    child.stdin?.end(diff);
  });
}
