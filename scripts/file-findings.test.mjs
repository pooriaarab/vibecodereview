import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTitle,
  buildIssue,
  fingerprint,
  isEmptyReview,
  parseFindings,
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
