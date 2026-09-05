#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const lens = valueAfter('--lens-tag') || 'unknown';
if (process.env.XM_FAKE_PANEL_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.XM_FAKE_PANEL_DELAY_MS)));
const targetPath = args.find((arg) => arg.endsWith('.patch'));
const targetFiles = targetPath && existsSync(targetPath)
  ? [...readFileSync(targetPath, 'utf8').matchAll(new RegExp('^diff --git a/(\\S+) b/(\\S+)$', 'gm'))].map((match) => match[2])
  : ['src/a.js'];
// Mirror the real x-panel scope guard, reading its limit from source so this fixture never
// becomes a fourth copy of the number. Without this the suite accepted chunks that the real
// panel refuses, which is how a review file budget above the panel limit shipped green.
const panelSource = readFileSync(new URL('../../x-panel/lib/x-panel-cli.mjs', import.meta.url), 'utf8');
const panelFileLimit = Number(panelSource.match(/const REVIEW_TARGET_FILE_LIMIT = (\d+);/)?.[1] ?? 0);
if (panelFileLimit > 0 && targetFiles.length > panelFileLimit) {
  process.stderr.write(`bounded review target has ${targetFiles.length} files; split the frozen diff into chunks of at most ${panelFileLimit} files\n`);
  process.exit(2);
}
if (process.env.XM_FAKE_PANEL_LOG) appendFileSync(process.env.XM_FAKE_PANEL_LOG, `${JSON.stringify({ args, lens })}\n`);
if (process.env.XM_FAKE_PANEL_FAIL_LENS === lens) {
  const marker = process.env.XM_FAKE_PANEL_FAIL_MARKER;
  if (!marker || !existsSync(marker)) {
    if (marker) writeFileSync(marker, 'failed-once\n');
    process.stderr.write(`intentional ${lens} failure\n`);
    process.exit(7);
  }
}
const riskFinding = {
  owner: 'fixture-risk', severity: 'medium', file: 'src/a.js', line: 2,
  claim: 'risk finding', evidence: 'export const b = 2;', opponents: [{ model: 'fixture-challenger', stance: 'concede', reason: 'confirmed' }], reviewers: 1,
};
const mode = process.env.XM_FAKE_PANEL_MODE;
const severity = process.env.XM_FAKE_PANEL_SEVERITY;
const finding = { ...riskFinding, ...(severity ? { severity } : {}), ...(mode === 'foreign-target' ? { file: 'src/foreign.js' } : {}) };
if (mode === 'mixed-severity') finding.severity = lens === 'correctness' ? 'medium' : 'high';
finding.code = mode === 'ungrounded-finding' ? 'execSync(payload);' : 'export const b = 2;';
finding.fix = 'Guard the exported value.';
// wrong-file: quote a line that really exists, but under a DIFFERENT file's name. The validator
// must see the citation land in another section and drop the finding before synthesis.
if (mode === 'wrong-file' && targetFiles.length > 1) {
  const body = targetPath && existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const section = body.split(`diff --git a/${targetFiles[1]} `)[1] || '';
  const quoted = section.split('\n').find((line) => line.startsWith('+') && !line.startsWith('+++'));
  if (quoted) {
    finding.file = targetFiles[0];
    finding.code = quoted.slice(1);
  }
}
if (mode === 'unchallenged') finding.opponents = [];
if (mode === 'contested') finding.opponents = [{ model: 'fixture-challenger', stance: 'refute', reason: 'disputed' }];
if (mode === 'mixed-disposition' && lens === 'correctness') finding.opponents = [];
// malformed-line: one well-formed finding plus a sibling with no usable line. The report is
// otherwise fine, so this exercises the lifecycle path that must drop ONLY the sibling.
const malformedSibling = { ...finding, claim: 'sibling finding with no line', line: null };
const confirmedFindings = mode === 'malformed-line' ? [finding, malformedSibling] : [finding];
const zero = mode === 'clean' || (lens !== 'risk' && !['duplicate', 'mixed-severity'].includes(mode)) || mode === 'evidence-free-zero';
const checkedFiles = mode === 'missing-coverage' ? [] : targetFiles;
process.stdout.write(`${JSON.stringify({
  run: `fake-${lens}`, models: ['fixture-risk', 'fixture-challenger'],
  counts: { confirmed: zero ? 0 : confirmedFindings.length, contested: 0, unreviewed: 0, unique: zero ? 0 : confirmedFindings.length },
  by_model: { 'fixture-risk': { r1: 'ok', raised: zero ? 0 : 1 }, 'fixture-challenger': { r1: 'ok', raised: 0 } },
  review_evidence: {
    'fixture-risk': { checked: [`${lens} paths inspected`], checked_files: checkedFiles, no_findings_reason: zero && mode !== 'evidence-free-zero' ? 'No defect remained after checking the frozen target.' : null },
    'fixture-challenger': { checked: [`${lens} paths inspected independently`], checked_files: checkedFiles, no_findings_reason: mode !== 'evidence-free-zero' ? 'No additional defect remained after independent review.' : null },
  },
  consensus: zero ? [] : [{ file: finding.file, line: finding.line, severity: finding.severity, consensus: 1 }],
  confirmed: zero || mode === 'contested' || (mode === 'mixed-disposition' && lens === 'correctness') ? [] : confirmedFindings, contested: mode === 'contested' ? [finding] : [], unreviewed: mode === 'mixed-disposition' && lens === 'correctness' ? [finding] : [],
  ...(zero && mode !== 'evidence-free-zero' ? { no_findings_reason: `No ${lens} issues remain after checking every line in ${targetPath || 'the frozen target'}.` } : {}),
  coverage_failed: false,
})}\n`);
