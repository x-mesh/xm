import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGitLog, summarizeGitHistory, DEFAULT_GIT_ESCAPE_CONFIG } from '../x-build/lib/x-build/escape-git.mjs';
import {
  classifyReplay, selectPairedCommits, detectSubsetTestRunner, verifyTestPairing, parseRunnerCounts,
  writeReport, escapeVerifyPath,
} from '../x-build/lib/x-build/escape-verify.mjs';

const RS = '\u0000';
const FS_ = '\u001f';
const record = (sha, ts, subject, files) => RS + [sha, ts, subject].join(FS_) + '\n' + files.join('\n') + '\n';

test('a control run that did not pass never becomes a verdict about the test', () => {
  // The whole point: a flaky or un-buildable sample must not be scored as either
  // outcome, or the corrected rate inherits the environment's noise.
  for (const control of [null, { outcome: 'fail' }, { outcome: 'timeout' }, { outcome: 'error' }]) {
    expect(classifyReplay({ control, treatment: { outcome: 'fail' } })).toBe('inconclusive');
  }
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: null })).toBe('inconclusive');
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: { outcome: 'timeout' } })).toBe('inconclusive');
});

test('failing on the parent is what proves the test detects its own bug', () => {
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: { outcome: 'fail' } })).toBe('catches');
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: { outcome: 'pass' } })).toBe('decorative');
});

test('a test that only fails to load on the parent is not counted as detection', () => {
  // A replayed test that imports a symbol the fix introduced dies with a load
  // error on the parent before any assertion runs. bun reports that file as both
  // a fail and an error, so this is the shape real output takes.
  const bindingOnly = { outcome: 'fail', counts: { pass: 0, fail: 1, error: 1 } };
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: bindingOnly })).toBe('catches_by_binding');

  // One real assertion failure outweighs a co-occurring load error.
  const mixed = { outcome: 'fail', counts: { pass: 118, fail: 5, error: 1 } };
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: mixed })).toBe('catches');

  // No counts parsed: stay with the coarse verdict rather than inventing one.
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: { outcome: 'fail', counts: null } })).toBe('catches');
});

test('runner counts are read from the summary, or reported as unknown', () => {
  const summary = '\n 118 pass\n 5 fail\n 1 error\n 522 expect() calls\n';
  expect(parseRunnerCounts(summary)).toEqual({ pass: 118, fail: 5, error: 1 });
  expect(parseRunnerCounts('\n 12 pass\n 31 expect() calls\n')).toEqual({ pass: 12, fail: 0, error: 0 });
  for (const unknown of ['', null, 'no summary here', 'Ran 13 tests across 1 file.']) {
    expect(parseRunnerCounts(unknown)).toBeNull();
  }
});

test('the pluralised error line is counted', () => {
  // Observed on 86a9dcc8: bun prints "1 error" but "2 errors". Reading only the
  // singular reports error:0, which silently promotes a binding-only replay to
  // `catches` and overstates detection.
  expect(parseRunnerCounts('\n 0 pass\n 16 fail\n 2 errors\n')).toEqual({ pass: 0, fail: 16, error: 2 });
  expect(parseRunnerCounts('\n 5 pass\n 0 fail\n 3 errors\n')).toEqual({ pass: 5, fail: 0, error: 3 });
  expect(classifyReplay({
    control: { outcome: 'pass' },
    treatment: { outcome: 'fail', counts: parseRunnerCounts('\n 5 pass\n 0 fail\n 3 errors\n') },
  })).toBe('catches_by_binding');
});

test('the verified population is exactly the commits that claimed a paired test', () => {
  const text = [
    record('a'.repeat(40), '2026-09-01T00:00:00Z', 'fix: paired', ['src/a.mjs', 'test/a.test.mjs']),
    record('b'.repeat(40), '2026-09-02T00:00:00Z', 'fix: unpaired', ['src/b.mjs']),
    record('c'.repeat(40), '2026-09-03T00:00:00Z', 'perf: faster', ['src/c.mjs', 'test/c.test.mjs']),
  ].join('');
  const parsed = parseGitLog(text);
  const summary = summarizeGitHistory(parsed.commits, DEFAULT_GIT_ESCAPE_CONFIG);
  const bySha = new Map(parsed.commits.map(commit => [commit.sha, commit]));
  const paired = selectPairedCommits(summary, bySha, DEFAULT_GIT_ESCAPE_CONFIG);

  // perf commits are not defects, and the unpaired fix never claimed a test —
  // including either would make the corrected rate incomparable to the claim.
  expect(paired.map(entry => entry.sha)).toEqual(['a'.repeat(40)]);
  expect(paired[0].test_files).toEqual(['test/a.test.mjs']);
  expect(summary.test_pairing_rate).toBe(0.5);
});

test('one commit yields one row even when it touched many source files', () => {
  const text = record('d'.repeat(40), '2026-09-04T00:00:00Z', 'fix: wide', ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'test/w.test.mjs']);
  const parsed = parseGitLog(text);
  const summary = summarizeGitHistory(parsed.commits, DEFAULT_GIT_ESCAPE_CONFIG);
  const bySha = new Map(parsed.commits.map(commit => [commit.sha, commit]));
  expect(summary.defects.length).toBe(3);
  expect(selectPairedCommits(summary, bySha, DEFAULT_GIT_ESCAPE_CONFIG).length).toBe(1);
});

test('a runner is only claimed when it can run a named subset', () => {
  const root = mkdtempSync(join(tmpdir(), 'escape-verify-runner-'));
  expect(detectSubsetTestRunner(root)).toBeNull();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  // package.json alone is not enough: `npm test` cannot be pointed at a subset,
  // so the whole suite's pre-existing failures would drown the signal.
  expect(detectSubsetTestRunner(root)).toBeNull();
  writeFileSync(join(root, 'bun.lock'), '');
  const runner = detectSubsetTestRunner(root);
  expect(runner?.kind).toBe('bun');
  expect(runner.run(['a.test.mjs'])).toEqual(['bun', ['test', 'a.test.mjs']]);
});

test('an unusable repository reports a reason instead of a reassuring zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'escape-verify-norepo-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  const report = verifyTestPairing(root, { since: '90d', limit: 5 });
  expect(report.available).toBe(false);
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.sampled).toBe(0);
});

test('invalid windows and limits are refused before any git work', () => {
  const root = mkdtempSync(join(tmpdir(), 'escape-verify-args-'));
  expect(verifyTestPairing(root, { since: '30' }).errors[0]).toContain('invalid git window');
  expect(verifyTestPairing(root, { since: '90d', limit: 0 }).errors[0]).toContain('invalid sample limit');
  expect(verifyTestPairing(root, { since: '90d', limit: 999 }).errors[0]).toContain('invalid sample limit');
});

test('a treatment runner that never reached a verdict is inconclusive, not decorative', () => {
  for (const outcome of ['error', 'timeout']) {
    expect(classifyReplay({ control: { outcome: 'pass' }, treatment: { outcome } })).toBe('inconclusive');
  }
});

test('real bun output for a test that cannot load is classified as binding-only', () => {
  // Synthetic counts hid this: bun never prints "fail 0" for a load failure, it
  // counts the file as a fail AND an error.
  const root = mkdtempSync(join(tmpdir(), 'escape-verify-bun-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 't', private: true }));
  const source = ["import 'escape-verify-missing-package';", "import { test } from 'bun:test';", "test('x', () => {});"].join(String.fromCharCode(10));
  writeFileSync(join(root, 'load.test.mjs'), source);
  const run = spawnSync('bun', ['test', './load.test.mjs'], { cwd: root, encoding: 'utf8' });
  const counts = parseRunnerCounts(String(run.stdout || '') + String(run.stderr || ''));
  expect(counts).toMatchObject({ fail: 1, error: 1 });
  expect(classifyReplay({ control: { outcome: 'pass' }, treatment: { outcome: 'fail', counts } })).toBe('catches_by_binding');
});

test('the report refuses a symlink planted at its path', () => {
  const root = mkdtempSync(join(tmpdir(), 'escape-verify-symlink-'));
  mkdirSync(join(root, '.xm', 'review'), { recursive: true });
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, escapeVerifyPath(root));
  expect(() => writeReport(root, { schema_v: 1 })).toThrow();
  expect(readFileSync(victim, 'utf8')).toBe('keep');
});
