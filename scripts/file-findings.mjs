// File a council finding that the pull request did not fix as a GitHub issue.
//
// A review produces findings with evidence at the one moment that evidence is
// cheap to collect. Anything the author does not fix leaves no trace once the
// pull request merges, so the same defect is found again by the next review, or
// shipped.
//
// Filed, not scheduled. Triage decides whether it is worth doing. Auto-filing
// without auto-ranking keeps the finding and defers the cost of acting on it,
// which is the only part that was ever expensive. Auto-ranking would produce a
// queue of agent-written work nobody agreed to.
//
// Runs after the council's last pass on a pull request, so the findings it sees
// are the ones that survived to the final diff.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

// A finding line, as the council prompt asks for it:
//   - `path:line` — the defect and its trigger -> the fix
// The dash may be an em dash or a hyphen, and the arrow may be -> or a real
// arrow, because five different models write this line five different ways.
const FINDING_RE = /^\s*[-*]\s+`([^`]+)`\s*[—–-]\s*(.+)$/;

// The marker that makes filing idempotent. It carries a fingerprint of the
// finding, so a rerun of the same review recognises its own earlier issue
// rather than filing a duplicate.
const MARKER = 'vibecodereview-finding';

export function fingerprint(location, text) {
  // Normalise before hashing: the same defect described with different
  // whitespace or casing by a rerun is the same defect.
  const normal = `${location}|${text}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normal).digest('hex').slice(0, 16);
}

// First clause before the arrow — shared by buildTitle and classKey so jscpd
// does not flag a second cut.
export function stemText(text) {
  return String(text || '').split(/->|—|\.\s|;/)[0].trim().replace(/[.,:;]$/, '');
}

// Lens token from a model heading, e.g. "GPT — correctness lens" -> "correctness".
export function extractLensFamily(heading) {
  const match = /—\s*(\w+)\s*lens/i.exec(String(heading || ''));
  return match ? match[1].toLowerCase() : String(heading || '').toLowerCase();
}

export function buildClassKey(lensFamily, path, text) {
  const stem = stemText(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const normal = `${lensFamily}|${path}|${stem}`;
  return crypto.createHash('sha256').update(normal).digest('hex');
}

export function parseFindings(markdown) {
  const findings = [];
  let lens = null;
  let fenced = false;
  for (const line of String(markdown || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { lens = heading[1].trim(); continue; }
    // Findings only appear under a model heading. A bullet in the preamble is
    // instructions to the reader, not a defect.
    if (!lens) continue;
    const match = FINDING_RE.exec(line);
    if (!match) continue;
    const location = match[1].trim();
    const text = match[2].trim();
    // The council is asked to name a concrete trigger. A line without one is
    // not a finding, and `path:line` is the shape that carries it.
    if (!/:\d+/.test(location) && !location.includes('/')) continue;
    const path = location.split(':')[0];
    const lensFamily = extractLensFamily(lens);
    findings.push({
      location,
      text,
      lens,
      lensFamily,
      path,
      id: fingerprint(location, text),
      classKey: buildClassKey(lensFamily, path, text),
    });
  }
  return findings;
}

/** Machine-readable finding keys for the chair verdict file. */
export function findingsMetaBlock(findings) {
  const payload = findings.map((f) => ({
    id: f.id,
    classKey: f.classKey,
    path: f.path,
    lens: f.lensFamily,
  }));
  return `\n<!-- vibetrace:findings-meta\n${JSON.stringify(payload)}\n-->\n`;
}

export function appendFindingsMeta(markdown) {
  return `${String(markdown || '').trimEnd()}${findingsMetaBlock(parseFindings(markdown))}`;
}

// The council says this in so many words when it has nothing.
export function isEmptyReview(markdown) {
  return /(^|\n)\s*_?No findings\.?_?\s*(\n|$)/i.test(String(markdown || ''))
    || parseFindings(markdown).length === 0;
}

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFail) return '';
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  }
}

export function alreadyFiled(repo, id) {
  // Search the marker rather than the title. A title can be edited by hand; the
  // marker is what makes a rerun recognise its own earlier issue.
  const out = gh(['search', 'issues', '--repo', repo, '--match', 'body',
    `${MARKER}:${id}`, '--json', 'number', '--limit', '1'], { allowFail: true });
  try {
    return (JSON.parse(out || '[]')[0] || {}).number || null;
  } catch {
    return null;
  }
}

// The standard wants an imperative subject of 10 to 50 characters. A finding's
// first clause is usually longer than that and cutting it at a fixed width
// leaves a title severed mid-phrase, so drop whole words until it fits and fall
// back to the file name when the clause carries nothing usable.
export function buildTitle(finding, path) {
  const clause = stemText(finding.text);
  const file = String(path || '').split('/').pop() || 'the reported defect';
  let subject = clause.charAt(0).toLowerCase() + clause.slice(1);
  while (subject.length > 46 && subject.includes(' ')) {
    subject = subject.slice(0, subject.lastIndexOf(' '));
  }
  subject = subject.replace(/[\s,]+$/, '');
  if (subject.length < 6) subject = `the defect in ${file}`;
  return `Fix ${subject}`;
}

// Written to the issue standard so `issue-standards check` passes on what this
// files. A finding is a defect, so it is filed as a bug: the trigger the
// council was required to name is the reproduction.
export function buildIssue(finding, { repo, prNumber, runUrl }) {
  const [path] = finding.location.split(':');
  const title = buildTitle(finding, path);
  const body = [
    `## Impact`,
    finding.text,
    '',
    `## Reproduction`,
    `Found by the ${finding.lens} during review of #${prNumber}, at \`${finding.location}\`.`,
    '',
    'The council is required to name a concrete failure trigger, and the sentence above is it. Verify it against the code before acting: a finding is co-reviewer input, not a verdict.',
    '',
    `## Last known good`,
    `The defect was introduced or touched by #${prNumber}. Anything before it did not carry this code.`,
    '',
    `## Acceptance criteria`,
    `- [ ] The behaviour described above no longer happens.`,
    `- [ ] A test covers the trigger, and fails without the fix.`,
    '',
    `## How to verify`,
    `Reproduce the trigger against \`${path}\`, then confirm the test fails before the fix and passes after.`,
    '',
    '---',
    '',
    `> Filed automatically from a review that #${prNumber} did not fix. Not triaged, and not agreed: read it before acting.`,
    runUrl ? `> Review run: ${runUrl}` : '',
    `> \`${MARKER}:${finding.id}\``,
  ].filter((line) => line !== '').join('\n');
  return { title, body };
}

// Every filed issue lands in triage. Nothing here decides priority.
const LABELS = ['bug', 'triage'];

export function fileFindings(markdown, { repo, prNumber, runUrl, dryRun = false } = {}) {
  const findings = parseFindings(markdown);
  const filed = [];
  const skipped = [];
  for (const finding of findings) {
    const existing = alreadyFiled(repo, finding.id);
    if (existing) {
      skipped.push({ ...finding, reason: `already filed as #${existing}` });
      continue;
    }
    const { title, body } = buildIssue(finding, { repo, prNumber, runUrl });
    if (dryRun) {
      filed.push({ ...finding, title, dryRun: true });
      continue;
    }
    const out = gh(['issue', 'create', '--repo', repo, '--title', title,
      '--body', body, '--label', LABELS.join(',')], { allowFail: true });
    const url = out.trim().split('\n').pop();
    if (!url.startsWith('http')) {
      // Filing is best effort. A review that fails because an issue could not
      // be filed is worse than a finding that has to be read in the review.
      skipped.push({ ...finding, reason: 'could not file' });
      continue;
    }
    filed.push({ ...finding, title, url });
  }
  return { findings, filed, skipped };
}

function usage() {
  return `Usage:
  file-findings.mjs --findings F --repo owner/name --pr N [--run-url U] [--dry-run]`;
}

export async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (['--findings', '--repo', '--pr', '--run-url'].includes(arg)) {
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[index + 1];
      index += 1;
      continue;
    }
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (!options.findings || !options.repo || !options.pr) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (!fs.existsSync(options.findings)) {
    process.stdout.write('No findings file. Nothing to file.\n');
    return 0;
  }
  const markdown = fs.readFileSync(options.findings, 'utf8');
  if (isEmptyReview(markdown)) {
    process.stdout.write('No findings. Nothing to file.\n');
    return 0;
  }
  const result = fileFindings(markdown, {
    repo: options.repo,
    prNumber: options.pr,
    runUrl: options.runUrl,
    dryRun: options.dryRun,
  });
  for (const item of result.filed) {
    process.stdout.write(`${item.dryRun ? 'would file' : 'filed'}  ${item.location}  ${item.url || ''}\n`);
  }
  for (const item of result.skipped) {
    process.stdout.write(`skipped   ${item.location}  ${item.reason}\n`);
  }
  process.stdout.write(`${result.filed.length} filed, ${result.skipped.length} skipped, ${result.findings.length} findings seen\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('file-findings.mjs');
if (invokedDirectly) {
  main(process.argv.slice(2)).then((status) => { process.exitCode = status; });
}
