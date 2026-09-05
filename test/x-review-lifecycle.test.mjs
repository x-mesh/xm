import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-review', 'lib', 'x-review-cli.mjs');
const PANEL = join(ROOT, 'x-panel', 'lib', 'x-panel-cli.mjs');
const FAKE_PANEL = join(import.meta.dirname, 'fixtures', 'fake-review-panel.mjs');
const FAKE_ROUTE = join(import.meta.dirname, 'fixtures', 'fake-review-route.mjs');
const PANEL_STUB = join(import.meta.dirname, 'fixtures', 'panel-stub-model.mjs');
const TRACE = join(import.meta.dirname, 'fixtures', 'fake-review-trace.mjs');
const dirs = [];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'x-review-lifecycle-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(dir, 'target.patch'), [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1,2 @@',
    ' export const a = 1;',
    '+export const b = 2;',
  ].join('\n'));
  for (const args of [['init'], ['config', 'user.email', 'review@example.test'], ['config', 'user.name', 'Review Fixture'], ['add', 'src/a.js'], ['commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return dir;
}

function env(dir, extra = {}) {
  return {
    ...process.env,
    XM_REVIEW_ROOT: join(dir, '.xm'),
    XM_REVIEW_PANEL_COMMAND: JSON.stringify(['node', FAKE_PANEL]),
    XM_REVIEW_TRACE_COMMAND: JSON.stringify(['node', TRACE]),
    ...extra,
  };
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('xm review executable lifecycle', () => {
  test('owns freeze, plan, chunk×lens dispatch, synthesis, trace, and success cleanup', () => {
    const dir = workspace();
    const log = join(dir, 'panel.jsonl');
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness,risk', '--run-id', 'run-ok', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    const runDir = join(dir, '.xm', 'review', 'runs', 'run-ok');
    expect(output.coverage).toEqual({ expected: 2, completed: 2, valid: 2, ok: true, complete: true });
    expect(output.verdict).toBe('LGTM');
    expect(output.findings).toHaveLength(1);
    for (const file of ['target.patch', 'plan.json', 'run.json', 'status.json', 'result.json', 'events.jsonl', 'trace.jsonl']) expect(existsSync(join(runDir, file))).toBe(true);
    expect(readdirSync(join(runDir, 'children')).sort()).toEqual(['correctness-chunk-001.json', 'risk-chunk-001.json']);
    expect(existsSync(join(runDir, 'work'))).toBe(false);
    expect(JSON.parse(readFileSync(join(runDir, 'trace-receipt.json'), 'utf8')).state).toBe('recorded');
    const invocations = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(invocations).toHaveLength(2);
    expect(invocations.every((entry) => entry.args.includes('--engine') && entry.args.includes('native'))).toBe(true);
  });

  test('preserves failed artifacts and resume skips completed children', () => {
    const dir = workspace();
    const log = join(dir, 'panel.jsonl');
    const marker = join(dir, 'failed.marker');
    const runArgs = ['run', 'target.patch', '--lenses', 'correctness,risk', '--run-id', 'run-resume', '--json'];
    const first = spawnSync('node', [CLI, ...runArgs], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log, XM_FAKE_PANEL_FAIL_LENS: 'risk', XM_FAKE_PANEL_FAIL_MARKER: marker }), encoding: 'utf8' });
    expect(first.status).toBe(1);
    expect(first.stderr).toContain('resume with: xm review resume run-resume');
    const runDir = join(dir, '.xm', 'review', 'runs', 'run-resume');
    expect(JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')).state).toBe('failed');
    expect(existsSync(join(runDir, 'work'))).toBe(true);

    const resumed = spawnSync('node', [CLI, 'resume', 'run-resume', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log, XM_FAKE_PANEL_FAIL_LENS: 'risk', XM_FAKE_PANEL_FAIL_MARKER: marker }), encoding: 'utf8' });
    expect(resumed.status).toBe(0);
    const invocations = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(invocations.slice(0, 2).map((entry) => entry.lens).sort()).toEqual(['correctness', 'risk']);
    expect(invocations[2].lens).toBe('risk');
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('child_skipped');
    expect(existsSync(join(runDir, 'work'))).toBe(false);
  });

  test('resume re-dispatches a child that completed but failed validation', () => {
    const dir = workspace();
    const log = join(dir, 'panel.jsonl');
    const first = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'risk', '--run-id', 'invalid-child', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log, XM_FAKE_PANEL_MODE: 'foreign-target' }), encoding: 'utf8' });
    expect(first.status).toBe(1);
    const runDir = join(dir, '.xm', 'review', 'runs', 'invalid-child');
    const childPath = join(runDir, 'children', 'risk-chunk-001.json');
    const rejected = JSON.parse(readFileSync(childPath, 'utf8'));
    expect(rejected.status).toBe('completed');
    expect(rejected.valid).toBe(false);
    expect(rejected.invalid_codes).toContain('finding_outside_target');
    expect(JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')).invalid).toEqual(['risk-chunk-001']);

    const resumed = spawnSync('node', [CLI, 'resume', 'invalid-child', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log }), encoding: 'utf8' });
    expect(resumed.status).toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('child_redispatched');
    const repaired = JSON.parse(readFileSync(childPath, 'utf8'));
    expect(repaired.valid).toBe(true);
    expect(repaired.attempt).toBe(2);
    expect(repaired.invalid_codes).toBeUndefined();
  });

  test('salvages validated reports when one child fails report-scoped validation', () => {
    const dir = workspace();
    const log = join(dir, 'panel.jsonl');
    const first = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness,risk', '--run-id', 'partial-salvage', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log, XM_FAKE_PANEL_MODE: 'foreign-target' }), encoding: 'utf8' });
    expect(first.status).toBe(1);
    const runDir = join(dir, '.xm', 'review', 'runs', 'partial-salvage');
    const status = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8'));
    expect(status.state).toBe('partial');
    expect(status.invalid).toEqual(['risk-chunk-001']);
    expect(status.valid_reports).toEqual(['correctness-chunk-001']);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toContain('run_partial');
    // The salvage stays inside the run: an incomplete review must not become the project's
    // last result, which is what the review-fix gate reads as truth.
    expect(existsSync(join(runDir, 'partial-result.json'))).toBe(true);
    expect(existsSync(join(dir, '.xm', 'review', 'last-result.json'))).toBe(false);
    expect(existsSync(join(runDir, 'result.json'))).toBe(false);
    // The salvage carries the reports that validated, never the rejected one. risk-chunk-001
    // was refused for finding_outside_target; its src/foreign.js finding must not survive.
    const salvaged = JSON.parse(readFileSync(join(runDir, 'partial-result.json'), 'utf8'));
    expect(salvaged.findings.map((finding) => finding.file)).not.toContain('src/foreign.js');
    expect(salvaged.findings).toEqual([]);

    const resumed = spawnSync('node', [CLI, 'resume', 'partial-salvage', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log }), encoding: 'utf8' });
    expect(resumed.status).toBe(0);
    // Only the invalid child was re-dispatched: 2 initial + 1 repair.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')).state).toBe('completed');
    expect(existsSync(join(dir, '.xm', 'review', 'last-result.json'))).toBe(true);
  });

  test('drops only the finding whose line is unusable and keeps its well-formed sibling', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'risk', '--run-id', 'malformed-line', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'malformed-line' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    // Two findings went in; the one without a line must be the only casualty. Invalidating the
    // whole report for it discarded 13 well-formed findings across 7 real reports.
    const output = JSON.parse(result.stdout);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0].line).toBe(2);
    const validation = JSON.parse(readFileSync(join(dir, '.xm', 'review', 'runs', 'malformed-line', 'validation.json'), 'utf8'));
    expect(validation.ok).toBe(true);
    expect(validation.valid_reports).toContain('risk-chunk-001');
    expect(validation.issues.map((entry) => entry.code)).toEqual(['finding_line']);
    expect(validation.finding_grounding).toMatchObject({ findings: 2, grounded: 1 });
    expect(validation.finding_grounding.reports).toContainEqual(
      expect.objectContaining({ report_id: 'risk-chunk-001', malformed_findings: [1] }),
    );
  });

  test('drops a finding whose citation belongs to a file other than the one it names', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'src', 'b.js'), 'export const b = 1;\n');
    writeFileSync(join(dir, 'two.patch'), ['a', 'b'].flatMap((name) => [
      `diff --git a/src/${name}.js b/src/${name}.js`, `--- a/src/${name}.js`, `+++ b/src/${name}.js`, '@@ -1 +1 @@', `-export const ${name} = 0;`, `+export const ${name} = 1;`,
    ]).join('\n'));
    const result = spawnSync('node', [CLI, 'run', 'two.patch', '--lenses', 'risk', '--run-id', 'wrong-file', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'wrong-file' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    // The citation is real, so the report stays valid — but it names src/a.js while quoting
    // src/b.js, so the finding must not reach synthesis and steer the review-fix scope.
    const output = JSON.parse(result.stdout);
    expect(output.findings).toHaveLength(0);
    const validation = JSON.parse(readFileSync(join(dir, '.xm', 'review', 'runs', 'wrong-file', 'validation.json'), 'utf8'));
    expect(validation.ok).toBe(true);
    expect(validation.issues.map((entry) => entry.code)).toEqual(['finding_code_wrong_file']);
    expect(validation.finding_grounding).toMatchObject({ findings: 1, grounded: 0, wrong_file: 1 });
  });

  test('drops an ungrounded finding from synthesis instead of failing the run', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'risk', '--run-id', 'ungrounded', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'ungrounded-finding' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.findings).toHaveLength(0);
    const validation = JSON.parse(readFileSync(join(dir, '.xm', 'review', 'runs', 'ungrounded', 'validation.json'), 'utf8'));
    expect(validation.ok).toBe(true);
    expect(validation.finding_grounding).toMatchObject({ findings: 1, grounded: 0, ungrounded: 1 });
    expect(validation.issues.map((entry) => entry.code)).toEqual(['finding_code_mismatch']);
  });

  test('fails closed on unknown flags and invalid targets', () => {
    const dir = workspace();
    const unknown = spawnSync('node', [CLI, 'run', 'target.patch', '--typo'], { cwd: dir, env: env(dir), encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown flag: --typo');
    const missing = spawnSync('node', [CLI, 'run', 'missing.patch'], { cwd: dir, env: env(dir), encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('review target does not exist');
    expect(existsSync(join(dir, '.xm', 'review', 'runs'))).toBe(false);
    const escaped = spawnSync('node', [CLI, 'run', 'target.patch', '--run-id', '../escape'], { cwd: dir, env: env(dir), encoding: 'utf8' });
    expect(escaped.status).toBe(1);
    expect(escaped.stderr).toContain('invalid review run id');
    expect(existsSync(join(dir, '.xm', 'review', 'escape'))).toBe(false);
  });

  test('accepts the canonical x-panel verdict shape through the report validator', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--models', 'claude,codex', '--lenses', 'risk', '--rounds', '1', '--run-id', 'canonical-panel', '--json'], { cwd: dir, env: env(dir), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.coverage).toEqual({ expected: 1, completed: 1, valid: 1, ok: true, complete: true });
    expect(output.verdict).toBe('LGTM');
    expect(output.findings).toHaveLength(1);
    const runDir = join(dir, '.xm', 'review', 'runs', 'canonical-panel');
    expect(JSON.parse(readFileSync(join(runDir, 'validation.json'), 'utf8')).ok).toBe(true);
    expect(readdirSync(join(runDir, 'reports'))).toEqual(['risk-chunk-001.json']);
    const manifest = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(manifest.plan.chunks[0].files).toEqual(['src/a.js']);
  });

  test('fails closed on foreign-target findings and evidence-free zero reports', () => {
    for (const [mode, code] of [['foreign-target', 'finding_outside_target']]) {
      const dir = workspace();
      const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', mode === 'foreign-target' ? 'risk' : 'correctness', '--run-id', mode, '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: mode }), encoding: 'utf8' });
      expect(result.status).toBe(1);
      const validation = JSON.parse(readFileSync(join(dir, '.xm', 'review', 'runs', mode, 'validation.json'), 'utf8'));
      expect(validation.ok).toBe(false);
      expect(validation.issues.map((entry) => entry.code)).toContain(code);
      expect(existsSync(join(dir, '.xm', 'review', 'last-result.json'))).toBe(false);
    }
    const dir = workspace();
    const evidenceFree = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness', '--run-id', 'evidence-free-zero', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'evidence-free-zero' }), encoding: 'utf8' });
    expect(evidenceFree.status).toBe(1);
    expect(evidenceFree.stderr).toContain('supplied no clean-review reason');
    expect(existsSync(join(dir, '.xm', 'review', 'last-result.json'))).toBe(false);
  });

  test('default target freezes untracked files before creating review artifacts', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', '--lenses', 'correctness', '--run-id', 'untracked', '--json'], { cwd: dir, env: env(dir), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const runDir = join(dir, '.xm', 'review', 'runs', 'untracked');
    const manifest = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    expect(manifest.reviewed_files_all).toContain('target.patch');
    expect(readFileSync(join(runDir, 'target.patch'), 'utf8')).toContain('diff --git a/target.patch b/target.patch');
  });

  test('rejects panel coverage claims that omit a frozen target file', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'risk', '--run-id', 'missing-coverage', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'missing-coverage' }), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('omitted checked files: src/a.js');
  });

  test('deduplicates equivalent findings across lenses before verdict counts', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness,risk', '--run-id', 'dedupe', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'duplicate' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0].lenses).toEqual(['correctness', 'risk']);
    expect(output.counts.medium).toBe(1);
  });

  test('deduplicates equivalent findings with mixed dispositions conservatively', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness,risk', '--run-id', 'mixed-dedupe', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'mixed-disposition' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]).toMatchObject({ disposition: 'unreviewed', confidence: 'unresolved', source_dispositions: ['confirmed', 'unreviewed'] });
    expect(output.counts.medium).toBe(1);
  });

  test('dedupe preserves the highest severity and cited code/fix evidence', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness,risk', '--rounds', '1', '--run-id', 'evidence-dedupe', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'mixed-severity' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const shared = JSON.parse(result.stdout).findings.find((finding) => finding.file === 'src/a.js');
    expect(shared).toMatchObject({ severity: 'High', code: 'export const b = 2;', fix: 'Guard the exported value.', lenses: ['correctness', 'risk'] });
    expect(JSON.parse(result.stdout).counts.high).toBe(1);
  });

  test('executes one planner wave concurrently and records the measured wave count', () => {
    const dir = workspace();
    const started = Date.now();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness,risk', '--run-id', 'parallel-wave', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_DELAY_MS: '250' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(550);
    expect(JSON.parse(result.stdout).execution.waves).toBe(1);
  });

  test('runs bounded waves sequentially while keeping each wave parallel', () => {
    const dir = workspace();
    for (const name of ['b', 'c']) writeFileSync(join(dir, 'src', `${name}.js`), `export const ${name} = 1;\n`);
    writeFileSync(join(dir, 'multi.patch'), ['a', 'b', 'c'].flatMap((name) => [
      `diff --git a/src/${name}.js b/src/${name}.js`, `--- a/src/${name}.js`, `+++ b/src/${name}.js`, '@@ -1 +1 @@', `-export const ${name} = 0;`, `+export const ${name} = 1;`,
    ]).join('\n'));
    const started = Date.now();
    const result = spawnSync('node', [CLI, 'run', 'multi.patch', '--lenses', 'correctness,risk', '--chunk-file-budget', '1', '--max-concurrent-reports', '4', '--run-id', 'two-waves', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_DELAY_MS: '150', XM_FAKE_PANEL_MODE: 'clean' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(850);
    const output = JSON.parse(result.stdout);
    expect(output.execution.waves).toBe(2);
    const manifest = JSON.parse(readFileSync(join(dir, '.xm', 'review', 'runs', 'two-waves', 'run.json'), 'utf8'));
    expect(manifest.expected_reports.map((report) => report.wave).sort()).toEqual([1, 1, 1, 1, 2, 2]);
  });

  test('default concurrency is independent of lens count and collapses the same target into one wave', () => {
    const dir = workspace();
    for (const name of ['b', 'c']) writeFileSync(join(dir, 'src', `${name}.js`), `export const ${name} = 1;\n`);
    writeFileSync(join(dir, 'multi.patch'), ['a', 'b', 'c'].flatMap((name) => [
      `diff --git a/src/${name}.js b/src/${name}.js`, `--- a/src/${name}.js`, `+++ b/src/${name}.js`, '@@ -1 +1 @@', `-export const ${name} = 0;`, `+export const ${name} = 1;`,
    ]).join('\n'));
    const result = spawnSync('node', [CLI, 'run', 'multi.patch', '--lenses', 'correctness,risk', '--chunk-file-budget', '1', '--run-id', 'default-wave', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_DELAY_MS: '150', XM_FAKE_PANEL_MODE: 'clean' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.execution.waves).toBe(1);
    const manifest = JSON.parse(readFileSync(join(dir, '.xm', 'review', 'runs', 'default-wave', 'run.json'), 'utf8'));
    expect(manifest.expected_reports.every((report) => report.wave === 1)).toBe(true);
    expect(manifest.options.max_concurrent_reports).toBe(8);
  });

  test('a partly failed wave still dispatches the waves behind it', () => {
    const dir = workspace();
    for (const name of ['b', 'c']) writeFileSync(join(dir, 'src', `${name}.js`), `export const ${name} = 1;\n`);
    writeFileSync(join(dir, 'multi.patch'), ['a', 'b', 'c'].flatMap((name) => [
      `diff --git a/src/${name}.js b/src/${name}.js`, `--- a/src/${name}.js`, `+++ b/src/${name}.js`, '@@ -1 +1 @@', `-export const ${name} = 0;`, `+export const ${name} = 1;`,
    ]).join('\n'));
    const result = spawnSync('node', [CLI, 'run', 'multi.patch', '--lenses', 'correctness,risk', '--chunk-file-budget', '1', '--max-concurrent-reports', '4', '--run-id', 'partial-wave', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_FAIL_LENS: 'correctness', XM_FAKE_PANEL_MODE: 'clean' }), encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    const children = join(dir, '.xm', 'review', 'runs', 'partial-wave', 'children');
    // chunk-003 sits in wave 2, behind the wave that failed; it used to never be dispatched.
    const wave2 = JSON.parse(readFileSync(join(children, 'risk-chunk-003.json'), 'utf8'));
    expect(wave2.status).toBe('completed');
    const risks = ['risk-chunk-001', 'risk-chunk-002', 'risk-chunk-003']
      .map((id) => JSON.parse(readFileSync(join(children, `${id}.json`), 'utf8')).status);
    expect(risks).toEqual(['completed', 'completed', 'completed']);
  });

  test('stops when a whole wave fails instead of burning the remaining waves', () => {
    const dir = workspace();
    for (const name of ['b', 'c']) writeFileSync(join(dir, 'src', `${name}.js`), `export const ${name} = 1;\n`);
    writeFileSync(join(dir, 'multi.patch'), ['a', 'b', 'c'].flatMap((name) => [
      `diff --git a/src/${name}.js b/src/${name}.js`, `--- a/src/${name}.js`, `+++ b/src/${name}.js`, '@@ -1 +1 @@', `-export const ${name} = 0;`, `+export const ${name} = 1;`,
    ]).join('\n'));
    const result = spawnSync('node', [CLI, 'run', 'multi.patch', '--lenses', 'correctness', '--chunk-file-budget', '1', '--max-concurrent-reports', '2', '--run-id', 'dead-wave', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_FAIL_LENS: 'correctness' }), encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    const children = join(dir, '.xm', 'review', 'runs', 'dead-wave', 'children');
    expect(existsSync(join(children, 'correctness-chunk-001.json'))).toBe(true);
    expect(existsSync(join(children, 'correctness-chunk-002.json'))).toBe(true);
    // wave 2 is never reached once wave 1 loses every child.
    expect(existsSync(join(children, 'correctness-chunk-003.json'))).toBe(false);
  });

  test('keeps a target inside the token budget in one chunk up to the default file budget', () => {
    const dir = workspace();
    const names = ['b', 'c', 'd', 'e', 'f', 'g'];
    for (const name of names) writeFileSync(join(dir, 'src', `${name}.js`), `export const ${name} = 1;\n`);
    writeFileSync(join(dir, 'wide.patch'), ['a', ...names].flatMap((name) => [
      `diff --git a/src/${name}.js b/src/${name}.js`, `--- a/src/${name}.js`, `+++ b/src/${name}.js`, '@@ -1 +1 @@', `-export const ${name} = 0;`, `+export const ${name} = 1;`,
    ]).join('\n'));
    const result = spawnSync('node', [CLI, 'run', 'wide.patch', '--lenses', 'correctness', '--run-id', 'one-chunk', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: 'clean' }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, '.xm', 'review', 'runs', 'one-chunk', 'run.json'), 'utf8'));
    // 7 files, far inside the 24k token budget: the file budget must not force a split.
    expect(manifest.chunks.length).toBe(1);
    expect(manifest.expected_reports.length).toBe(1);
  });

  test('rejects a non-positive --max-concurrent-reports', () => {
    const dir = workspace();
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--max-concurrent-reports', '0', '--json'], { cwd: dir, env: env(dir), encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--max-concurrent-reports');
  });

  test('persists compatible result metadata from Phase 1 snapshots', () => {
    const dir = workspace();
    const traceLog = join(dir, 'trace.jsonl');
    const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'risk', '--run-id', 'artifacts', '--json'], { cwd: dir, env: env(dir, { XM_FAKE_TRACE_LOG: traceLog }), encoding: 'utf8' });
    expect(result.status).toBe(0);
    const reviewDir = join(dir, '.xm', 'review');
    const saved = JSON.parse(readFileSync(join(reviewDir, 'last-result.json'), 'utf8'));
    expect(saved.reviewed_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(saved.reviewed_files_all).toEqual(['src/a.js']);
    expect(saved.reviewed_file_snapshots).toEqual([{ file: 'src/a.js', exists: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(saved.target_coverage).toEqual({ expected: 1, checked: 1, complete: true, missing_files: [] });
    expect(saved.findings[0]).toMatchObject({ id: 'F1', finding_id: expect.stringMatching(/^rf_[0-9a-f]{16}$/), sources: ['fixture-risk'], confidence: 'challenged' });
    expect(existsSync(join(reviewDir, 'last-result.md'))).toBe(true);
    expect(readdirSync(join(reviewDir, 'history'))).toHaveLength(1);
    expect(existsSync(join(reviewDir, 'finding-lifecycle.json'))).toBe(true);
    expect(JSON.parse(readFileSync(traceLog, 'utf8'))).toEqual(['record', 'review', '--ref', saved.reviewed_commit, '--status', 'lgtm', '--artifact', join(reviewDir, 'runs', 'artifacts', 'result.json')]);
  });

  test('preserves unresolved and contested semantics in verdict thresholds', () => {
    for (const [name, mode, severity, verdict, disposition, count] of [
      ['unresolved-high', 'unchallenged', 'high', 'Request Changes', 'unreviewed', 1],
      ['unresolved-critical', 'unchallenged', 'critical', 'Block', 'unreviewed', 1],
      ['contested-critical', 'contested', 'critical', 'LGTM', 'contested', 0],
    ]) {
      const dir = workspace();
      const traceLog = join(dir, 'trace.jsonl');
      const result = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'risk', '--run-id', name, '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_MODE: mode, XM_FAKE_PANEL_SEVERITY: severity, XM_FAKE_TRACE_LOG: traceLog }), encoding: 'utf8' });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.verdict).toBe(verdict);
      expect(output.findings[0].disposition).toBe(disposition);
      expect(output.counts[severity]).toBe(count);
      expect(output.findings[0].sources).toEqual(['fixture-risk']);
      expect(JSON.parse(readFileSync(traceLog, 'utf8'))[5]).toBe(verdict.toLowerCase().replace(/\s+/g, '-'));
    }
  });

  test('fails closed when frozen target, chunk, prompt, or completed child report is tampered', () => {
    const cases = [
      ['target', (runDir) => writeFileSync(join(runDir, 'target.patch'), 'tampered\n'), 'frozen target bytes'],
      ['chunk', (runDir) => writeFileSync(join(runDir, 'chunks', 'chunk-001.patch'), 'tampered\n'), 'frozen chunk bytes'],
      ['prompt', (runDir) => writeFileSync(join(runDir, 'prompts', 'correctness.md'), 'tampered\n'), 'prompt bytes'],
      ['report', (runDir) => writeFileSync(join(runDir, 'reports', 'correctness-chunk-001.json'), '{}\n'), 'completed child binding mismatch'],
    ];
    for (const [name, tamper, message] of cases) {
      const dir = workspace();
      const log = join(dir, 'panel.jsonl');
      const marker = join(dir, 'failure.marker');
      const first = spawnSync('node', [CLI, 'run', 'target.patch', '--lenses', 'correctness,risk', '--run-id', name, '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log, XM_FAKE_PANEL_FAIL_LENS: 'risk', XM_FAKE_PANEL_FAIL_MARKER: marker }), encoding: 'utf8' });
      expect(first.status).toBe(1);
      const runDir = join(dir, '.xm', 'review', 'runs', name);
      tamper(runDir);
      const before = readFileSync(log, 'utf8').trim().split('\n').length;
      const resumed = spawnSync('node', [CLI, 'resume', name, '--json'], { cwd: dir, env: env(dir, { XM_FAKE_PANEL_LOG: log }), encoding: 'utf8' });
      expect(resumed.status).toBe(1);
      expect(resumed.stderr).toContain(message);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(before);
      // Tampering is run-scoped: no salvaged synthesis, and no last result either.
      expect(existsSync(join(runDir, 'partial-result.json'))).toBe(false);
      expect(existsSync(join(dir, '.xm', 'review', 'last-result.json'))).toBe(false);
    }
  });
});

describe('xm panel review routing', () => {
  test('explicit review delegates with cross-vendor while shorthand remains native', () => {
    const dir = workspace();
    const log = join(dir, 'route.jsonl');
    const delegated = spawnSync('node', [PANEL, 'review', 'target.patch', '--models', 'claude,codex'], { cwd: dir, env: { ...process.env, XM_PANEL_REVIEW_COMMAND: JSON.stringify(['node', FAKE_ROUTE]), XM_FAKE_ROUTE_LOG: log, NO_COLOR: '1' }, encoding: 'utf8' });
    expect(delegated.status).toBe(0);
    expect(JSON.parse(delegated.stdout)).toEqual({ delegated: true });
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['run', 'target.patch', '--models', 'claude,codex', '--cross-vendor']);

    const delegatedEquals = spawnSync('node', [PANEL, 'review', 'target.patch', '--engine=lifecycle'], { cwd: dir, env: { ...process.env, XM_PANEL_REVIEW_COMMAND: JSON.stringify(['node', FAKE_ROUTE]), XM_FAKE_ROUTE_LOG: log, NO_COLOR: '1' }, encoding: 'utf8' });
    expect(delegatedEquals.status).toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).at(-1)).toEqual(['run', 'target.patch', '--cross-vendor']);

    const shorthand = spawnSync('node', [PANEL, 'target.patch', '--models', 'claude,codex', '--rounds', '1', '--json'], {
      cwd: dir,
      env: { ...process.env, XM_PANEL_REVIEW_COMMAND: JSON.stringify(['node', FAKE_ROUTE]), XM_FAKE_ROUTE_LOG: log, X_PANEL_ROOT: join(dir, '.panel'), X_PANEL_GLOBAL_ROOT: join(dir, '.global'), X_PANEL_CMD_CLAUDE: PANEL_STUB, X_PANEL_CMD_CODEX: PANEL_STUB, NO_COLOR: '1' },
      encoding: 'utf8',
    });
    expect(shorthand.status).toBe(0);
    expect(JSON.parse(shorthand.stdout).run).toMatch(/^panel-/);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);

    const invalidEngine = spawnSync('node', [PANEL, 'review', '--engine', 'other', 'target.patch'], { cwd: dir, env: process.env, encoding: 'utf8' });
    expect(invalidEngine.status).toBe(2);
    expect(invalidEngine.stderr).toContain('--engine must be native or lifecycle');
  });
});
