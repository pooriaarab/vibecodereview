#!/usr/bin/env node
// The `anthropic_api_key` input, and the strip it has to coexist with.
//
// Two rules are in tension here and both have to hold at once:
//   1. A key the caller passed as the INPUT authenticates the Claude calls.
//   2. A key that is merely sitting in the job environment does not, ever.
// Rule 2 is the regression risk: it is the older rule, it protects somebody
// else's subscription seats from being drained silently, and adding rule 1 is
// exactly the kind of change that quietly deletes it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callClaudeCli } from "./claude-cli-seat.mjs";
import { callModel, hasNativeKey } from "./council-members.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = fs.readFileSync(path.join(root, "action.yml"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

function check(name, fn) {
  fn();
  console.log(`ok    ${name}`);
}

async function checkAsync(name, fn) {
  await fn();
  console.log(`ok    ${name}`);
}

// --- the opt-in path --------------------------------------------------------

await checkAsync("a Claude seat with neither credential still skips, unchanged", async () => {
  const saved = {
    token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    key: process.env.VCR_ANTHROPIC_API_KEY,
  };
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.VCR_ANTHROPIC_API_KEY;
  try {
    const r = await callModel({ provider: "claude", model: "x", name: "X", lens: "correctness" }, "d");
    assert.match(r.error, /skipped: CLAUDE_CODE_OAUTH_TOKEN not set/);
  } finally {
    if (saved.token !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.token;
    if (saved.key !== undefined) process.env.VCR_ANTHROPIC_API_KEY = saved.key;
  }
});

// --- both rules, observed in the real child process -------------------------
//
// What the spawned CLI actually receives is what decides whose account pays,
// so assert on that and not only on the object seatEnv returns. A stub named
// `claude` on PATH reports the Anthropic variables it was handed, so the check
// needs no network and no key.
async function spawnedSeatEnv(ambient, auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-seat-"));
  const saved = { ...process.env };
  try {
    const stub = path.join(dir, "claude");
    fs.writeFileSync(stub, "#!/usr/bin/env bash\ncat >/dev/null\nenv | grep -E '^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|VCR_ANTHROPIC_)' || true\n");
    fs.chmodSync(stub, 0o755);
    Object.assign(process.env, ambient, { PATH: `${dir}:${process.env.PATH}` });
    const r = await callClaudeCli({ model: "claude-sonnet-5" }, "a diff", auth, {
      instructions: "review",
      timeoutMs: 20_000,
    });
    assert.equal(r.error, undefined, `the stub CLI did not run: ${r.error}`);
    return Object.fromEntries(r.text.split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const AMBIENT_AUTH = {
  ANTHROPIC_API_KEY: "sk-ant-stray",
  ANTHROPIC_AUTH_TOKEN: "stray",
  ANTHROPIC_BASE_URL: "https://stray.example",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth",
};

await checkAsync("no job-level Anthropic auth source reaches the CLI", async () => {
  const seen = await spawnedSeatEnv(AMBIENT_AUTH, { oauthToken: "oauth-1" });
  // The CLI prefers every one of these over a claude.ai login, so one left in
  // the environment would spend a subscription seat nobody offered.
  for (const k of Object.keys(AMBIENT_AUTH)) {
    if (k !== "CLAUDE_CODE_OAUTH_TOKEN") assert.equal(seen[k], undefined, `${k} reached the CLI`);
  }
  // The seat gets its OWN token, never the one lying in the environment.
  assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, "oauth-1");
});

await checkAsync("the spawned CLI gets the input's key and no seat token", async () => {
  const seen = await spawnedSeatEnv(
    { ...AMBIENT_AUTH, VCR_ANTHROPIC_API_KEY: "sk-ant-input" },
    { apiKey: "sk-ant-input" },
  );
  assert.equal(seen.ANTHROPIC_API_KEY, "sk-ant-input");
  assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  // The carrier is not a name the CLI reads, so it is a secret with no job
  // left to do inside the child.
  assert.equal(seen.VCR_ANTHROPIC_API_KEY, undefined);
});

await checkAsync("a failing seat does not carry its key into the findings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-seat-"));
  const saved = { ...process.env };
  try {
    const stub = path.join(dir, "claude");
    // The shape that matters: the CLI reports auth failures on stdout and
    // exits 1, so the failure text is what gets read back and reported.
    fs.writeFileSync(stub, '#!/usr/bin/env bash\ncat >/dev/null\necho "401 bad key $ANTHROPIC_API_KEY"\nexit 1\n');
    fs.chmodSync(stub, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    const r = await callClaudeCli({ model: "claude-sonnet-5" }, "d", { apiKey: "sk-ant-secret" }, {
      instructions: "review",
      timeoutMs: 20_000,
    });
    // council-findings.md renders this string, and the chair posts that file.
    assert.doesNotMatch(r.error, /sk-ant-secret/);
    assert.match(r.error, /\[redacted]/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("the input credentials a seat for the no-keys gate as well", () => {
  // Found by running the engine, not by reading it: the gate that decides
  // whether any member can be served read only the OAuth slot, so a key-only
  // run wrote "Council skipped: no provider keys set" and reviewed nothing.
  const savedOpenai = process.env.OPENAI_API_KEY;
  process.env.VCR_ANTHROPIC_API_KEY = "sk-ant-input";
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(hasNativeKey({ provider: "claude" }), true);
    // An Anthropic key credentials Anthropic seats and nothing else.
    assert.equal(hasNativeKey({ provider: "openai" }), false);
  } finally {
    delete process.env.VCR_ANTHROPIC_API_KEY;
    if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
  }
});

// --- the wiring in action.yml ----------------------------------------------

check("action.yml declares the input", () => {
  assert.match(action, /^ {2}anthropic_api_key:$/m);
});

check("the council fan-out gets the key under its own name, not ANTHROPIC_API_KEY", () => {
  assert.match(action, /VCR_ANTHROPIC_API_KEY: \$\{\{ inputs\.anthropic_api_key \}\}/);
  // Setting ANTHROPIC_API_KEY on a step would be stripped by every seat and
  // would read, to the next person, as the supported way to do this.
  assert.doesNotMatch(action, /^\s+ANTHROPIC_API_KEY: /m);
});

check("the seat probe is skipped rather than run and discarded", () => {
  const probe = /- name: Probe chair tokens\n(?: .*\n)*?\s+if: (.*)\n/.exec(action);
  assert.ok(probe, "the probe step lost its `if:`");
  assert.match(probe[1], /inputs\.anthropic_api_key == ''/);
});

check("the API-key chair exists and authenticates with the key alone", () => {
  const step = action.slice(action.indexOf("- name: Chair review (Anthropic API key)"));
  const body = step.slice(0, step.indexOf("- name: Chair review (primary token)"));
  assert.match(body, /id: chair_api_key/);
  assert.match(body, /if: .*inputs\.anthropic_api_key != ''/);
  assert.match(body, /anthropic_api_key: \$\{\{ inputs\.anthropic_api_key \}\}/);
  // Passing both would hand the precedence decision to claude-code-action,
  // which is the invisible precedence this whole change exists to remove.
  assert.doesNotMatch(body, /claude_code_oauth_token:/);
});

check("every OAuth chair attempt stands down when the key is set", () => {
  for (const id of ["chair_primary", "chair_backup", "chair_third", "chair_fourth"]) {
    const step = new RegExp(`id: ${id}\\n\\s+if: (.*)\\n`).exec(action);
    assert.ok(step, `${id} lost its \`if:\``);
    assert.match(step[1], /inputs\.anthropic_api_key == ''/, `${id} still runs with a key set`);
  }
});

check("a successful API-key chair is not undone by the later cleanups", () => {
  // Each `rm -f "$VCR_CHAIR_VERDICTS"` clears a verdict file before the next
  // attempt. The API-key chair runs first, so a cleanup that ignores it would
  // delete the verdicts of the run that actually posted.
  const cleanups = action
    .split(/- name: Clear stale chair-verdicts\.json/)
    .slice(1)
    .map((s) => s.slice(0, s.indexOf("run: rm -f")));
  assert.equal(cleanups.length, 4, "expected four verdict cleanups");
  for (const c of cleanups) {
    assert.ok(
      /inputs\.anthropic_api_key == ''/.test(c) || /chair_api_key\.outcome != 'success'/.test(c),
      "a verdict cleanup can run after a successful API-key chair",
    );
  }
});

check("the OpenRouter fallback never runs on the API-key path", () => {
  // A rejected key must read as a red check, not as a review posted by a
  // model from a vendor the caller pinned the chair away from.
  const at = action.indexOf("id: chair_fallback");
  const step = action.slice(at, action.indexOf("continue-on-error", at));
  assert.match(step, /inputs\.anthropic_api_key == ''/);
  assert.match(step, /steps\.chair_api_key\.outcome != 'success'/);
});

check("the run says which auth it chose", () => {
  assert.match(action, /- name: Resolve Claude auth/);
  assert.match(action, /claude auth: anthropic_api_key/);
  assert.match(action, /claude auth: OAuth seat rotation/);
  // The value is a secret even when it does not arrive from `secrets.*`.
  assert.match(action, /printf '::add-mask::%s\\n' "\$VCR_KEY"/);
});

check("README documents the input", () => {
  assert.match(readme, /anthropic_api_key/);
  assert.match(readme, /### An Anthropic API key instead of seats/);
});

console.log("anthropic-key-auth tests passed");
