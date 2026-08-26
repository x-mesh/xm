// x-trace drift — isolated contract tests (temp .xm per test, CLI as a subprocess).
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectCostRows, collectEvalRows, collectPrecisionRows, collectTraceRows,
  compareWindows, driftReport, formatDriftReport, parseTraceFileName, readJsonl,
  MAX_EVAL_SCORE_BYTES, THRESHOLDS,
} from '../x-trace/lib/x-trace/drift.mjs';

const CLI = fileURLToPath(new URL('../x-trace/lib/x-trace-cli.mjs', import.meta.url));
const NOW = '2026-08-26T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY = 86400000;
const tmpdirs = [];
afterAll(() => { for (const d of tmpdirs) rmSync(d, { recursive: true, force: true }); });

function makeXm() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-drift-'));
  tmpdirs.push(dir);
  mkdirSync(join(dir, '.xm', 'traces'), { recursive: true });
  return dir;
}

function runCli(dir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, XM_ROOT: join(dir, '.xm') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runCliAsync(dir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir, env: { ...process.env, XM_ROOT: join(dir, '.xm') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

const iso = (daysAgo, hour = 12) => new Date(NOW_MS - daysAgo * DAY + hour * 3600000).toISOString();
const stamp = (daysAgo) => { const d = new Date(NOW_MS - daysAgo * DAY); return `${d.toISOString().slice(0, 10).replace(/-/g, '')}-120000`; };

/** One trace file per session: N agent steps of `durationMs` on (skill, role, model). */
function writeTrace(dir, { skill = 'review', role = 'se', model = 'sonnet', daysAgo, durationMs, tokens = null, status = 'success', suffix = '', steps = 1, hex = 'ab12' }) {
  const id = `${skill}-${stamp(daysAgo)}-${hex}`;
  const lines = [JSON.stringify({ type: 'session_start', skill, session_id: id, ts: iso(daysAgo), v: 1 })];
  for (let i = 0; i < steps; i++) {
    const entry = { type: 'agent_step', id: `s${i}`, role, model, duration_ms: durationMs, status: 'success', session_id: id, ts: iso(daysAgo, 12 + i), v: 1 };
    if (tokens) entry.tokens_est = { input: tokens, output: tokens, precision: 'estimate' };
    lines.push(JSON.stringify(entry));
  }
  lines.push(JSON.stringify({ type: 'session_end', status, total_duration_ms: durationMs * steps, agent_count: steps, session_id: id, ts: iso(daysAgo, 13), v: 1 }));
  writeFileSync(join(dir, '.xm', 'traces', `${id}${suffix}.jsonl`), lines.join('\n') + '\n');
}

describe('drift: pure helpers', () => {
  test('parseTraceFileName handles hyphenated skills and multi-host suffixes', () => {
    expect(parseTraceFileName('x-recall-20260825-140019-94b2.jsonl')).toMatchObject({ skill: 'x-recall' });
    expect(parseTraceFileName('review-20260801-000000-abcd.jinwoo-MeshStudio.local-5135.jsonl').skill).toBe('review');
    expect(Number.isFinite(parseTraceFileName('review-20260801-000000-abcd.jsonl').fileTime)).toBe(true);
    expect(parseTraceFileName('garbage.jsonl').skill).toBe('unknown');
  });

  test('compareWindows splits by time, requires min samples on both sides, and flags by axis threshold', () => {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push({ ts: NOW_MS - (10 + i) * DAY, k: 'a', v: 100 });
    for (let i = 0; i < 6; i++) rows.push({ ts: NOW_MS - (1 + i * 0.5) * DAY, k: 'a', v: 140 });
    for (let i = 0; i < 2; i++) rows.push({ ts: NOW_MS - (2 + i) * DAY, k: 'b', v: 900 });
    rows.push({ ts: NOW_MS - 100 * DAY, k: 'a', v: 5 }); // outside both periods
    const out = compareWindows(rows, { axis: 'latency', now: NOW_MS, windowMs: 7 * DAY, baselineMs: 28 * DAY, minSamples: 5, keyOf: r => r.k, statOf: rs => rs.reduce((s, r) => s + r.v, 0) / rs.length });
    const a = out.find(r => r.key === 'a');
    expect(a).toMatchObject({ baseline: { n: 6, value: 100 }, window: { n: 6, value: 140 }, flagged: true, enough_samples: true });
    expect(a.delta_pct).toBe(0.4);
    const b = out.find(r => r.key === 'b');
    expect(b.enough_samples).toBe(false);
    expect(b.flagged).toBe(false);
    expect(out[0].key).toBe('a'); // flagged rows sort first
  });

  test('quality and precision flag on absolute drops; errors on percentage points', () => {
    expect(THRESHOLDS.quality).toMatchObject({ kind: 'abs', direction: 'down', value: 0.5 });
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ ts: NOW_MS - (10 + i) * DAY, k: 'general/refine', v: 8.4 });
    for (let i = 0; i < 5; i++) rows.push({ ts: NOW_MS - (1 + i) * DAY, k: 'general/refine', v: 7.8 });
    const out = compareWindows(rows, { axis: 'quality', now: NOW_MS, windowMs: 7 * DAY, baselineMs: 28 * DAY, minSamples: 5, keyOf: r => r.k, statOf: rs => rs.reduce((s, r) => s + r.v, 0) / rs.length });
    expect(out[0].flagged).toBe(true);
    expect(out[0].delta).toBe(-0.6);
  });

  test('ratio axes flag a worsening from a zero baseline', () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ ts: NOW_MS - (10 + i) * DAY, k: 'zero', v: 0 });
    for (let i = 0; i < 5; i++) rows.push({ ts: NOW_MS - (1 + i) * DAY, k: 'zero', v: 1 });
    const out = compareWindows(rows, { axis: 'cost', now: NOW_MS, windowMs: 7 * DAY, baselineMs: 28 * DAY, minSamples: 5, keyOf: r => r.k, statOf: rs => rs.reduce((s, r) => s + r.v, 0) / rs.length });
    expect(out[0]).toMatchObject({ baseline: { value: 0 }, window: { value: 1 }, flagged: true, delta: 1, delta_pct: null });
  });

  test('quality collector accepts only bounded regular score records with supported schema and types', () => {
    const dir = makeXm();
    const results = join(dir, '.xm', 'eval', 'results');
    mkdirSync(results, { recursive: true });
    const score = (name, patch = {}) => writeFileSync(join(results, name), JSON.stringify({
      schema_v: 1, type: 'score', timestamp: NOW, rubric: ' Code-Quality ', source_strategy: ' Refine ', overall: 8.2, ...patch,
    }));
    score('valid-score.json');
    score('wrong-type-score.json', { type: 'compare' });
    score('wrong-schema-score.json', { schema_v: 2 });
    score('null-schema-score.json', { schema_v: null });
    score('string-overall-score.json', { overall: '8.2' });
    score('range-overall-score.json', { overall: 11 });
    score('bad-rubric-score.json', { rubric: 'x'.repeat(65) });
    score('bad-strategy-score.json', { source_strategy: '../escape' });
    writeFileSync(join(results, 'oversize-score.json'), 'x'.repeat(MAX_EVAL_SCORE_BYTES + 1));
    mkdirSync(join(results, 'directory-score.json'));
    const outside = join(dir, 'outside-score.json');
    writeFileSync(outside, JSON.stringify({ type: 'score', timestamp: NOW, overall: 10 }));
    symlinkSync(outside, join(results, 'symlink-score.json'));

    expect(collectEvalRows(results)).toEqual({
      rows: [{ ts: NOW_MS, rubric: 'code-quality', strategy: 'refine', overall: 8.2, passed: false }],
      skipped: 10,
    });
    const report = driftReport({ xmDir: join(dir, '.xm'), now: NOW_MS, axes: ['quality'] });
    expect(report.coverage).toContain('quality: 10 invalid, oversized, or symlinked score file(s) skipped');
  });

  test('JSONL reader rejects unsafe files and enforces file, line, and row bounds', () => {
    const dir = makeXm();
    const base = join(dir, '.xm');
    const rowsPath = join(base, 'bounded.jsonl');
    writeFileSync(rowsPath, ['{"id":1}', '{"id":2}', '{"id":3}'].join('\n') + '\n');
    expect(readJsonl(rowsPath, { maxFileBytes: 1024, maxLineBytes: 64, maxRows: 2 })).toEqual({
      rows: [{ id: 1 }, { id: 2 }], skipped: 1,
    });

    const longLinePath = join(base, 'long-line.jsonl');
    writeFileSync(longLinePath, `${JSON.stringify({ pad: 'x'.repeat(80) })}\n{"ok":true}\n`);
    expect(readJsonl(longLinePath, { maxFileBytes: 1024, maxLineBytes: 32, maxRows: 10 })).toEqual({
      rows: [{ ok: true }], skipped: 1,
    });

    const oversizedPath = join(base, 'oversized.jsonl');
    writeFileSync(oversizedPath, 'x'.repeat(65));
    expect(readJsonl(oversizedPath, { maxFileBytes: 64 })).toEqual({ rows: [], skipped: 1 });
    const linkedPath = join(base, 'linked.jsonl');
    symlinkSync(rowsPath, linkedPath);
    expect(readJsonl(linkedPath)).toEqual({ rows: [], skipped: 1 });
    const directoryPath = join(base, 'directory.jsonl');
    mkdirSync(directoryPath);
    expect(readJsonl(directoryPath)).toEqual({ rows: [], skipped: 1 });
    const fifoPath = join(base, 'fifo.jsonl');
    expect(spawnSync('mkfifo', [fifoPath]).status).toBe(0);
    expect(readJsonl(fifoPath)).toEqual({ rows: [], skipped: 1 });

    const outside = mkdtempSync(join(tmpdir(), 'xm-drift-jsonl-outside-'));
    tmpdirs.push(outside);
    writeFileSync(join(outside, 'outside.jsonl'), '{"outside":true}\n');
    symlinkSync(outside, join(base, 'linked-parent'), 'dir');
    expect(readJsonl(join(base, 'linked-parent', 'outside.jsonl'), { boundary: base })).toEqual({ rows: [], skipped: 1 });
  });

  test('trace collector rejects a symlinked XM root instead of reading external traces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xm-drift-root-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'xm-drift-root-outside-'));
    tmpdirs.push(dir, outside);
    mkdirSync(join(outside, 'traces'), { recursive: true });
    symlinkSync(outside, join(dir, '.xm'), 'dir');
    const trace = join(outside, 'traces', 'review-20260825-120000-ab12.jsonl');
    writeFileSync(trace, JSON.stringify({ type: 'agent_step', ts: NOW, duration_ms: 10, status: 'success' }) + '\n');

    expect(collectTraceRows(join(dir, '.xm', 'traces'))).toMatchObject({ steps: [], sessions: [], skipped: 1 });
  });

  test('collectors canonicalize grouping identifiers and formatter strips terminal controls', () => {
    const dir = makeXm();
    const tracePath = join(dir, '.xm', 'traces', 'review-20260825-120000-ab12.jsonl');
    writeFileSync(tracePath, [
      { type: 'session_start', skill: '\x1b[31mReview\x1b[0m', session_id: 's1', ts: NOW },
      { type: 'agent_step', id: 'a1', role: ' S\x1b[32mE ', model: 'Son\nnet', duration_ms: 10, session_id: 's1', ts: NOW },
      { type: 'session_end', status: 'success', session_id: 's1', ts: NOW },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const trace = collectTraceRows(join(dir, '.xm', 'traces'));
    expect(trace.steps[0]).toMatchObject({ skill: 'review', role: 'se', model: 'sonnet' });
    expect(trace.sessions[0].skill).toBe('review');

    const precisionPath = join(dir, '.xm', 'review', 'triage-ledger.jsonl');
    mkdirSync(join(dir, '.xm', 'review'), { recursive: true });
    writeFileSync(precisionPath, [
      { schema_v: 1, type: 'triage_decision', ts: NOW, lens: '\x1b[31mLogic\x1b[0m', decision: 'fix_now' },
      { schema_v: 1, type: 'triage_decision', ts: NOW, lens: 'bad lens', decision: 'false_positive' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(collectPrecisionRows(precisionPath).rows.map(row => row.lens)).toEqual(['logic', 'unknown']);

    const report = {
      window: { spec: '7d', from: NOW, to: NOW }, baseline: { spec: '28d' }, min_samples: 1,
      xm_version: null, thresholds: THRESHOLDS, coverage: [],
      axes: { cost: { unit: 'cost', rows: [{ key: '\x1b[2Jmodel\nforged', baseline: { value: 1, n: 1 }, window: { value: 2, n: 1 }, delta: 1, delta_pct: 1, flagged: true, enough_samples: true }] } },
      flags: [{ axis: 'cost', key: '\x1b]0;owned\x07model\nforged' }],
    };
    const output = formatDriftReport(report);
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('\nforged\n');
  });
});

describe('drift: report over a seeded .xm', () => {
  test('flags a latency regression, suppresses thin keys, groups host-suffixed files, reads eval/cost/precision', () => {
    const dir = makeXm();
    // baseline: 6 sessions × review/se/sonnet at 1000ms (days 10..15), window: 6 sessions at 1600ms (days 1..6, one on a synced host)
    for (let i = 0; i < 6; i++) writeTrace(dir, { daysAgo: 10 + i, durationMs: 1000, tokens: 100, hex: `b${i}00` });
    for (let i = 0; i < 6; i++) writeTrace(dir, { daysAgo: 1 + i * 0.8, durationMs: 1600, tokens: 110, hex: `c${i}00`, suffix: i === 0 ? '.jinwoo-MeshStudio.local-5135' : '' });
    // Synced copy of the first window session must not become a second sample.
    writeTrace(dir, { daysAgo: 1, durationMs: 1600, tokens: 110, hex: 'c000' });
    // thin key: 2 op sessions only
    writeTrace(dir, { skill: 'op', role: 'leader', daysAgo: 12, durationMs: 500, hex: 'd100' });
    writeTrace(dir, { skill: 'op', role: 'leader', daysAgo: 2, durationMs: 5000, hex: 'd200' });
    // errors: build sessions failing more this week
    for (let i = 0; i < 5; i++) writeTrace(dir, { skill: 'build', daysAgo: 10 + i, durationMs: 100, status: 'success', hex: `e${i}00` });
    for (let i = 0; i < 5; i++) writeTrace(dir, { skill: 'build', daysAgo: 1 + i, durationMs: 100, status: i < 2 ? 'failed' : 'success', hex: `f${i}00` });
    // eval results: refine dropped by 0.9
    const results = join(dir, '.xm', 'eval', 'results');
    mkdirSync(results, { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(results, `b${i}-score.json`), JSON.stringify({ type: 'score', timestamp: iso(10 + i), rubric: 'general', source_strategy: 'refine', overall: 8.5, passed: true }));
    for (let i = 0; i < 5; i++) writeFileSync(join(results, `w${i}-score.json`), JSON.stringify({ type: 'score', timestamp: iso(1 + i), rubric: 'general', source_strategy: 'refine', overall: 7.6, passed: true }));
    // precision ledger: logic lens precision fell from 100% to 40%
    mkdirSync(join(dir, '.xm', 'review'), { recursive: true });
    const ledger = [];
    for (let i = 0; i < 5; i++) ledger.push({ schema_v: 1, type: 'triage_decision', ts: iso(10 + i), reviewed_commit: `b${i}`, finding_id: `rf_b${i}`, lens: 'logic', decision: 'fix_now' });
    for (let i = 0; i < 5; i++) ledger.push({ schema_v: 1, type: 'triage_decision', ts: iso(1 + i), reviewed_commit: `w${i}`, finding_id: `rf_w${i}`, lens: 'logic', decision: i < 2 ? 'fix_now' : 'false_positive' });
    writeFileSync(join(dir, '.xm', 'review', 'triage-ledger.jsonl'), ledger.map(r => JSON.stringify(r)).join('\n') + '\n');
    // cost: no ledger → coverage note

    const report = driftReport({ xmDir: join(dir, '.xm'), now: NOW_MS });
    const latency = report.axes.latency.rows.find(r => r.key === 'review/se/sonnet');
    expect(latency).toMatchObject({ baseline: { n: 6, value: 1000 }, window: { n: 6, value: 1600 }, flagged: true });
    expect(report.axes.latency.rows.find(r => r.key === 'op/leader/sonnet')).toMatchObject({ enough_samples: false, flagged: false });
    expect(report.axes.tokens.rows.find(r => r.key === 'review/se/sonnet')).toMatchObject({ flagged: false, baseline: { value: 200 }, window: { value: 220 } });
    expect(report.axes.errors.rows.find(r => r.key === 'build')).toMatchObject({ baseline: { value: 0 }, window: { value: 0.4 }, flagged: true });
    expect(report.axes.quality.rows.find(r => r.key === 'general/refine')).toMatchObject({ baseline: { value: 8.5 }, window: { value: 7.6 }, flagged: true });
    expect(report.axes.precision.rows.find(r => r.key === 'logic')).toMatchObject({ baseline: { value: 1 }, window: { value: 0.4 }, flagged: true });
    expect(report.axes.cost.rows).toEqual([]);
    expect(report.coverage.some(n => n.startsWith('cost:'))).toBe(true);
    expect(report.flags.map(f => `${f.axis}:${f.key}`).sort()).toEqual(['errors:build', 'latency:review/se/sonnet', 'precision:logic', 'quality:general/refine']);
    expect(typeof report.xm_version === 'string' || report.xm_version === null).toBe(true);
  });

  test('uses independent sessions for step metrics and excludes unknown error statuses', () => {
    const dir = makeXm();
    for (let i = 0; i < 5; i++) writeTrace(dir, { daysAgo: 10 + i, durationMs: 100, tokens: 10, steps: 3, status: i === 0 ? 'completed' : 'success', hex: `a${i}11` });
    for (let i = 0; i < 5; i++) writeTrace(dir, { daysAgo: 1 + i, durationMs: 200, tokens: 20, steps: 3, status: i === 0 ? 'unknown' : (i < 3 ? 'failed' : 'error'), hex: `b${i}11` });

    const report = driftReport({ xmDir: join(dir, '.xm'), now: NOW_MS, minSamples: 4 });
    expect(report.axes.latency.rows[0]).toMatchObject({ baseline: { n: 5, value: 300 }, window: { n: 5, value: 600 }, flagged: true });
    expect(report.axes.tokens.rows[0]).toMatchObject({ baseline: { n: 5, value: 60 }, window: { n: 5, value: 120 }, flagged: true });
    expect(report.axes.errors.rows[0]).toMatchObject({ baseline: { n: 5, value: 0 }, window: { n: 4, value: 1 }, flagged: true });
    expect(report.coverage.some(note => note.includes('unknown status excluded'))).toBe(true);
  });

  test('precision sample counts use only fix_now and false_positive decisions', () => {
    const dir = makeXm();
    mkdirSync(join(dir, '.xm', 'review'), { recursive: true });
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ schema_v: 1, type: 'triage_decision', ts: iso(10 + i), lens: 'logic', decision: 'backlog' });
    rows.push({ schema_v: 1, type: 'triage_decision', ts: iso(10), lens: 'logic', decision: 'fix_now' });
    for (let i = 0; i < 5; i++) rows.push({ schema_v: 1, type: 'triage_decision', ts: iso(1 + i), lens: 'logic', decision: 'false_positive' });
    writeFileSync(join(dir, '.xm', 'review', 'triage-ledger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');

    const report = driftReport({ xmDir: join(dir, '.xm'), now: NOW_MS, axes: ['precision'] });
    expect(report.axes.precision.rows[0]).toMatchObject({ baseline: { n: 1, value: 1 }, window: { n: 5, value: 0 }, enough_samples: false, flagged: false });
  });

  test('precision collector attributes one normalized sample to every contributing lens', () => {
    const dir = makeXm();
    const reviewDir = join(dir, '.xm', 'review');
    mkdirSync(reviewDir, { recursive: true });
    const ledgerPath = join(reviewDir, 'triage-ledger.jsonl');
    const rows = [
      { schema_v: 1, type: 'triage_decision', ts: iso(10), lens: ' Logic ', lenses: ['security', 'LOGIC', 'Performance'], decision: 'fix_now' },
      { schema_v: 1, type: 'triage_decision', ts: iso(1), lenses: [' Security '], decision: 'false_positive' },
      { schema_v: 1, type: 'triage_decision', ts: iso(1), decision: 'backlog' },
    ];
    writeFileSync(ledgerPath, rows.map(entry => JSON.stringify(entry)).join('\n') + '\n');

    expect(collectPrecisionRows(ledgerPath).rows).toEqual([
      { ts: Date.parse(iso(10)), lens: 'logic', decision: 'fix_now' },
      { ts: Date.parse(iso(10)), lens: 'security', decision: 'fix_now' },
      { ts: Date.parse(iso(10)), lens: 'performance', decision: 'fix_now' },
      { ts: Date.parse(iso(1)), lens: 'security', decision: 'false_positive' },
      { ts: Date.parse(iso(1)), lens: 'unknown', decision: 'backlog' },
    ]);
  });

  test('reads active and rotated cost logs, deduplicates event_id, and keeps cost sources separate', () => {
    const dir = makeXm();
    const metrics = join(dir, '.xm', 'metrics');
    mkdirSync(metrics, { recursive: true });
    const event = (eventId, daysAgo, cost, source) => ({ type: 'task_complete', event_id: eventId, timestamp: iso(daysAgo), model: 'sonnet', role: 'executor', cost_source: source, cost_usd: cost });
    const rotated = [event('b1', 10, 1, 'actual'), event('b2', 11, 1, 'actual'), event('dup', 12, 1, 'actual')];
    const active = [
      event('w1', 1, 2, 'actual'), event('w2', 2, 2, 'actual'), event('dup', 12, 99, 'actual'),
      event('e1', 1, 50, 'estimated'), event('e2', 2, 50, 'estimated'),
      event('negative', 1, -1, 'actual'), event('string', 1, '3', 'actual'),
    ];
    writeFileSync(join(metrics, 'sessions.jsonl.1'), rotated.map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(metrics, 'sessions.jsonl'), active.map(row => JSON.stringify(row)).join('\n') + '\n');

    const collected = collectCostRows([join(metrics, 'sessions.jsonl.1'), join(metrics, 'sessions.jsonl')]);
    expect(collected.invalid).toBe(2);
    expect(collected.rows.every(row => typeof row.cost_usd === 'number' && row.cost_usd >= 0)).toBe(true);
    const report = driftReport({ xmDir: join(dir, '.xm'), now: NOW_MS, axes: ['cost'], minSamples: 2 });
    expect(report.axes.cost.rows.find(row => row.key === 'sonnet/executor/actual')).toMatchObject({ baseline: { n: 3, value: 1 }, window: { n: 2, value: 2 }, flagged: true });
    expect(report.axes.cost.rows.find(row => row.key === 'sonnet/executor/estimated')).toMatchObject({ baseline: { n: 0 }, window: { n: 2, value: 50 }, enough_samples: false, flagged: false });
    expect(report.coverage.some(note => note.includes('duplicate event_id'))).toBe(true);
    expect(report.coverage).toContain('cost: 2 task_complete row(s) with invalid timestamp or cost that is not a finite non-negative number skipped');
  });

  test('CLI: --json schema, snapshot append, --axis filter, --fail-on-flag exit 2, bad --window exit 1', () => {
    const dir = makeXm();
    for (let i = 0; i < 5; i++) writeTrace(dir, { daysAgo: 10 + i, durationMs: 1000, hex: `a${i}00` });
    for (let i = 0; i < 5; i++) writeTrace(dir, { daysAgo: 1 + i, durationMs: 2000, hex: `b${i}00` });

    const out = runCli(dir, ['drift', '--json', '--now', NOW]);
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout);
    expect(report.schema_v).toBe(1);
    expect(report.window.spec).toBe('7d');
    expect(report.flags.length).toBe(1);
    expect(report.snapshot_path).toBe(join(dir, '.xm', 'metrics', 'drift.jsonl'));
    const snapshot = readFileSync(report.snapshot_path, 'utf8').trim().split('\n');
    expect(snapshot.length).toBe(1);
    const row = JSON.parse(snapshot[0]);
    expect(row).toMatchObject({ type: 'drift_snapshot', window: '7d', baseline: '28d' });
    expect(row.flags[0]).toMatchObject({ axis: 'latency', key: 'review/se/sonnet', baseline: 1000, window: 2000 });
    expect(JSON.stringify(row)).not.toContain('prompt');
    expect(statSync(report.snapshot_path).mode & 0o777).toBe(0o600);

    const quiet = runCli(dir, ['drift', '--axis', 'quality,cost', '--no-snapshot', '--now', NOW]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toContain('no drift flags');
    expect(quiet.stdout).toContain('Note: quality');
    expect(readFileSync(report.snapshot_path, 'utf8').trim().split('\n').length).toBe(1); // --no-snapshot did not append

    const gated = runCli(dir, ['drift', '--fail-on-flag', '--no-snapshot', '--now', NOW]);
    expect(gated.code).toBe(2);
    expect(gated.stdout).toContain('⚠ 1 flag(s)');

    expect(runCli(dir, ['drift', '--window', 'soon', '--no-snapshot']).code).toBe(1);
    expect(runCli(dir, ['drift', '--axis', 'vibes', '--no-snapshot']).code).toBe(1);
    expect(runCli(dir, ['drift', '--axis', ', ,', '--no-snapshot']).code).toBe(1);
    expect(runCli(dir, ['drift', '--axis', '', '--no-snapshot']).code).toBe(1);
    const normalized = runCli(dir, ['drift', '--axis', ' Quality, COST,quality ', '--no-snapshot', '--now', NOW]);
    expect(normalized.code).toBe(0);
    expect(normalized.stdout).toContain('## quality');
    expect(normalized.stdout).toContain('## cost');
    expect(runCli(dir, ['drift', '--min-samples', '0', '--no-snapshot']).code).toBe(1);
    const typo = runCli(dir, ['drift', '--fail-on-flags', 'yes', '--no-snapshot']);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('unknown option --fail-on-flags');
    expect(runCli(dir, ['drift', 'unexpected', '--no-snapshot']).code).toBe(1);
    const missingValue = runCli(dir, ['drift', '--window', '--json']);
    expect(missingValue.code).toBe(1);
    expect(missingValue.stderr).toContain('--window requires a value');
    expect(runCli(dir, ['drift', '--now', '--json']).code).toBe(1);
    expect(runCli(dir, ['record', 'review', '--status']).code).toBe(1);
  });

  test('snapshot rejects symlinked roots, metrics directories, and files without writing outside .xm', () => {
    const outside = mkdtempSync(join(tmpdir(), 'xm-drift-outside-'));
    tmpdirs.push(outside);

    const metricsLink = makeXm();
    symlinkSync(outside, join(metricsLink, '.xm', 'metrics'), 'dir');
    const dirResult = runCli(metricsLink, ['drift', '--json', '--now', NOW]);
    expect(dirResult.code).toBe(1);
    expect(dirResult.stderr).toContain('metrics');
    expect(existsSync(join(outside, 'drift.jsonl'))).toBe(false);

    const fileLink = makeXm();
    const metrics = join(fileLink, '.xm', 'metrics');
    mkdirSync(metrics);
    const outsideFile = join(outside, 'outside-drift.jsonl');
    writeFileSync(outsideFile, 'sentinel\n');
    symlinkSync(outsideFile, join(metrics, 'drift.jsonl'));
    const fileResult = runCli(fileLink, ['drift', '--json', '--now', NOW]);
    expect(fileResult.code).toBe(1);
    expect(fileResult.stderr).toContain('drift.jsonl');
    expect(readFileSync(outsideFile, 'utf8')).toBe('sentinel\n');

    const linkedRootHost = mkdtempSync(join(tmpdir(), 'xm-drift-root-link-'));
    tmpdirs.push(linkedRootHost);
    symlinkSync(outside, join(linkedRootHost, '.xm'), 'dir');
    const rootResult = runCli(linkedRootHost, ['drift', '--json', '--now', NOW]);
    expect(rootResult.code).toBe(1);
    expect(rootResult.stderr).toContain('.xm root');
  });

  test('snapshot uses one no-follow append per row under concurrent writers', async () => {
    const dir = makeXm();
    const results = await Promise.all(Array.from({ length: 12 }, () => runCliAsync(dir, ['drift', '--json', '--now', NOW])));
    expect(results.every(result => result.code === 0)).toBe(true);
    const snapshotPath = join(dir, '.xm', 'metrics', 'drift.jsonl');
    const lines = readFileSync(snapshotPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(12);
    expect(lines.every(line => JSON.parse(line).type === 'drift_snapshot')).toBe(true);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
  });

  test('CLI on an empty .xm reports coverage gaps instead of zeros', () => {
    const dir = makeXm();
    rmSync(join(dir, '.xm', 'traces'), { recursive: true, force: true });
    const out = runCli(dir, ['drift', '--no-snapshot', '--json', '--now', NOW]);
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout);
    expect(report.flags).toEqual([]);
    expect(report.coverage.some(n => n.startsWith('traces:'))).toBe(true);
    expect(existsSync(join(dir, '.xm', 'metrics', 'drift.jsonl'))).toBe(false);
  });
});
