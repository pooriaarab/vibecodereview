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
  mutation:
    "whether the tests in this diff can fail at all. For EACH test added or changed, name ONE concrete mutation to the NON-TEST code it covers that the test must catch. Write every finding as `<test path:line> -- <mutation path:line> -- replace <before> with <after>`. Without the test's own location the chair cannot tell which test the mutation is supposed to break, and cannot check the claim. Report a finding only when the test would still pass after that mutation, or when it asserts something the code cannot get wrong: the test and the code share the same helper so they agree regardless, the assertion restates the implementation, the fixture never reaches the code path, or a value is compared against itself. Also report a test that can only fail by hanging or by timing out, since in CI that is a job timeout rather than a red. Do NOT report missing coverage in general, and do NOT report bugs, performance, security or style (other members cover those)",
  scope:
    "scope and atomicity: the diff doing more than one thing (a fix plus a refactor plus a rename), changes with no connection to the stated purpose of the PR, opportunistic edits to files the stated change did not require, or a stated purpose the diff does not actually accomplish." +
    // Evidence lives in the PR body, which this member already receives as
    // context, so it costs nothing to judge here. A repo where no change is
    // ever visible sets REQUIRE_PROOF=false and drops the clause rather than
    // collecting findings its author can never satisfy.
    (process.env.REQUIRE_PROOF === "false"
      ? ""
      : " ALSO judge the evidence in the body: a visible change with no before/after screenshot, an embedded screenshot of a screen this diff does not touch, a named command with no result, evidence that leaves a code path this PR changes untested or that predates the newest commit touching a path it exercises, or a `Proof: n/a` reason that does not hold.") +
    " Do NOT report bugs, performance, security, or style (other members cover those).",
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

// Test files whose ADDED lines make a mutation review worth paying for. The
// lens has nothing to say about a diff that adds no test, so a docs-only or
// config-only pull request should not dispatch it at all.
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+$/i;

// Java/Kotlin/Scala name a test by suffix, not separator: `FooTest.java`,
// `BarSpec.scala`. Case-sensitive on purpose -- TEST_PATH is `/i`, and folding
// case here would make a lowercase "test" fused inside an unrelated word (e.g.
// `Latest.js`) match too. Requiring the capitalized suffix rules that out.
const CONVENTIONAL_TEST_SUFFIX = /(Test|Tests|Spec|Specs)\.[A-Za-z0-9]+$/;

function isTestPath(path) {
  return TEST_PATH.test(path) || CONVENTIONAL_TEST_SUFFIX.test(path);
}

// Read the `+++ b/<path>` headers, not every `+` line: a hunk body line that
// happens to start with "+" is content, not a filename, and matching those
// would enable the lens on any diff that adds a line beginning with a plus.
//
// A "+++ " header is only trusted immediately after its paired "--- " header --
// never on its own. Unified diff always emits them as a pair, so this is a safe
// anchor; without it, an ADDED source line that itself starts with "++ "
// (e.g. a bare `++ counter;` statement) becomes "+++ counter;" once prefixed
// by the diff and would be misread as a new file header, resetting
// `inTestFile` and silently hiding the real test lines that follow.
export function diffAddsTestLines(diff) {
  let inTestFile = false;
  let afterMinusHeader = false;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      afterMinusHeader = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      afterMinusHeader = true;
      continue;
    }
    if (afterMinusHeader && line.startsWith("+++ ")) {
      afterMinusHeader = false;
      const path = line.slice(4).replace(/^b\//, "").trim();
      inTestFile = path !== "/dev/null" && isTestPath(path);
      continue;
    }
    afterMinusHeader = false;
    if (inTestFile && line.startsWith("+")) return true;
  }
  return false;
}

// Opt-in, and never a default member. Naming the mutation is cheap; running it
// is not, and this lens is the front half of something that will get expensive
// once it applies what it proposes. It ships off so that turning it on is a
// decision somebody made rather than a cost that arrived.
//
// It rides OpenRouter with its own model override for the same reason SCOPE_MODEL
// exists: so setting it cannot silently repoint another lens's model. It does NOT
// give quota isolation -- mutation shares OPENROUTER_API_KEY with the scope and
// maintainability members, so an exhausted key still takes out all three.
export function mutationMember() {
  if (String(process.env.MUTATION_LENS || "").trim().toLowerCase() !== "true") return null;
  return {
    provider: "openrouter",
    model: process.env.MUTATION_MODEL || "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5 (mutation)",
    lens: "mutation",
  };
}

// The mutation member is appended rather than listed in DEFAULT_MODELS, and it
// is appended even when COUNCIL_MODELS overrides the roster. Setting
// mutation_lens is an explicit request, so honouring it under an override is
// the reading that matches what the caller asked for.
//
// It is dropped on a diff that adds no test lines. The lens asks whether the
// tests here could fail; with no test added there is no question to ask, and
// dispatching it anyway is spend that can only return "No findings".
//
// Any pre-existing "mutation"-lens entry in `models` (a COUNCIL_MODELS override
// can name any lens string) is stripped before the gate runs. Otherwise a CSV
// override naming the "mutation" lens would dispatch it unconditionally,
// bypassing both the mutation_lens opt-in and the no-tests-added skip.
export function withMutationMember(models, diff) {
  const base = models.filter((m) => m.lens !== "mutation");
  const mutation = mutationMember();
  if (!mutation) return { members: base, mutationSkipped: null };
  if (!diffAddsTestLines(diff)) return { members: base, mutationSkipped: "the diff adds no test lines" };
  return { members: [...base, mutation], mutationSkipped: null };
}

// The roster's own offline checks live beside the roster, for the same reason
// the roster does: keeping them in the engine pushes it past its line budget.
// buildFindingsMarkdown is passed in rather than imported, because the engine
// owns the report and importing it back here would make the two files circular.
export function selfcheckMutationRoster(buildFindingsMarkdown) {
  // The mutation lens must be OFF unless asked for. It is the front half of
  // something that gets expensive once it runs what it proposes, so a default
  // roster that quietly included it would be a cost nobody chose.
  if (DEFAULT_MODELS.some((m) => m.lens === "mutation")) throw new Error("selfcheck: mutation lens is a default member");
  const testDiff = "diff --git a/tests/t.py b/tests/t.py\n--- a/tests/t.py\n+++ b/tests/t.py\n+assert f() == 1\n";
  const codeDiff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+const x = 1;\n";
  if (diffAddsTestLines(codeDiff)) throw new Error("selfcheck: a code-only diff counted as adding tests");
  if (!diffAddsTestLines(testDiff)) throw new Error("selfcheck: a test diff did not count as adding tests");
  // Java/Kotlin/Scala name a test by suffix, not by directory or separator.
  if (
    !diffAddsTestLines("--- a/src/FooTest.java\n+++ b/src/FooTest.java\n+assertEquals(1, f());\n")
  ) {
    throw new Error("selfcheck: a conventional *Test.java filename was not recognized as a test");
  }
  // A lowercase "test" fused inside an unrelated word must NOT match -- only
  // the capitalized Test/Spec suffix does.
  if (diffAddsTestLines("--- a/src/Latest.js\n+++ b/src/Latest.js\n+const x = 1;\n")) {
    throw new Error("selfcheck: a filename merely containing lowercase 'test' was misclassified as a test file");
  }
  // A test file that is only DELETED from adds nothing to review.
  if (diffAddsTestLines("--- a/tests/t.py\n+++ b/tests/t.py\n-assert f() == 1\n")) throw new Error("selfcheck: a deletion counted as adding tests");
  // The header itself starts with "+", so a naive scan of "+" lines would
  // report every diff as touching tests the moment one test file appears.
  if (diffAddsTestLines("--- a/tests/t.py\n+++ b/tests/t.py\n")) throw new Error("selfcheck: the +++ header counted as an added line");
  // ...and the flag has to reset at the next file, or one test file makes
  // every later hunk in the diff look like a test.
  if (
    diffAddsTestLines(
      "--- a/tests/t.py\n+++ b/tests/t.py\n context\n--- a/src/a.ts\n+++ b/src/a.ts\n+const x = 1;\n",
    )
  ) {
    throw new Error("selfcheck: test-file flag leaked into the next file");
  }
  // An ADDED line that itself starts with "++ " (e.g. a bare `++ counter;`
  // statement) is prefixed to "+++ counter;" by the diff. Without pairing a
  // "+++ " header to its preceding "--- " line, that content line would be
  // misread as a new file header and silently swallow the real test line
  // that follows it.
  if (
    !diffAddsTestLines(
      "--- a/tests/t.py\n+++ b/tests/t.py\n+++ counter;\n+assert f() == 1\n",
    )
  ) {
    throw new Error("selfcheck: an added '++ ' content line was misread as a file header");
  }
  const savedLens = process.env.MUTATION_LENS;
  try {
    delete process.env.MUTATION_LENS;
    if (withMutationMember([], testDiff).members.length !== 0) throw new Error("selfcheck: mutation member added while disabled");
    // A COUNCIL_MODELS override can name any lens string, including "mutation".
    // With the gate disabled that entry must be stripped, not dispatched as-is
    // -- otherwise a hand-written CSV row bypasses mutation_lens entirely.
    const smuggled = [{ provider: "openrouter", model: "x", name: "Smuggled", lens: "mutation" }];
    if (withMutationMember(smuggled, testDiff).members.length !== 0) {
      throw new Error("selfcheck: a pre-existing mutation-lens member was dispatched while the gate is disabled");
    }
    process.env.MUTATION_LENS = "true";
    const on = withMutationMember([], testDiff);
    if (on.members.length !== 1 || on.members[0].lens !== "mutation") throw new Error("selfcheck: mutation member not added when enabled");
    // Even enabled, a smuggled entry must not double up with the canonical one.
    const onWithSmuggled = withMutationMember(smuggled, testDiff);
    if (onWithSmuggled.members.length !== 1 || onWithSmuggled.members[0].name !== "Claude Sonnet 5 (mutation)") {
      throw new Error("selfcheck: a pre-existing mutation-lens member duplicated the canonical one");
    }
    const skipped = withMutationMember([], codeDiff);
    if (skipped.members.length !== 0) throw new Error("selfcheck: mutation member dispatched on a diff with no tests");
    if (!skipped.mutationSkipped) throw new Error("selfcheck: skipped mutation member reported no reason");
    // The reason has to reach the report. Silence reads as "found nothing",
    // which is the opposite of "never ran".
    const mdSkip = buildFindingsMarkdown([], { mutationSkipped: skipped.mutationSkipped });
    if (!mdSkip.includes("Mutation lens enabled but not dispatched")) throw new Error("selfcheck: skip reason missing from the report");
  } finally {
    if (savedLens === undefined) delete process.env.MUTATION_LENS;
    else process.env.MUTATION_LENS = savedLens;
  }
}
