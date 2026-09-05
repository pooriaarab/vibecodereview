import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  alreadyFiled,
  buildIssue,
  extractLensFamily,
  fingerprint,
  isEmptyReview,
  parseFindings,
  stemText,
} from './file-findings.mjs';

const REVIEW = `# 🧑‍⚖️ LLM Council findings

Independent per-lens reviews from council models. Treat as co-reviewer input:
de-dupe, verify each claim against the code, discard false positives.

- This bullet is instructions to the reader, not a finding.

## GPT-5.6 — correctness lens

- \`src/billing/credit-guard.ts:39\` — prepareCreditCharge runs unconditionally, so an orchestrator-forwarded request is charged twice -> skip when the signed header is present.
- \`src/middleware.ts:104\` — a forged x-ai-credit header is not stripped when the signature is absent rather than invalid -> treat absent as invalid.

## Kimi K3 — security lens

- \`src/auth/session.ts:163\` — apiKeyTeamId is read from the body before membership is confirmed -> resolve it from the key.

## Gemini — performance lens

_provider HTTP 503_
`;

test('findings are parsed with their location and lens', () => {
  const findings = parseFindings(REVIEW);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].location, 'src/billing/credit-guard.ts:39');
  assert.match(findings[0].lens, /correctness/);
  assert.match(findings[2].lens, /security/);
});

test('a bullet outside a model section is not a finding', () => {
  // The preamble tells the reader how to treat the review. Filing it as a
  // defect would be filing the instructions.
  const findings = parseFindings(REVIEW);
  assert.ok(!findings.some((f) => f.text.includes('instructions to the reader')));
});

test('a lens that errored contributes nothing', () => {
  const findings = parseFindings(REVIEW);
  assert.ok(!findings.some((f) => f.lens.includes('performance')));
});

test('a fenced block is not scanned for findings', () => {
  // A review quoting a diff would otherwise have its own example lines filed.
  const withFence = `## Model — lens\n\n\`\`\`\n- \`src/x.ts:1\` — an example inside a fence -> nothing.\n\`\`\`\n`;
  assert.equal(parseFindings(withFence).length, 0);
});

test('an em dash and a plain hyphen are both accepted', () => {
  // Five models write this line five ways, and the separator is the part they
  // disagree on most.
  const emDash = '## M — lens\n\n- `a/b.ts:1` — the defect -> the fix.\n';
  const hyphen = '## M — lens\n\n- `a/b.ts:1` - the defect -> the fix.\n';
  assert.equal(parseFindings(emDash).length, 1);
  assert.equal(parseFindings(hyphen).length, 1);
});

test('a line with no file location is not a finding', () => {
  const vague = '## M — lens\n\n- `looks risky` — something feels off -> think about it.\n';
  assert.equal(parseFindings(vague).length, 0);
});

test('an empty review files nothing', () => {
  assert.ok(isEmptyReview('# 🧑‍⚖️ LLM Council findings\n\n## M — lens\n\nNo findings.\n'));
  assert.ok(isEmptyReview('# 🧑‍⚖️ LLM Council findings\n\n_Council skipped: empty diff._\n'));
  assert.ok(!isEmptyReview(REVIEW));
});

test('the fingerprint is stable across whitespace and casing', () => {
  const a = fingerprint('src/x.ts:1', 'The  defect   here');
  const b = fingerprint('src/x.ts:1', 'the defect here');
  assert.equal(a, b);
  assert.notEqual(a, fingerprint('src/x.ts:2', 'the defect here'));
});

test('the filed issue carries every heading the bug form requires', () => {
  const [finding] = parseFindings(REVIEW);
  const { title, body } = buildIssue(finding, { repo: 'pooriaarab/x', prNumber: 42, runUrl: 'https://example/run' });

  for (const heading of ['## Impact', '## Reproduction', '## Last known good', '## Acceptance criteria', '## How to verify']) {
    assert.ok(body.includes(heading), `missing ${heading}`);
  }
  // The standard wants criteria as checkboxes, each one testable.
  assert.match(body, /- \[ \] /);
  // No parent or blocker written in prose: those are native links.
  assert.ok(!/^\s*(Parent|Blocked by)\s*:/m.test(body));
  // Imperative subject, no trailing period.
  assert.match(title, /^Fix /);
  assert.ok(!title.endsWith('.'));
});

test('the marker makes a rerun recognise its own earlier issue', () => {
  const [finding] = parseFindings(REVIEW);
  const { body } = buildIssue(finding, { repo: 'pooriaarab/x', prNumber: 42 });
  assert.ok(body.includes(`vibecodereview-finding:${finding.id}`));
  // Rerunning the same review produces the same id, which is what dedupe needs.
  assert.equal(parseFindings(REVIEW)[0].id, finding.id);
});

test('the issue says it is untriaged, because nothing here agreed to the work', () => {
  const [finding] = parseFindings(REVIEW);
  const { body } = buildIssue(finding, { repo: 'pooriaarab/x', prNumber: 42 });
  assert.match(body, /Not triaged/i);
  assert.match(body, /read it before acting/i);
});

test('the title is imperative and inside the standard length', () => {
  // 10 to 50 characters, imperative, no trailing period. A finding's first
  // clause is usually longer, and cutting at a fixed width severs it mid-word.
  const cases = parseFindings(REVIEW);
  for (const finding of cases) {
    const { title } = buildIssue(finding, { repo: 'pooriaarab/x', prNumber: 42 });
    assert.ok(title.length >= 10 && title.length <= 50, `${title.length}: ${title}`);
    assert.match(title, /^Fix /);
    assert.ok(!title.endsWith('.'));
    assert.ok(!title.endsWith(','));
    // Not severed mid-word: the last token must appear whole in the source.
    const last = title.split(' ').pop();
    assert.ok(finding.text.toLowerCase().includes(last.toLowerCase()) || title.includes('the defect in'), title);
  }
});

test('a finding with no usable clause still gets a title', () => {
  const [finding] = parseFindings('## M — lens\n\n- `src/deep/thing.ts:9` — x -> y.\n');
  const { title } = buildIssue(finding, { repo: 'pooriaarab/x', prNumber: 1 });
  assert.ok(title.length >= 10, title);
  assert.match(title, /thing\.ts/);
});

test('findings differing only by line number share a classKey', () => {
  const a = parseFindings('## GPT — correctness lens\n\n- `src/x.ts:10` — leak on error path -> handle it.\n');
  const b = parseFindings('## GPT — correctness lens\n\n- `src/x.ts:99` — leak on error path -> handle it.\n');
  assert.equal(a[0].classKey, b[0].classKey);
  assert.notEqual(a[0].id, b[0].id);
});

test('findings differing only by model name share a classKey', () => {
  const a = parseFindings('## GPT-5.6 — security lens\n\n- `src/auth.ts:1` — token not validated -> validate.\n');
  const b = parseFindings('## Kimi K3 — security lens\n\n- `src/auth.ts:1` — token not validated -> validate.\n');
  assert.equal(a[0].classKey, b[0].classKey);
  assert.equal(a[0].lensFamily, 'security');
  assert.equal(b[0].lensFamily, 'security');
});

test('genuinely different defects do not share a classKey', () => {
  const a = parseFindings('## M — security lens\n\n- `src/a.ts:1` — missing auth check -> add guard.\n');
  const b = parseFindings('## M — security lens\n\n- `src/a.ts:1` — sql injection in query -> parameterize.\n');
  assert.notEqual(a[0].classKey, b[0].classKey);
});

test('stemText matches buildTitle first-clause cut', () => {
  const text = 'prepareCreditCharge runs twice -> skip when header present.';
  assert.equal(stemText(text), 'prepareCreditCharge runs twice');
  const [finding] = parseFindings(`## M — lens\n\n- \`src/x.ts:1\` — ${text}\n`);
  const { title } = buildIssue(finding, { repo: 'pooriaarab/x', prNumber: 1 });
  assert.match(title.toLowerCase(), /preparecreditcharge runs twice/);
});

test('parseFindings path drops the line suffix for classKey', () => {
  const a = parseFindings('## M — security lens\n\n- `src/auth.ts:9` — bad token handling -> fix.\n');
  const b = parseFindings('## M — security lens\n\n- `src/auth.ts:42` — bad token handling -> fix.\n');
  assert.equal(a[0].path, 'src/auth.ts');
  assert.equal(a[0].classKey, b[0].classKey);
});

test('extractLensFamily ignores cached suffix on heading', () => {
  assert.equal(extractLensFamily('GPT — correctness lens (cached)'), 'correctness');
});

test('buildIssue output contains both the finding and class key markers', () => {
  const [finding] = parseFindings(REVIEW);
  const { body } = buildIssue(finding, { repo: 'pooriaarab/x', prNumber: 42 });
  assert.ok(body.includes(`vibecodereview-finding:${finding.id}`));
  assert.ok(body.includes(`vibecodereview-class:${finding.classKey}`));
  assert.ok(body.includes(`vibecodereview-lens:${finding.lensFamily}`));
});

test('findings differing only by line number produce different finding markers and the same class marker in buildIssue', () => {
  const text = 'leak on error path -> handle it.';
  const a = parseFindings(`## GPT — correctness lens\n\n- \`src/x.ts:10\` — ${text}\n`);
  const b = parseFindings(`## GPT — correctness lens\n\n- \`src/x.ts:99\` — ${text}\n`);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0].id, b[0].id);
  assert.equal(a[0].classKey, b[0].classKey);
  const { body: bodyA } = buildIssue(a[0], { repo: 'pooriaarab/x', prNumber: 1 });
  const { body: bodyB } = buildIssue(b[0], { repo: 'pooriaarab/x', prNumber: 1 });
  assert.ok(bodyA.includes(`vibecodereview-finding:${a[0].id}`));
  assert.ok(bodyB.includes(`vibecodereview-finding:${b[0].id}`));
  assert.ok(bodyA.includes(`vibecodereview-class:${a[0].classKey}`));
  assert.ok(bodyB.includes(`vibecodereview-class:${b[0].classKey}`));
});

test('buildIssue carries optional head sha and strength when provided', () => {
  const [finding] = parseFindings(REVIEW);
  const { body } = buildIssue(finding, {
    repo: 'pooriaarab/x',
    prNumber: 42,
    headSha: 'abc123def456',
    strength: 'full',
  });
  assert.ok(body.includes('vibecodereview-head:abc123def456'));
  assert.ok(body.includes('vibecodereview-strength:full'));
});

test('alreadyFiled still searches the finding id marker, not the class marker', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-gh-'));
  const ghPath = path.join(tmpDir, 'gh');
  const recorded = path.join(tmpDir, 'recorded.json');
  const fakeGh = `#!/usr/bin/env node\nconst fs = require('fs');\nconst out = process.env.VCR_GH_RECORD;\nif (out) fs.writeFileSync(out, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write('[]\\n');\n`;
  fs.writeFileSync(ghPath, fakeGh);
  fs.chmodSync(ghPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${originalPath}`;
  process.env.VCR_GH_RECORD = recorded;
  try {
    const result = alreadyFiled('pooriaarab/x', 'finding-id-123');
    assert.equal(result, null);
    const args = JSON.parse(fs.readFileSync(recorded, 'utf8').trim());
    const joined = args.join(' ');
    assert.ok(joined.includes('vibecodereview-finding:finding-id-123'));
    assert.ok(!joined.includes('vibecodereview-class:'));
    assert.ok(!joined.includes('vibecodereview-lens:'));
  } finally {
    process.env.PATH = originalPath;
    delete process.env.VCR_GH_RECORD;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
