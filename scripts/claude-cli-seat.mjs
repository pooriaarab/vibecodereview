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
    model.model,
    // No tools: the seat needs nothing but the diff on stdin. This also
    // keeps an agentic loop from eating the timeout.
    "--allowed-tools",
    "",
    "--max-turns",
    "1",
    ...(effortRung ? ["--effort", effortRung] : []),
  ];
}

export async function callClaudeCli(model, diff, oauthToken, { instructions, timeoutMs, effortRung }) {
  const { execFile } = await import("node:child_process");
  const os = await import("node:os");
  // Short lens instructions on argv, the diff on stdin. Both forms work —
  // `claude -p` does read a stdin-only prompt — but keeping the diff off argv
  // is what avoids ARGV_MAX at MAX_DIFF_CHARS.
  // Strip every other Anthropic auth source. The CLI PREFERS ANTHROPIC_API_KEY
  // (and the Bedrock/Vertex switches) over a claude.ai login, so a caller that
  // sets one at job level would silently take both seats off their own
  // subscriptions — the precedence hole is invisible from the output.
  //
  // Also strip the unrelated secrets this step's env carries (GH_TOKEN, the
  // other provider API keys). --allowed-tools "" and the os.tmpdir() cwd below
  // already close the known ways a prompt-injected diff could get the CLI to
  // read its env, but the seat never needs these values to do its job — don't
  // leave them reachable as a second line of defense against a bypass in either
  // of those controls.
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
  for (const k of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_OAUTH_TOKEN_2", // a seat must only ever hold its own token
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENROUTER_API_KEY",
    "CUSTOM_API_KEY",
  ]) {
    delete env[k];
  }
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
          // The CLI reports auth failures on STDOUT and exits 1, so stderr is
          // empty exactly when the reason matters most (dead/expired token).
          const why = err.killed
            ? "timed out"
            : String(stderr || stdout || err.message).slice(0, 300);
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
