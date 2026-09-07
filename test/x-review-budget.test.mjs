import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { createHash } from 'node:crypto';
import { authorizeReviewFix } from '../x-review/lib/review-budget.mjs';

const CLI = join(import.meta.dirname, '..', 'x-review', 'lib', 'x-review-cli.mjs');
const PANEL = join(import.meta.dirname, 'fixtures', 'fake-review-panel.mjs');
const dirs = [];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'review-budget-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(dir, 'target.patch'), 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n');
  git(dir, 'init'); git(dir, 'config', 'user.email', 'review@example.test'); git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'fixture');
  return dir;
}
function environment(dir, extra = {}) { return { ...process.env, XM_REVIEW_ROOT: join(dir, '.xm'), XM_REVIEW_PANEL_COMMAND: JSON.stringify(['node', PANEL]), ...extra }; }
function cli(dir, args, extra = {}) { return spawnSync('node', [CLI, ...args, '--no-trace', '--json'], { cwd: dir, env: environment(dir, extra), encoding: 'utf8' }); }
function ok(result) { expect(result.stderr).toBe(''); expect(result.status).toBe(0); return JSON.parse(result.stdout); }
function start(dir, id, extra = {}, args = []) { return ok(cli(dir, ['run', 'target.patch', '--lenses', 'correctness', '--run-id', id, ...args], extra)); }
const budget = dir => read(join(dir, '.xm/review/budget.json'));
const runFile = (dir, id, file) => join(dir, '.xm/review/runs', id, file);
function change(dir, value = 3) { writeFileSync(join(dir, 'src/a.js'), `export const a = ${value};\nexport const b = 2;\n`); }
function concurrent(dir, args, extra = {}) {
  return new Promise(resolve => {
    const child = spawn('node', [CLI, ...args, '--no-trace', '--json'], { cwd: dir, env: environment(dir, extra) });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => resolve({ stdout, stderr, status }));
  });
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('worktree review budgets', () => {
  test('persists full usage across processes, HEAD changes and PR association', () => {
    const dir = workspace(); start(dir, 'first-run'); change(dir); git(dir, 'add', 'src/a.js'); git(dir, 'commit', '-m', 'change');
    const second = start(dir, 'second', {}, ['--repo', 'owner/repo', '--pr', '12']);
    expect(second.review_mode).toBe('delta');
    const task = budget(dir).tasks['pr:owner/repo#12'];
    expect(task.used).toEqual({ full: 1, fix: 0, delta: 1 });
    change(dir, 4);
    expect(cli(dir, ['run', '--lenses', 'correctness', '--run-id', 'third']).stderr).toContain('delta budget exhausted');
    expect(existsSync(runFile(dir, 'third', 'run.json'))).toBe(false);
  });

  test('uses each task baseline instead of global last-result', () => {
    const dir = workspace(); start(dir, 'task-a-full', {}, ['--task-id', 'a']);
    change(dir, 3); start(dir, 'task-b-full', {}, ['--task-id', 'b']); change(dir, 4);
    start(dir, 'task-a-delta', {}, ['--task-id', 'a']);
    const manifest = read(runFile(dir, 'task-a-delta', 'run.json'));
    expect(manifest.baseline).toBe('task-a-full');
    const patch = readFileSync(runFile(dir, 'task-a-delta', 'target.patch'), 'utf8');
    expect(patch).toContain('-export const a = 1;'); expect(patch).toContain('+export const a = 4;');
  });

  test('allows the same PR independently in another worktree', () => {
    const dir = workspace(); const other = `${dir}-linked`; dirs.push(other);
    git(dir, 'worktree', 'add', '-b', 'linked', other);
    for (const cwd of [dir, other]) start(cwd, 'same-id', {}, ['--repo', 'owner/repo', '--pr', '12']);
    expect(budget(dir).tasks['pr:owner/repo#12'].used.full).toBe(1);
    expect(budget(other).tasks['pr:owner/repo#12'].used.full).toBe(1);
    expect(budget(dir).tasks['pr:owner/repo#12'].id).not.toBe(budget(other).tasks['pr:owner/repo#12'].id);
  });

  test('rejects state symlinks into another worktree before mutation', () => {
    const dir = workspace(); const other = workspace(); start(other, 'other-run');
    const before = readFileSync(join(other, '.xm/review/budget.json'), 'utf8');
    symlinkSync(join(other, '.xm'), join(dir, '.xm'));
    const result = cli(dir, ['prepare', 'target.patch', '--task-id', 'foreign', '--run-id', 'foreign']);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(other, '.xm/review/budget.json'), 'utf8')).toBe(before);
    expect(existsSync(runFile(other, 'foreign', 'run.json'))).toBe(false);
  });

  test('requires an explicit task even with a PR on detached HEAD', () => {
    const dir = workspace(); git(dir, 'checkout', '--detach');
    expect(cli(dir, ['prepare', 'target.patch', '--pr', '12', '--repo', 'owner/repo']).stderr).toContain('Detached HEAD');
    ok(cli(dir, ['prepare', 'target.patch', '--task-id', 'detached', '--run-id', 'detached']));
    expect(Object.values(budget(dir).tasks)[0].used.full).toBe(1);
  });

  test('concurrent starts reserve exactly one full run', async () => {
    const dir = workspace();
    const results = await Promise.all(['run-one', 'run-two'].map(id => concurrent(dir, ['run', 'target.patch', '--lenses', 'correctness', '--run-id', id], { XM_FAKE_PANEL_DELAY_MS: '100' })));
    expect(results.filter(result => result.status === 0)).toHaveLength(1);
    expect(Object.values(budget(dir).tasks)[0].used).toEqual({ full: 1, fix: 0, delta: 0 });
  });

  test('close releases the active run without refunding usage or creating a baseline', () => {
    const dir = workspace(); ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'active']));
    expect(cli(dir, ['prepare', 'target.patch', '--run-id', 'blocked', '--exception', 'full', '--approved-by', 'user', '--reason', 'extra']).stderr).toContain('unfinished');
    ok(cli(dir, ['close', 'active', '--reason', 'user cancellation']));
    expect(read(runFile(dir, 'active', 'terminal.json')).outcome).toBe('cancelled');
    expect(budget(dir).active).toBeNull();
    expect(Object.values(budget(dir).tasks)[0].used.full).toBe(1);
    expect(Object.values(budget(dir).tasks)[0].baseline).toBeUndefined();
    expect(cli(dir, ['resume', 'active']).status).not.toBe(0);
    expect(cli(dir, ['prepare', 'target.patch', '--run-id', 'no-baseline']).status).not.toBe(0);
    ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'exception', '--exception', 'full', '--approved-by', 'user', '--reason', 'review after cancellation']));
    const task = Object.values(budget(dir).tasks)[0];
    expect(task.used.full).toBe(2); expect(task.approvals).toHaveLength(1);
  });

  test('refuses corrupted terminal validation receipts', () => {
    const dir = workspace(); start(dir, 'first-run'); change(dir);
    const path = runFile(dir, 'first-run', 'terminal.json'); const receipt = read(path); receipt.validation_hash = 'sha256:wrong'; writeFileSync(path, JSON.stringify(receipt));
    const result = cli(dir, ['prepare', 'target.patch', '--task-id', 'new']);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('receipt');
  });

  test('native empty replies receive one persisted retry and then an incomplete receipt', () => {
    const dir = workspace(); const prepared = ok(cli(dir, ['prepare', 'target.patch', '--lenses', 'correctness', '--run-id', 'native']));
    const worker = prepared.workers[0];
    const retried = ok(cli(dir, ['submit', 'native', '--report-id', worker.report_id, '--attempt-id', worker.attempt_id]));
    expect(retried.retry).toBe(true); expect(retried.worker.attempt).toBe(2); expect(retried.worker.report_id).toBe(worker.report_id); expect(retried.worker.attempt_id).not.toBe(worker.attempt_id);
    expect(cli(dir, ['submit', 'native', '--report-id', worker.report_id, '--attempt-id', worker.attempt_id]).stderr).toContain('stale');
    const failed = cli(dir, ['submit', 'native', '--report-id', worker.report_id, '--attempt-id', retried.worker.attempt_id]);
    expect(failed.status).not.toBe(0); expect(failed.stderr).toContain('Review incomplete');
    expect(read(runFile(dir, 'native', 'terminal.json')).outcome).toBe('incomplete');
    expect(cli(dir, ['resume', 'native']).status).not.toBe(0);
    expect(read(runFile(dir, 'native', `children/${worker.report_id}.json`)).attempt).toBe(2);
  });

  test('delta retains absent prior findings and stops on new Low findings', () => {
    const dir = workspace();
    ok(cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'first-run'], { XM_FAKE_PANEL_SEVERITY: 'high' }));
    change(dir, 3); start(dir, 'delta-run');
    const result = read(runFile(dir, 'delta-run', 'result.json'));
    expect(result.findings).toHaveLength(1); expect(result.findings[0].severity).toBe('High'); expect(result.verdict).toBe('Request Changes');
    const clean = workspace(); start(clean, 'clean-run'); change(clean, 3);
    const added = ok(cli(clean, ['run', '--lenses', 'risk', '--run-id', 'delta-run'], { XM_FAKE_PANEL_SEVERITY: 'low' }));
    expect(added.new_findings).toHaveLength(1); expect(added.automatic_stop).toBe(true);
  });

  test('Low findings block only when zero-findings is explicit at preparation', () => {
    for (const strict of [false, true]) {
      const dir = workspace();
      const result = ok(cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'low-run', ...(strict ? ['--zero-findings'] : [])], { XM_FAKE_PANEL_SEVERITY: 'low' }));
      expect(result.verdict).toBe(strict ? 'Request Changes' : 'LGTM');
    }
  });

  test('native accepts grounded zero findings and recovers a saved report before retry', () => {
    for (const saved of [false, true]) {
      const dir = workspace();
      const prepared = ok(cli(dir, ['prepare', 'target.patch', '--lenses', 'correctness', '--run-id', 'native-zero']));
      const worker = prepared.workers[0];
      const report = {
        schema_version: 1, task_id: 'native-zero', report_id: worker.report_id, lens: worker.lens,
        target_hash: worker.target_hash, status: 'complete', checked: ['Checked every changed export and its callers.'],
        checked_files: ['src/a.js'], findings: [], no_findings_reason: 'No defect remained after checking the export changes.',
      };
      const file = saved ? runFile(dir, 'native-zero', `reports/${worker.report_id}.json`) : join(dir, 'worker.json');
      writeFileSync(file, JSON.stringify(report));
      const submitted = ok(cli(dir, ['submit', 'native-zero', '--report-id', worker.report_id, '--attempt-id', worker.attempt_id, ...(saved ? [] : ['--report', file])]));
      expect(submitted.retry).toBe(false); expect(submitted.worker.attempt).toBe(1);
      const finalized = ok(cli(dir, ['finalize', 'native-zero']));
      expect(finalized.findings).toEqual([]); expect(read(runFile(dir, 'native-zero', 'terminal.json')).outcome).toBe('success');
    }
  });

  test('panel unusable reports stop after a single recovery across resume', () => {
    const dir = workspace(); const log = join(dir, '.xm', 'panel-calls.jsonl');
    const result = cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'empty-panel'], { XM_FAKE_PANEL_MODE: 'all-slots-unusable', XM_FAKE_PANEL_LOG: log });
    expect(result.status).not.toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(read(runFile(dir, 'empty-panel', 'terminal.json')).outcome).toBe('incomplete');
    expect(cli(dir, ['resume', 'empty-panel'], { XM_FAKE_PANEL_LOG: log }).status).not.toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('commit review deltas compare saved SHAs and exclude uncommitted bytes', () => {
    const dir = workspace(); const base = git(dir, 'rev-parse', 'HEAD');
    change(dir, 3); git(dir, 'add', 'src/a.js'); git(dir, 'commit', '-m', 'first change');
    ok(cli(dir, ['run', '--base-ref', base, '--lenses', 'correctness', '--run-id', 'commit-full']));
    change(dir, 4); git(dir, 'add', 'src/a.js'); git(dir, 'commit', '-m', 'second change'); change(dir, 5);
    ok(cli(dir, ['run', '--lenses', 'correctness', '--run-id', 'commit-delta']));
    const patch = readFileSync(runFile(dir, 'commit-delta', 'target.patch'), 'utf8');
    expect(patch).toContain('-export const a = 3;'); expect(patch).toContain('+export const a = 4;'); expect(patch).not.toContain('export const a = 5;');
  });

  test('active PR association preserves its reservation and worker identity', () => {
    const dir = workspace(); const prepared = ok(cli(dir, ['prepare', 'target.patch', '--lenses', 'correctness', '--run-id', 'before-pr']));
    ok(cli(dir, ['associate', 'before-pr', '--repo', 'owner/repo', '--pr', '21', '--reason', 'PR created for this task']));
    expect(budget(dir).active).toBe('before-pr'); expect(budget(dir).tasks['pr:owner/repo#21'].used.full).toBe(1);
    expect(read(runFile(dir, 'before-pr', `children/${prepared.workers[0].report_id}.json`)).attempt_id).toBe(prepared.workers[0].attempt_id);
  });


  test('fix authorization is idempotent and triage regeneration cannot reset its budget', async () => {
    const dir = workspace(); start(dir, 'fix-full'); const result = read(runFile(dir, 'fix-full', 'result.json'));
    await authorizeReviewFix(result, 'approved-scope', { cwd: dir });
    await authorizeReviewFix(result, 'approved-scope', { cwd: dir });
    expect(Object.values(budget(dir).tasks)[0].used.fix).toBe(1);
    await expect(authorizeReviewFix(result, 'regenerated-scope', { cwd: dir })).rejects.toThrow('fix budget exhausted');
    change(dir, 3); start(dir, 'fix-delta'); const delta = read(runFile(dir, 'fix-delta', 'result.json'));
    await expect(authorizeReviewFix(delta, 'post-delta-scope', { cwd: dir })).rejects.toThrow('delta');
    expect(Object.values(budget(dir).tasks)[0].used.fix).toBe(1);
  });

  test('legacy runs require explicit association and close without a success receipt', () => {
    const dir = workspace();
    ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'legacy-run']));
    const path = runFile(dir, 'legacy-run', 'run.json'); const manifest = read(path);
    delete manifest.task_budget_id; delete manifest.review_mode; delete manifest.snapshot; delete manifest.snapshot_hash;
    writeFileSync(path, JSON.stringify(manifest)); rmSync(join(dir, '.xm/review/budget.json'));
    expect(cli(dir, ['prepare', 'target.patch', '--run-id', 'new-review']).status).not.toBe(0);
    expect(cli(dir, ['associate', 'legacy-run', '--reason', 'legacy migration']).status).not.toBe(0);
    ok(cli(dir, ['associate', 'legacy-run', '--task-id', 'legacy-task', '--reason', 'user identified this task']));
    expect(existsSync(runFile(dir, 'legacy-run', 'terminal.json'))).toBe(false);
    // Adopting a run that produced no result is recovery, not review work: it must
    // leave the full unit intact so the next ordinary review still runs.
    expect(Object.values(budget(dir).tasks)[0].used.full).toBe(0);
    ok(cli(dir, ['close', 'legacy-run', '--reason', 'old run is no longer needed']));
    expect(read(runFile(dir, 'legacy-run', 'terminal.json')).outcome).toBe('cancelled');
    expect(Object.values(budget(dir).tasks)[0].baseline).toBeUndefined();
    ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'after-legacy', '--task-id', 'legacy-task']));
    expect(read(runFile(dir, 'after-legacy', 'run.json')).review_mode).toBe('full');
  });

  test('a new full review reopens a carried-forward finding instead of restoring its old row', () => {
    const dir = workspace();
    ok(cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'reopen-full'], { XM_FAKE_PANEL_SEVERITY: 'high' }));
    const path = join(dir, '.xm/review/finding-lifecycle.json'); const lifecycle = read(path);
    Object.assign(lifecycle.findings[0], { state: 'reverified', outcome: 'resolved', evidence: 'evidence from the previous round', file_snapshot: { exists: true, sha256: 'stale' } });
    writeFileSync(path, JSON.stringify(lifecycle));
    change(dir, 5);
    ok(cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'reopen-again', '--exception', 'full', '--approved-by', 'tester', '--reason', 'ask for another full pass'], { XM_FAKE_PANEL_SEVERITY: 'high' }));
    const row = read(path).findings[0];
    expect(row.state).toBe('open');
    expect(row.outcome).toBeNull();
    expect(row.evidence).toBeNull();
    expect(row.file_snapshot).toBeNull();
  });

  test('an aborted preparation leaves no run directory behind', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'empty.patch'), '');
    expect(cli(dir, ['prepare', 'empty.patch', '--run-id', 'aborted']).status).not.toBe(0);
    expect(existsSync(join(dir, '.xm/review/runs/aborted'))).toBe(false);
    ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'after-abort']));
  });

  test('a stray file in runs/ is not treated as a run', () => {
    const dir = workspace(); start(dir, 'stray-full'); change(dir, 3);
    writeFileSync(join(dir, '.xm/review/runs/.DS_Store'), 'not a run');
    ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'after-stray']));
  });

  test('a lock left by a dead process is reclaimed', async () => {
    const dir = workspace();
    const lock = join(dir, '.xm/review/lifecycle.lock');
    mkdirSync(lock, { recursive: true });
    // pid 2^22 + 1 is above every platform pid_max, so it can never be alive.
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 4194305, cwd: dir, started_at: new Date().toISOString() }));
    ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'after-stale-lock']));
    expect(existsSync(join(dir, '.xm/review/runs/after-stale-lock/run.json'))).toBe(true);
  });

  test('a lock held by a live process still blocks', () => {
    const dir = workspace();
    const lock = join(dir, '.xm/review/lifecycle.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, cwd: dir, started_at: new Date().toISOString() }));
    const result = cli(dir, ['prepare', 'target.patch', '--run-id', 'blocked-by-lock']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('locked');
  });


  test('zero-findings policy persists into a delta without repeating the flag', () => {
    const dir = workspace(); start(dir, 'strict-full', {}, ['--zero-findings']); change(dir, 3);
    const delta = ok(cli(dir, ['run', '--lenses', 'risk', '--run-id', 'strict-delta'], { XM_FAKE_PANEL_SEVERITY: 'low' }));
    expect(delta.zero_findings).toBe(true); expect(delta.verdict).toBe('Request Changes');
  });

  test('fix authorization refuses a tampered receipt and leaves usage untouched', async () => {
    const dir = workspace(); start(dir, 'fix-receipt'); const review = read(runFile(dir, 'fix-receipt', 'result.json'));
    const path = runFile(dir, 'fix-receipt', 'terminal.json'); const receipt = read(path); receipt.result_hash = 'sha256:wrong'; writeFileSync(path, JSON.stringify(receipt));
    await expect(authorizeReviewFix(review, 'scope', { cwd: dir })).rejects.toThrow('receipt');
    expect(Object.values(budget(dir).tasks)[0].used.fix).toBe(0);
  });


  test('a post-delta fix exception records approval even when the original fix was unused', async () => {
    const dir = workspace(); start(dir, 'unused-fix-full'); change(dir, 3); start(dir, 'unused-fix-delta');
    const result = read(runFile(dir, 'unused-fix-delta', 'result.json'));
    await authorizeReviewFix(result, 'explicit-extra-scope', { cwd: dir, exception: 'fix', approvedBy: 'user', reason: 'explicit manual follow-up' });
    const task = Object.values(budget(dir).tasks)[0];
    expect(task.used.fix).toBe(1);
    expect(task.approvals).toContainEqual(expect.objectContaining({ kind: 'fix', approved_by: 'user', reason: 'explicit manual follow-up' }));
  });


  test('delta preserves validated finding resolution evidence and its full coverage', () => {
    const dir = workspace();
    const first = ok(cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'resolved-full'], { XM_FAKE_PANEL_SEVERITY: 'high' }));
    change(dir, 3);
    const path = join(dir, '.xm/review/finding-lifecycle.json'); const lifecycle = read(path);
    const row = lifecycle.findings[0];
    Object.assign(row, { state: 'reverified', outcome: 'resolved', evidence: 'Verified the changed export and its callers.', file_snapshot: { exists: true, sha256: createHash('sha256').update(readFileSync(join(dir, 'src/a.js'))).digest('hex') } });
    writeFileSync(path, JSON.stringify(lifecycle));
    writeFileSync(join(dir, '.xm/review/review-fix-gate.json'), JSON.stringify({ passed: true, reviewed_commit: first.reviewed_commit, lifecycle_digest: `sha256:${createHash('sha256').update(JSON.stringify(lifecycle)).digest('hex')}` }));
    const delta = start(dir, 'resolved-delta');
    expect(delta.verdict).toBe('LGTM'); expect(delta.findings[0].disposition).toBe('resolved');
    expect(delta.findings[0].resolution.evidence).toBe(row.evidence);
    expect(delta.inherited_coverage.run_id).toBe('resolved-full');
    expect(read(path).findings[0].evidence).toBe(row.evidence);
  });

});

test('Review-Fix CLI consumes approval once and a verified delta closes its gate', () => {
  const dir = workspace();
  const build = args => spawnSync('node', [join(import.meta.dirname, '../x-build/lib/x-build-cli.mjs'), 'verify-review-fix', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, X_BUILD_ROOT: undefined, XM_ROOT: join(dir, '.xm'), XM_REVIEW_ROOT: join(dir, '.xm') },
  });
  ok(cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'gate-full'], { XM_FAKE_PANEL_SEVERITY: 'high' }));
  const initialized = build(['--init']); expect(initialized.stdout).toContain('triage'); expect(initialized.status).toBe(0);
  const path = join(dir, '.xm/review/triage.json'); const triage = read(path);
  for (const finding of triage.target_findings) { finding.decision = 'fix_now'; finding.evidence = 'Reproduced the cited export behavior.'; }
  triage.fix_scope.allowed_files = ['src/a.js']; triage.fix_scope.verification = ['Check the corrected export bytes.'];
  writeFileSync(path, JSON.stringify(triage));
  const approved = build([]); expect(approved.stdout).toContain('passed'); expect(approved.status).toBe(0);
  expect(Object.values(budget(dir).tasks)[0].used.fix).toBe(1);
  expect(build([]).status).toBe(0); expect(Object.values(budget(dir).tasks)[0].used.fix).toBe(1);
  change(dir, 3);
  const verified = build(['--reverify', 'F1', '--outcome', 'resolved', '--evidence', 'Checked the corrected export value and all callers.', '--command', 'true']);
  expect(verified.stdout).toContain('passed'); expect(verified.status).toBe(0);
  const delta = start(dir, 'gate-delta'); expect(delta.verdict).toBe('LGTM');
  const closed = build([]); expect(closed.stdout).toContain('passed'); expect(closed.status).toBe(0);
});

test('legacy last-result without a manifest needs explicit association and can be cancelled', () => {
  const dir = workspace(); const source = join(dir, '.xm/review/last-result.json');
  mkdirSync(join(dir, '.xm/review'), { recursive: true }); writeFileSync(source, JSON.stringify({ verdict: 'LGTM', findings: [] }));
  expect(cli(dir, ['prepare', 'target.patch']).stderr).toContain('legacy');
  ok(cli(dir, ['associate', 'old-manual', '--legacy-result', '.xm/review/last-result.json', '--task-id', 'manual', '--reason', 'user identified old task']));
  ok(cli(dir, ['close', 'old-manual', '--reason', 'cannot validate missing frozen bytes']));
  expect(read(runFile(dir, 'old-manual', 'terminal.json')).outcome).toBe('cancelled');
  expect(read(source)).toEqual({ verdict: 'LGTM', findings: [] });
});

test('Review-Fix CLI refuses an unassociated legacy result even before budget state exists', () => {
  const dir = workspace(); mkdirSync(join(dir, '.xm/review'), { recursive: true });
  writeFileSync(join(dir, '.xm/review/last-result.json'), JSON.stringify({ verdict: 'LGTM', findings: [] }));
  const result = spawnSync('node', [join(import.meta.dirname, '../x-build/lib/x-build-cli.mjs'), 'verify-review-fix'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, X_BUILD_ROOT: undefined, XM_ROOT: join(dir, '.xm') },
  });
  expect(result.status).not.toBe(0); expect(result.stdout).toContain('legacy review requires explicit lifecycle association');
});

test('resume completes an interrupted terminal-to-budget transition without another worker', () => {
  const dir = workspace(); start(dir, 'receipt-recovery');
  const path = join(dir, '.xm/review/budget.json'); const state = budget(dir);
  state.active = 'receipt-recovery'; delete Object.values(state.tasks)[0].baseline;
  writeFileSync(path, JSON.stringify(state));
  ok(cli(dir, ['resume', 'receipt-recovery']));
  expect(budget(dir).active).toBeNull(); expect(Object.values(budget(dir).tasks)[0].baseline).toBe('receipt-recovery');
  expect(Object.values(budget(dir).tasks)[0].used.full).toBe(1);
});

test('rejects corrupt counters and terminal target bytes without restoring full budget', () => {
  for (const corruptBudget of [false, true]) {
    const dir = workspace(); start(dir, 'corrupt-state');
    if (corruptBudget) {
      const state = budget(dir); Object.values(state.tasks)[0].used.full = null;
      writeFileSync(join(dir, '.xm/review/budget.json'), JSON.stringify(state));
    } else writeFileSync(runFile(dir, 'corrupt-state', 'target.patch'), 'corrupt target');
    expect(cli(dir, ['prepare', 'target.patch', '--run-id', 'blocked-corrupt']).status).not.toBe(0);
    expect(existsSync(runFile(dir, 'blocked-corrupt', 'run.json'))).toBe(false);
  }
});

test('native context stays hash-bound through retry and finalization', () => {
  const dir = workspace(); const context = {
    schema_version: 1, goal: 'Keep export behavior correct.', invariants: [{ id: 'EXPORT', text: 'Export both values.' }],
    constraints: [], non_goals: [], acceptance_checks: [{ id: 'CHECK', description: 'Inspect every changed export.' }],
  };
  const contextFile = join(dir, 'context-input.json'); writeFileSync(contextFile, JSON.stringify(context));
  const prepared = ok(cli(dir, ['prepare', 'target.patch', '--lenses', 'correctness', '--run-id', 'context-native', '--context-file', contextFile]));
  const manifest = read(runFile(dir, 'context-native', 'run.json')); let worker = prepared.workers[0];
  const report = { schema_version: 1, task_id: manifest.task_id, report_id: worker.report_id, lens: worker.lens,
    target_hash: worker.target_hash, status: 'complete', checked: ['Checked the export invariant.'], checked_files: ['src/a.js'],
    findings: [], no_findings_reason: 'Both changed exports satisfy the supplied invariant.' };
  const file = join(dir, 'response.json'); writeFileSync(file, JSON.stringify(report));
  const rejected = ok(cli(dir, ['submit', manifest.id, '--report-id', worker.report_id, '--attempt-id', worker.attempt_id, '--report', file]));
  expect(rejected.retry).toBe(true); worker = rejected.worker;
  report.context_hash = manifest.context_hash; writeFileSync(file, JSON.stringify(report));
  expect(ok(cli(dir, ['submit', manifest.id, '--report-id', worker.report_id, '--attempt-id', worker.attempt_id, '--report', file])).retry).toBe(false);
  const result = ok(cli(dir, ['finalize', manifest.id]));
  expect(result.context_status).toBe('bound'); expect(result.context_hash).toBe(manifest.context_hash); expect(result.context_contract).toEqual(context);
});

test('default Low findings pass the merge gate while zero-findings and stale bytes do not', () => {
  for (const strict of [false, true]) {
    const dir = workspace();
    ok(cli(dir, ['run', 'target.patch', '--lenses', 'risk', '--run-id', 'low-merge', ...(strict ? ['--zero-findings'] : [])], { XM_FAKE_PANEL_SEVERITY: 'low' }));
    const gate = () => spawnSync('node', [join(import.meta.dirname, '../x-build/lib/x-build-cli.mjs'), 'verify-review-fix'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, X_BUILD_ROOT: undefined, XM_ROOT: join(dir, '.xm') },
    });
    expect(gate().status).toBe(strict ? 1 : 0);
    if (!strict) { change(dir, 3); expect(gate().status).not.toBe(0); }
  }
});

test('a second budget exception is refused instead of reopening the loop', () => {
  const dir = workspace(); ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'active']));
  ok(cli(dir, ['close', 'active', '--reason', 'user cancellation']));
  ok(cli(dir, ['prepare', 'target.patch', '--run-id', 'first-exception', '--exception', 'full', '--approved-by', 'user', '--reason', 'one approved retry']));
  ok(cli(dir, ['close', 'first-exception', '--reason', 'user cancellation']));
  const second = cli(dir, ['prepare', 'target.patch', '--run-id', 'second-exception', '--exception', 'full', '--approved-by', 'user', '--reason', 'another retry']);
  expect(second.status).not.toBe(0);
  expect(second.stderr).toContain('already spent its 1 budget exception');
  const task = Object.values(budget(dir).tasks)[0];
  expect(task.used.full).toBe(2); expect(task.approvals).toHaveLength(1);
});

test('a deleted budget file is a loss to repair, not a fresh worktree', () => {
  const dir = workspace(); start(dir, 'first-run'); change(dir);
  rmSync(join(dir, '.xm/review/budget.json'));
  const reset = cli(dir, ['prepare', 'target.patch', '--run-id', 'after-delete']);
  expect(reset.status).not.toBe(0);
  expect(reset.stderr).toContain('review budget state is missing');
  // No lifecycle command recovers this state; close loads the budget too.
  expect(cli(dir, ['close', 'first-run', '--reason', 'give up']).status).not.toBe(0);
  expect(existsSync(join(dir, '.xm/review/runs/after-delete'))).toBe(false);
});
