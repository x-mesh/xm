// x-trace drift — isolated contract tests (temp .xm per test, CLI as a subprocess).
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareWindows, parseTraceFileName, driftReport, THRESHOLDS } from '../x-trace/lib/x-trace/drift.mjs';

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
});

describe('drift: report over a seeded .xm', () => {
  test('flags a latency regression, suppresses thin keys, groups host-suffixed files, reads eval/cost/precision', () => {
    const dir = makeXm();
    // baseline: 6 sessions × review/se/sonnet at 1000ms (days 10..15), window: 6 sessions at 1600ms (days 1..6, one on a synced host)
    for (let i = 0; i < 6; i++) writeTrace(dir, { daysAgo: 10 + i, durationMs: 1000, tokens: 100, hex: `b${i}00` });
    for (let i = 0; i < 6; i++) writeTrace(dir, { daysAgo: 1 + i * 0.8, durationMs: 1600, tokens: 110, hex: `c${i}00`, suffix: i === 0 ? '.jinwoo-MeshStudio.local-5135' : '' });
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
    expect(runCli(dir, ['drift', '--min-samples', '0', '--no-snapshot']).code).toBe(1);
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
