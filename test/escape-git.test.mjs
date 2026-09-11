import { test, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GIT_ESCAPE_CONFIG, classifyCommitType, gitWindowArg, isIgnoredPath,
  isTestPath, normalizeGitPath, parseGitLog, pathArea, summarizeGitHistory,
} from '../x-build/lib/x-build/escape-git.mjs';
import { collectGitEscapes } from '../x-build/lib/x-build/attention-collect.mjs';

const RS = '\u0000';
const FS_ = '\u001f';
const record = (sha, ts, subject, files) => RS + [sha, ts, subject].join(FS_) + '\n' + files.join('\n') + '\n';

test('window translation refuses forms git silently accepts as empty', () => {
  // `git log --since=30d` is not an error: it returns zero commits. Translating
  // is what keeps an empty result from meaning "no defects".
  expect(gitWindowArg('30d')).toBe('30.days.ago');
  expect(gitWindowArg('6h')).toBe('6.hours.ago');
  expect(gitWindowArg('90m')).toBe('90.minutes.ago');
  for (const bad of ['', null, '0d', '30', 'd', '30days', '99999d', '-1d', '30.days.ago']) expect(gitWindowArg(bad)).toBeNull();
});

test('conventional commits classify high, keyword fallback classifies low', () => {
  expect(classifyCommitType('fix(build): isolate mutation execution')).toEqual({ type: 'fix', confidence: 'high' });
  expect(classifyCommitType('perf(review-board): cache aggregates')).toEqual({ type: 'perf', confidence: 'high' });
  expect(classifyCommitType('fix!: drop the legacy path')).toEqual({ type: 'fix', confidence: 'high' });
  expect(classifyCommitType('Revert "feat(teams): expand waves"')).toEqual({ type: 'revert', confidence: 'high' });
  expect(classifyCommitType('revert(build): undo the gate change')).toEqual({ type: 'revert', confidence: 'high' });
  expect(classifyCommitType('hotfix the broken release script')).toEqual({ type: 'fix', confidence: 'low' });
  for (const subject of ['feat(peer): relay latency', 'docs: refresh readme', 'chore(release): v2.25.1', 'release: v2.25.0', '']) {
    expect(classifyCommitType(subject).type).toBeNull();
  }
});

test('test paths are detected by directory, prefix, and suffix across languages', () => {
  for (const path of ['test/mutate.test.mjs', 'tests_v2/test_focus.py', 'daemon/term-meshd/tests/oplog_gc.rs',
    'termMeshTests/AgentPaneTests.swift', 'pkg/thing_test.go', 'spec/models/user_spec.rb']) {
    expect(isTestPath(path)).toBe(true);
  }
  for (const path of ['x-build/lib/x-build/mutate.mjs', 'Sources/TeamOrchestrator.swift', 'latest/contest.js']) {
    expect(isTestPath(path)).toBe(false);
  }
});

test('generated and vendored paths are ignored, including configured copy roots', () => {
  expect(isIgnoredPath('node_modules/pkg/index.js')).toBe(true);
  expect(isIgnoredPath('CHANGELOG.md')).toBe(true);
  expect(isIgnoredPath('xm/skills.checksums.json')).toBe(true);
  expect(isIgnoredPath('x-build/lib/x-build/mutate.mjs')).toBe(false);
  const config = { ...DEFAULT_GIT_ESCAPE_CONFIG, exclude_roots: ['xm/lib'] };
  expect(isIgnoredPath('xm/lib/x-build/mutate.mjs', config)).toBe(true);
  expect(isIgnoredPath('xm/libertine/a.mjs', config)).toBe(false);
});

test('paths normalize and areas collapse to the configured depth', () => {
  expect(normalizeGitPath('./src//a.js')).toBe('src/a.js');
  for (const bad of ['/etc/passwd', '../escape.js', '"quoted path.js"', '', null]) expect(normalizeGitPath(bad)).toBeNull();
  expect(pathArea('Sources/TeamOrchestrator.swift')).toBe('Sources');
  expect(pathArea('daemon/term-meshd/src/tokens.rs')).toBe('daemon/term-meshd');
  expect(pathArea('Makefile')).toBe('Makefile');
});

test('log parsing survives newlines in subjects and counts malformed records', () => {
  const text = record('a1b2c3d4', '2026-09-01T00:00:00Z', 'fix(core): one', ['src/a.js'])
    + record('b2c3d4e5', '2026-09-02T00:00:00Z', 'fix(core): two', ['src/b.js', 'test/b.test.mjs'])
    + RS + 'not-a-sha' + FS_ + 'nope' + FS_ + 'broken\n'
    + RS + 'short\n';
  const parsed = parseGitLog(text);
  expect(parsed.commits).toHaveLength(2);
  expect(parsed.malformed).toBe(2);
  expect(parsed.commits[0]).toMatchObject({ sha: 'a1b2c3d4', subject: 'fix(core): one', files: ['src/a.js'] });
  expect(parseGitLog('')).toEqual({ commits: [], malformed: 0 });
});

test('perf is classified but never becomes a defect, revert does', () => {
  const commits = parseGitLog(
    record('aaaaaaa1', '2026-09-01T00:00:00Z', 'perf(x): cache it', ['src/a.js'])
    + record('aaaaaaa2', '2026-09-02T00:00:00Z', 'revert(x): undo it', ['src/a.js'])
  ).commits;
  const summary = summarizeGitHistory(commits);
  expect(summary.counts).toMatchObject({ perf: 1, revert: 1, fix: 0 });
  expect(summary.defects.map(row => row.commit_type)).toEqual(['revert']);
  expect(summary.defect_commits).toBe(1);
});

test('test pairing is measured per commit and repeat offenders rank by fix count', () => {
  const commits = parseGitLog(
    record('bbbbbbb1', '2026-09-01T00:00:00Z', 'fix(a): one', ['src/hot.js', 'test/hot.test.mjs'])
    + record('bbbbbbb2', '2026-09-02T00:00:00Z', 'fix(a): two', ['src/hot.js'])
    + record('bbbbbbb3', '2026-09-03T00:00:00Z', 'fix(b): three', ['src/cold.js', 'CHANGELOG.md'])
  ).commits;
  const summary = summarizeGitHistory(commits);
  expect(summary.defect_commits).toBe(3);
  expect(summary.defect_commits_with_test).toBe(1);
  expect(summary.test_pairing_rate).toBe(0.333);
  expect(summary.repeat_offenders).toEqual([{ file: 'src/hot.js', fixes: 2 }]);
  expect(summary.defects.find(row => row.sha === 'bbbbbbb2').fix_shipped_test).toBe(false);
  // CHANGELOG is ignored, so that commit contributes exactly one defect site.
  expect(summary.defects.filter(row => row.sha === 'bbbbbbb3')).toHaveLength(1);
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'escape-git-'));
  execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: root, shell: '/bin/bash' });
  return root;
}
function commit(root, subject, files) {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  execSync(`git add -A && git commit -qm ${JSON.stringify(subject)}`, { cwd: root, shell: '/bin/bash' });
}

test('collector turns history into ledger rows with git provenance', () => {
  const root = repo();
  commit(root, 'feat(core): add', { 'src/a.js': 'v1' });
  commit(root, 'fix(core): repair without a test', { 'src/a.js': 'v2' });
  commit(root, 'fix(core): repair with a test', { 'src/a.js': 'v3', 'test/a.test.mjs': 'ok' });
  const result = collectGitEscapes(root, { since: '30d' });
  expect(result.available).toBe(true);
  expect(result.window_commits).toBe(3);
  expect(result.summary.test_pairing_rate).toBe(0.5);
  expect(result.rows).toHaveLength(2);
  for (const row of result.rows) expect(row).toMatchObject({ type: 'escape', source: 'git', attribution: 'history', escape_class: 'shipped_defect', file: 'src/a.js' });
  // Same file, different commits: ids must not collide or the ledger dedupes a real signal away.
  expect(new Set(result.rows.map(row => row.id)).size).toBe(2);
  expect(result.rows.some(row => row.fix_shipped_test === false)).toBe(true);
  expect(result.rows.some(row => row.fix_shipped_test === true)).toBe(true);
});

test('an empty window on a repo with history is reported, not treated as clean', () => {
  const root = repo();
  commit(root, 'fix(core): repair', { 'src/a.js': 'v2' });
  const result = collectGitEscapes(root, { since: '1m' });
  expect(result.repo_has_history).toBe(true);
  // A window that matches nothing must never look identical to "no defects".
  if (result.window_commits === 0) expect(result.errors[0]).toContain('matched no commits');
  const bad = collectGitEscapes(root, { since: '30' });
  expect(bad.available).toBe(false);
  expect(bad.errors[0]).toContain('invalid git window');
});

test('a directory without git degrades instead of throwing', () => {
  const result = collectGitEscapes(mkdtempSync(join(tmpdir(), 'no-git-')), { since: '30d' });
  expect(result.available).toBe(false);
  expect(result.rows).toEqual([]);
  expect(result.repo_has_history).toBe(false);
});
