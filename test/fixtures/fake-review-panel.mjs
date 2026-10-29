#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const lens = valueAfter('--lens-tag') || 'unknown';
const startedAt = Date.now();
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
if (process.env.XM_FAKE_PANEL_LOG) appendFileSync(process.env.XM_FAKE_PANEL_LOG, JSON.stringify({ args, lens, started_at: startedAt, ended_at: Date.now() }) + '\n');
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
let mode = process.env.XM_FAKE_PANEL_MODE;
if (mode === 'correctness-unusable') mode = lens === 'correctness' ? 'all-slots-unusable' : 'clean';
const severity = process.env.XM_FAKE_PANEL_SEVERITY;
const finding = { ...riskFinding, ...(severity ? { severity } : {}), ...(mode === 'foreign-target' ? { file: 'src/foreign.js' } : {}) };
if (mode === 'mixed-severity') finding.severity = lens === 'correctness' ? 'medium' : 'high';
finding.code = mode === 'ungrounded-finding' ? 'execSync(payload);' : 'export const b = 2;';
finding.fix = 'Guard the exported value.';
// Korean findings from reviewer records: the same overflow worded two ways by two lenses, and a
// missing test next to the production defect it would catch, both citing one line.
if (mode === 'korean-paraphrase') {
  finding.claim = lens === 'risk' ? '테이블별 행 수 합계가 `u64` 오버플로를 검사하지 않고 계산됩니다.' : '테이블별 `u64` 행 수를 검사 없이 합산하여 전체 행 수가 `u64::MAX`를 넘으면 목록 명령이 잘못된 `total_rows`를 표시하거나 패닉할 수 있습니다.';
  if (lens === 'risk') finding.severity = 'low';
}
// Different cited lines, so only the description can decide the merge.
if (mode === 'korean-identical') {
  finding.claim = '합계가 오버플로를 검사하지 않습니다.';
  if (lens === 'risk') Object.assign(finding, { line: 1, code: 'export const a = 1;' });
}
// One description repeats the other plus a consequence: overlap is high over the shorter text,
// low over the longer one.
if (mode === 'korean-partial') {
  finding.claim = lens === 'risk'
    ? '영문 Report viewer 안내에 한국어 필터 이름이 그대로 남아 있습니다.'
    : '영문 Report viewer 안내에 한국어 필터 이름이 그대로 남아 있어 영문 사용자가 `f`를 눌렀을 때 어떤 필터로 전환되는지 이해하기 어렵습니다.';
  if (lens === 'risk') Object.assign(finding, { line: 1, code: 'export const a = 1;' });
}
// Two distinct defects quoting the same line (reviewer record 420/306 F1/F2).
if (mode === 'shared-code-distinct') {
  finding.claim = lens === 'risk'
    ? 'diff 밖 의견이 51건 이상이면 51번째 이후 의견의 본문이 게시물에서 영구적으로 빠집니다.'
    : '이동할 의견 수만 50건으로 제한하고 본문 크기는 제한하지 않아, 이동된 의견이 긴 경우 전체 리뷰 게시가 실패할 수 있습니다.';
}
if (mode === 'test-gap') {
  finding.claim = lens === 'tests'
    ? '`table_rows`가 있는 manifest에서 아카이브를 읽지 않고 해당 값을 비교에 사용하는 새 분기에 대한 테스트가 추가되지 않았습니다.'
    : '`table_rows`가 있는 백업에서는 `data.bin`을 전혀 열지 않아, 저장된 백업 본문이 없어도 `verify --against`가 성공할 수 있습니다.';
}
// wrong-file: quote a line that really exists, but under a DIFFERENT file's name. The validator
// must see the citation land in another section and drop the finding before synthesis.
if (mode === 'wrong-file') {
  // Fail loudly when the fixture cannot build the situation it was asked for. Falling back to a
  // well-formed finding would let the test that asserts the drop pass without ever exercising it.
  const body = targetPath && existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const section = targetFiles.length > 1 ? (body.split(`diff --git a/${targetFiles[1]} `)[1] || '') : '';
  const quoted = section.split('\n').find((line) => line.startsWith('+') && !line.startsWith('+++'));
  if (!quoted) {
    process.stderr.write(`fake panel: wrong-file mode needs a second file section with an added line; got ${targetFiles.length} file(s)\n`);
    process.exit(3);
  }
  finding.file = targetFiles[0];
  finding.code = quoted.slice(1);
}
if (mode === 'unchallenged') finding.opponents = [];
if (mode === 'contested') finding.opponents = [{ model: 'fixture-challenger', stance: 'refute', reason: 'disputed' }];
if (mode === 'mixed-disposition' && lens === 'correctness') finding.opponents = [];
// malformed-line: one well-formed finding plus a sibling with no usable line. The report is
// otherwise fine, so this exercises the lifecycle path that must drop ONLY the sibling.
const malformedSibling = { ...finding, claim: 'sibling finding with no line', line: null };
const confirmedFindings = mode === 'malformed-line' ? [finding, malformedSibling] : [finding];
const zero = mode === 'clean' || (lens !== 'risk' && !['duplicate', 'mixed-severity', 'korean-paraphrase', 'korean-identical', 'korean-partial', 'shared-code-distinct', 'test-gap'].includes(mode)) || mode === 'evidence-free-zero';
const checkedFiles = mode === 'missing-coverage' ? [] : targetFiles;
process.stdout.write(`${JSON.stringify({
  run: `fake-${lens}`, models: ['fixture-risk', 'fixture-challenger'],
  counts: { confirmed: zero ? 0 : confirmedFindings.length, contested: 0, unreviewed: 0, unique: zero ? 0 : confirmedFindings.length },
  by_model: {
    'fixture-risk': { r1: mode === 'all-slots-unusable' ? 'failed' : 'ok', raised: zero ? 0 : 1 },
    // suspect-slot: one slot is warn-only unusable while the other reviewed fine, so the report
    // must still be produced. all-slots-unusable: nothing usable is left and it must fail.
    'fixture-challenger': { r1: ['suspect-slot', 'all-slots-unusable'].includes(mode) ? 'suspect_empty' : 'ok', raised: 0 },
  },
  review_evidence: {
    'fixture-risk': { checked: [`${lens} paths inspected`], checked_files: checkedFiles, no_findings_reason: zero && mode !== 'evidence-free-zero' ? 'No defect remained after checking the frozen target.' : null },
    'fixture-challenger': { checked: [`${lens} paths inspected independently`], checked_files: checkedFiles, no_findings_reason: mode !== 'evidence-free-zero' ? 'No additional defect remained after independent review.' : null },
  },
  consensus: zero ? [] : confirmedFindings.map((entry) => ({ file: entry.file, line: entry.line, severity: entry.severity, consensus: 1 })),
  confirmed: zero || mode === 'contested' || (mode === 'mixed-disposition' && lens === 'correctness') ? [] : confirmedFindings, contested: mode === 'contested' ? [finding] : [], unreviewed: mode === 'mixed-disposition' && lens === 'correctness' ? [finding] : [],
  ...(zero && mode !== 'evidence-free-zero' ? { no_findings_reason: `No ${lens} issues remain after checking every line in ${targetPath || 'the frozen target'}.` } : {}),
  coverage_failed: false,
})}\n`);
