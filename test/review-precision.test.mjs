import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  parseTriageLedger, buildLedgerRow, ledgerRowKey, filterLedgerRows, aggregateLensPrecision,
  lensesBelowPrecision, formatPrecisionReport, parseDuration, findingLens,
} from '../x-build/lib/x-build/review-precision.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');
const RUN_DEFAULT_CWD = mkdtempSync(join(tmpdir(), 'xb-rp-nocwd-'));

function run(args, opts = {}) {
  const cwd = opts.cwd ?? RUN_DEFAULT_CWD;
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, XKIT_SERVER: undefined, X_BUILD_ROOT: undefined, XM_ROOT: join(cwd, '.xm'), ...opts.env },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function setupProject(tmp, name = 'test-proj') {
  run(['init', name], { cwd: tmp });
  return name;
}

// Same fixture shape as test/phase-verify.test.mjs so the gate passes for the
// same reasons there: reviewed files exist, snapshots match, evidence present.
function writeReviewResult(tmp, review = {}) {
  const dir = join(tmp, '.xm', 'review');
  mkdirSync(dir, { recursive: true });
  const defaultFindings = [
    { severity: 'high', lens: 'logic', file: 'src/auth.ts', line: 42, summary: 'Auth bypass on missing token' },
    { severity: 'medium', lenses: ['security'], file: 'src/auth.ts', line: 50, summary: 'Suspected open redirect' },
    { severity: 'low', lens: 'docs', file: 'src/auth.ts', line: 7, summary: 'Missing comment' },
  ];
  const findings = review.findings || defaultFindings;
  const reviewedFiles = review.reviewed_files_all || [...new Set(findings.map(f => f.file).filter(Boolean))].sort();
  for (const file of reviewedFiles) {
    const path = join(tmp, file);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `reviewed fixture: ${file}\n`);
    }
  }
  const snapshots = reviewedFiles.map(file => ({
    file,
    exists: existsSync(join(tmp, file)),
    sha256: existsSync(join(tmp, file)) ? createHash('sha256').update(readFileSync(join(tmp, file))).digest('hex') : null,
  }));
  writeFileSync(join(dir, 'last-result.json'), JSON.stringify({
    reviewed_commit: 'abc1234',
    verdict: 'request_changes',
    ...review,
    findings,
    reviewed_files_all: reviewedFiles,
    reviewed_file_snapshots: snapshots,
  }, null, 2));
}

function initAndEditTriage(tmp, edit) {
  const init = run(['verify-review-fix', '--init'], { cwd: tmp });
  expect(init.exitCode).toBe(0);
  const path = join(tmp, '.xm', 'review', 'triage.json');
  const triage = readJSON(path);
  edit(triage);
  writeFileSync(path, JSON.stringify(triage, null, 2));
  return triage;
}

function ledgerRows(tmp) {
  const path = join(tmp, '.xm', 'review', 'triage-ledger.jsonl');
  if (!existsSync(path)) return [];
  return parseTriageLedger(readFileSync(path, 'utf8')).rows;
}

const finding = (over = {}) => ({ id: 'F1', finding_id: 'rf_0000000000000001', lens: 'logic', severity: 'high', file: 'src/a.mjs', ...over });
const row = (over = {}) => buildLedgerRow({ ts: '2026-08-20T00:00:00.000Z', reviewed_commit: 'c1', finding: finding(), decision: 'fix_now', ...over });

// ── pure aggregator ──────────────────────────────────────────────────

describe('review-precision: parsing', () => {
  test('skips torn and invalid lines, keeps valid rows', () => {
    const text = [
      JSON.stringify(row()),
      '{"schema_v":1,"type":"triage_decision","finding_id":"rf_x","decision":"maybe"}',
      '{"torn":',
      JSON.stringify(row({ finding: finding({ id: 'F2', finding_id: 'rf_0000000000000002' }), outcome: 'resolved' })),
      '',
    ].join('\n');
    const parsed = parseTriageLedger(text);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.skipped).toBe(2);
    expect(parsed.rows[1].type).toBe('triage_outcome');
  });

  test('findingLens accepts lens, lenses[], sources[] and falls back to unknown', () => {
    expect(findingLens({ lens: 'Logic ' })).toBe('logic');
    expect(findingLens({ lenses: ['security', 'perf'] })).toBe('security');
    expect(findingLens({ sources: ['docs'] })).toBe('docs');
    expect(findingLens({})).toBe('unknown');
  });

  test('parseDuration handles d/h/m and rejects garbage', () => {
    expect(parseDuration('30d')).toBe(30 * 86400000);
    expect(parseDuration('12h')).toBe(12 * 3600000);
    expect(parseDuration('90m')).toBe(90 * 60000);
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('0d')).toBeNull();
  });
});

describe('review-precision: aggregation', () => {
  test('precision is fix_now / (fix_now + false_positive); backlog and accept_risk are excluded', () => {
    const rows = [
      row(),
      row({ finding: finding({ id: 'F2', finding_id: 'rf_0000000000000002' }), decision: 'false_positive' }),
      row({ finding: finding({ id: 'F3', finding_id: 'rf_0000000000000003' }), decision: 'backlog' }),
      row({ finding: finding({ id: 'F4', finding_id: 'rf_0000000000000004' }), decision: 'accept_risk' }),
      row({ finding: finding({ id: 'F5', finding_id: 'rf_0000000000000005', lens: 'docs' }), decision: 'fix_now' }),
      row({ finding: finding({ id: 'F6', finding_id: 'rf_0000000000000006', lens: 'docs' }), decision: 'fix_now' }),
      row({ finding: finding({ id: 'F6', finding_id: 'rf_0000000000000006', lens: 'docs' }), outcome: 'persistent' }),
    ];
    const report = aggregateLensPrecision(rows);
    const logic = report.lenses.find(b => b.lens === 'logic');
    expect(logic).toMatchObject({ decided: 4, fix_now: 1, false_positive: 1, backlog: 1, accept_risk: 1, precision: 0.5 });
    const docs = report.lenses.find(b => b.lens === 'docs');
    expect(docs).toMatchObject({ decided: 2, fix_now: 2, false_positive: 0, precision: 1, persistent: 1 });
    expect(report.totals).toMatchObject({ decided: 6, fix_now: 3, false_positive: 1, precision: 0.75 });
    expect(report.window.reviews).toBe(1);
    // sorted by decided desc
    expect(report.lenses[0].lens).toBe('logic');
  });

  test('unmeasured lens reports precision null, not 0', () => {
    const report = aggregateLensPrecision([row({ decision: 'backlog' })]);
    expect(report.lenses[0].precision).toBeNull();
    expect(report.totals.precision).toBeNull();
    expect(lensesBelowPrecision(report, 0.9)).toEqual([]);
    expect(formatPrecisionReport(report)).toContain('—');
  });

  test('duplicate rows (re-run gate) count once', () => {
    const rows = [row(), row(), row({ ts: '2026-08-21T00:00:00.000Z' })];
    expect(filterLedgerRows(rows).length).toBe(1);
    expect(aggregateLensPrecision(rows).totals.decided).toBe(1);
    expect(ledgerRowKey(row())).toBe('triage_decision|c1|rf_0000000000000001|fix_now');
  });

  test('since / last / lens windows', () => {
    const now = Date.parse('2026-08-26T00:00:00.000Z');
    const rows = [
      row({ ts: '2026-07-01T00:00:00.000Z', reviewed_commit: 'old' }),
      row({ ts: '2026-08-20T00:00:00.000Z', reviewed_commit: 'mid', finding: finding({ finding_id: 'rf_0000000000000002', lens: 'docs' }) }),
      row({ ts: '2026-08-25T00:00:00.000Z', reviewed_commit: 'new', finding: finding({ finding_id: 'rf_0000000000000003' }), decision: 'false_positive' }),
    ];
    expect(aggregateLensPrecision(rows, { since: '30d', now }).window.reviews).toBe(2);
    expect(aggregateLensPrecision(rows, { since: 2 * 86400000, now }).window.reviews).toBe(1);
    const lastTwo = aggregateLensPrecision(rows, { last: 2, now });
    expect(lastTwo.window.reviews).toBe(2);
    expect(lastTwo.totals.decided).toBe(2);
    const onlyLogic = aggregateLensPrecision(rows, { lens: 'logic', now });
    expect(onlyLogic.lenses.map(b => b.lens)).toEqual(['logic']);
    expect(onlyLogic.totals).toMatchObject({ fix_now: 1, false_positive: 1, precision: 0.5 });
  });

  test('lensesBelowPrecision flags measured lenses under the threshold only', () => {
    const rows = [
      row({ decision: 'false_positive' }),
      row({ finding: finding({ finding_id: 'rf_0000000000000002', lens: 'docs' }), decision: 'backlog' }),
    ];
    const report = aggregateLensPrecision(rows);
    expect(lensesBelowPrecision(report, 0.7).map(b => b.lens)).toEqual(['logic']);
    const text = formatPrecisionReport(report);
    expect(text).toContain('logic');
    expect(text).toContain('precision = fix_now / (fix_now + false_positive)');
  });
});

// ── CLI flow: verify-review-fix appends, review-precision aggregates ─────

describe('review-precision: ledger written by verify-review-fix', () => {
  test('passing gate appends one decision row per triage-required finding, idempotently', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-rp-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp);
      initAndEditTriage(tmp, triage => {
        triage.target_findings[0].evidence = 'Reproduced by auth test';
        triage.target_findings[1].decision = 'false_positive';
        triage.target_findings[1].evidence = 'redirect target is allowlisted at src/auth.ts:12';
        triage.verification = ['bun test auth'];
      });

      const first = run(['verify-review-fix'], { cwd: tmp });
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain('Triage ledger: +2 row(s)');
      const rows = ledgerRows(tmp);
      expect(rows.length).toBe(2);
      expect(rows.map(r => r.decision)).toEqual(['fix_now', 'false_positive']);
      expect(rows.map(r => r.lens)).toEqual(['logic', 'security']);
      expect(rows[0]).toMatchObject({ schema_v: 1, type: 'triage_decision', reviewed_commit: 'abc1234', id: 'F1', severity: 'high', file: 'src/auth.ts' });
      expect(rows[0].finding_id).toMatch(/^rf_[0-9a-f]{16}$/);
      // no finding text leaks into the ledger
      expect(JSON.stringify(rows)).not.toContain('Auth bypass');

      const second = run(['verify-review-fix'], { cwd: tmp });
      expect(second.exitCode).toBe(0);
      expect(second.stdout).not.toContain('Triage ledger');
      expect(ledgerRows(tmp).length).toBe(2);

      // reverification outcome is appended as its own row
      writeFileSync(join(tmp, 'src', 'auth.ts'), 'fixed\n');
      const reverify = run(['verify-review-fix', '--reverify', 'F1', '--outcome', 'resolved', '--evidence', 'auth test passes'], { cwd: tmp });
      expect(reverify.exitCode).toBe(0);
      const afterReverify = ledgerRows(tmp);
      expect(afterReverify.length).toBe(3);
      expect(afterReverify[2]).toMatchObject({ type: 'triage_outcome', outcome: 'resolved', lens: 'logic', id: 'F1' });

      const report = run(['review-precision', '--json'], { cwd: tmp });
      expect(report.exitCode).toBe(0);
      const json = JSON.parse(report.stdout);
      expect(json.status).toBe('ok');
      expect(json.totals).toMatchObject({ decided: 2, fix_now: 1, false_positive: 1, precision: 0.5, resolved: 1 });
      expect(json.lenses.find(b => b.lens === 'security')).toMatchObject({ false_positive: 1, precision: 0 });
      expect(json.lenses.find(b => b.lens === 'logic')).toMatchObject({ fix_now: 1, precision: 1, resolved: 1 });

      const table = run(['review-precision'], { cwd: tmp });
      expect(table.exitCode).toBe(0);
      expect(table.stdout).toContain('Review lens precision');
      expect(table.stdout).toContain('security');

      const gated = run(['review-precision', '--min-precision', '0.7'], { cwd: tmp });
      expect(gated.exitCode).toBe(2);
      expect(gated.stdout).toContain('Below --min-precision');
      expect(run(['review-precision', '--lens', 'logic', '--min-precision', '0.7'], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a blocked gate writes no decision rows', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-rp-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp);
      initAndEditTriage(tmp, triage => {
        triage.target_findings[0].evidence = 'Reproduced';
        triage.target_findings[1].decision = 'false_positive'; // evidence deliberately missing → blocked
      });
      const r = run(['verify-review-fix'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain('false_positive requires evidence');
      expect(ledgerRows(tmp)).toEqual([]);
      expect(existsSync(join(tmp, '.xm', 'review', 'triage-ledger.jsonl'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('persistent outcome is recorded even though the gate stays blocked', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-rp-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp, { findings: [
        { severity: 'high', lens: 'logic', file: 'src/auth.ts', line: 42, summary: 'Auth bypass on missing token' },
      ] });
      initAndEditTriage(tmp, triage => { triage.target_findings[0].evidence = 'Reproduced'; });
      expect(run(['verify-review-fix'], { cwd: tmp }).exitCode).toBe(0);
      writeFileSync(join(tmp, 'src', 'auth.ts'), 'attempted fix\n');
      const persistent = run(['verify-review-fix', '--reverify', 'F1', '--outcome', 'persistent', '--evidence', 'bug still reproduces'], { cwd: tmp });
      expect(persistent.exitCode).not.toBe(0);
      expect(persistent.stdout).toContain('Triage ledger: +1 outcome row(s)');
      const rows = ledgerRows(tmp);
      expect(rows.filter(r => r.type === 'triage_outcome').map(r => r.outcome)).toEqual(['persistent']);
      const json = JSON.parse(run(['review-precision', '--json'], { cwd: tmp }).stdout);
      expect(json.lenses[0]).toMatchObject({ lens: 'logic', fix_now: 1, persistent: 1 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('review-precision without a ledger explains how rows are produced', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-rp-'));
    try {
      setupProject(tmp);
      const r = run(['review-precision'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('No triage ledger yet');
      const j = JSON.parse(run(['review-precision', '--json'], { cwd: tmp }).stdout);
      expect(j.status).toBe('no_ledger');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects malformed window flags', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-rp-'));
    try {
      setupProject(tmp);
      expect(run(['review-precision', '--since', 'soon'], { cwd: tmp }).exitCode).toBe(1);
      expect(run(['review-precision', '--last', '0'], { cwd: tmp }).exitCode).toBe(1);
      expect(run(['review-precision', '--min-precision', '7'], { cwd: tmp }).exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
