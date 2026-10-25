import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');
const XM = join(ROOT, 'xm', 'scripts', 'xm');
const HEAD = 'a'.repeat(40);

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

// gh state lives in a file so one test can change it between calls: `checks`
// is a list of check snapshots, and each `gh pr checks` call takes the next one.
function setup(state = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'xm-pr-land-')));
  git(cwd, ['init', '-b', 'develop']);
  git(cwd, ['config', 'user.email', 'land@example.com']);
  git(cwd, ['config', 'user.name', 'Land Test']);
  writeFileSync(join(cwd, 'README.md'), '# fixture\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'init']);
  const files = { log: join(cwd, 'calls.jsonl'), state: join(cwd, 'gh-state.json'), gh: join(cwd, 'fake-gh.mjs'), gk: join(cwd, 'fake-gk.mjs') };
  writeFileSync(files.state, JSON.stringify({
    pr: { number: 7, url: 'https://example.test/pr/7', state: 'OPEN', isDraft: false, baseRefName: 'develop', headRefName: 'feat/x', headRefOid: HEAD, isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', mergeCommit: null, mergedAt: null },
    checks: [[{ name: 'test', state: 'SUCCESS', bucket: 'pass' }]],
    ...state,
  }));
  writeFileSync(files.gh, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.LAND_LOG, JSON.stringify({ tool: 'gh', argv, cwd: process.cwd() }) + '\\n');
const state = JSON.parse(readFileSync(process.env.LAND_STATE, 'utf8'));
const save = () => writeFileSync(process.env.LAND_STATE, JSON.stringify(state));
if (argv[0] === 'pr' && argv[1] === 'view') {
  if (state.views?.length) { Object.assign(state.pr, state.views.shift()); save(); }
  const fields = argv[argv.indexOf('--json') + 1].split(',');
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map((f) => [f, state.pr[f]]))) + '\\n');
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'checks') {
  const rows = state.checks.length > 1 ? state.checks.shift() : state.checks[0];
  save();
  if (rows === null) { process.stderr.write("no checks reported on the 'feat/x' branch\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(rows) + '\\n');
  process.exit(rows.some((r) => r.bucket === 'pending') ? 8 : rows.some((r) => r.bucket === 'fail') ? 1 : 0);
}
if (argv[0] === 'pr' && argv[1] === 'merge') {
  const head = argv[argv.indexOf('--match-head-commit') + 1];
  if (state.mergeFails || head !== state.pr.headRefOid) { process.stderr.write('merge refused\\n'); process.exit(1); }
  if (!state.mergeQueued) Object.assign(state.pr, { state: 'MERGED', mergedAt: '2026-10-25T00:00:00Z', mergeCommit: { oid: 'b'.repeat(40) } });
  save();
  process.exit(0);
}
process.exit(2);
`);
  writeFileSync(files.gk, `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.LAND_LOG, JSON.stringify({ tool: 'gk', argv: process.argv.slice(2), cwd: process.cwd(), agent: process.env.GK_AGENT }) + '\\n');
const failing = (process.env.LAND_GK_FAIL || '').split(',').includes(process.argv[2]);
process.stdout.write(JSON.stringify(failing ? { schema: 1, state: 'blocked', ok: false, result: null, error: { message: process.argv[2] + ' refused' } } : { schema: 1, state: 'ok', ok: true, result: {}, error: null }) + '\\n');
`);
  const env = { LAND_LOG: files.log, LAND_STATE: files.state, X_BUILD_GH_ARGV: JSON.stringify(['node', files.gh]), X_BUILD_GK_ARGV: JSON.stringify(['node', files.gk]), X_BUILD_PR_LAND_POLL_MS: '5' };
  return { cwd, env, files };
}

function land(fixture, args, executable = CLI) {
  const command = executable === XM ? 'bash' : 'node';
  const result = spawnSync(command, [executable, 'pr', 'land', ...args, '--json'], {
    cwd: fixture.cwd, env: { ...process.env, XM_LIB: ROOT, XKIT_SERVER: undefined, ...fixture.env }, encoding: 'utf8',
  });
  let output = null;
  try { output = JSON.parse(result.stdout); } catch {}
  return { code: result.status, output, stderr: result.stderr };
}

function calls(fixture) {
  if (!existsSync(fixture.files.log)) return [];
  return readFileSync(fixture.files.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const merges = (fixture) => calls(fixture).filter((call) => call.tool === 'gh' && call.argv[1] === 'merge');

function setHead(fixture, oid) {
  const state = JSON.parse(readFileSync(fixture.files.state, 'utf8'));
  state.pr.headRefOid = oid;
  writeFileSync(fixture.files.state, JSON.stringify(state));
}

function writeReview(fixture, id, { commit = HEAD, outcome = 'success', verdict = 'LGTM' } = {}) {
  const dir = join(fixture.cwd, '.xm', 'review', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ snapshot: { commit } }));
  writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ outcome }));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ verdict }));
}

describe('xm pr land', () => {
  test('without --yes it shows the plan, waits for confirmation, and does not merge', () => {
    const fixture = setup();
    const result = land(fixture, ['7']);
    expect(result.code).toBe(2);
    expect(result.output.status).toBe('awaiting_confirmation');
    expect(result.output.merge_argv).toEqual(['gh', 'pr', 'merge', 'https://example.test/pr/7', '--merge', '--match-head-commit', HEAD]);
    expect(merges(fixture)).toEqual([]);
  });

  test('--dry-run exits 0 and does not merge', () => {
    const fixture = setup();
    const result = land(fixture, ['7', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.output.status).toBe('dry-run');
    expect(merges(fixture)).toEqual([]);
  });

  test('--dry-run and --yes together are rejected', () => {
    const result = land(setup(), ['--dry-run', '--yes']);
    expect(result.code).toBe(2);
    expect(result.output.errors[0]).toContain('cannot be combined');
  });

  test('--yes merges the reviewed head and pulls the checked-out base', () => {
    const fixture = setup();
    const result = land(fixture, ['7', '--yes']);
    expect(result.code).toBe(0);
    expect(result.output.status).toBe('merged');
    expect(result.output.merge_commit).toBe('b'.repeat(40));
    expect(merges(fixture)[0].argv).toEqual(['pr', 'merge', 'https://example.test/pr/7', '--merge', '--match-head-commit', HEAD]);
    const pull = calls(fixture).find((call) => call.tool === 'gk' && call.argv[0] === 'pull');
    expect(pull.argv).toEqual(['pull', '--strategy', 'ff-only', '--no-autostash']);
    expect(pull.cwd).toBe(fixture.cwd);
    expect(pull.agent).toBe('1');
    expect(result.output.after.sync.status).toBe('pulled');
    expect(result.output.after.cleanup.status).toBe('skipped');
  });

  test('a failing check blocks the merge', () => {
    const fixture = setup({ checks: [[{ name: 'test', state: 'FAILURE', bucket: 'fail' }, { name: 'lint', state: 'SUCCESS', bucket: 'pass' }]] });
    const result = land(fixture, ['7', '--yes']);
    expect(result.code).toBe(2);
    expect(result.output.status).toBe('blocked');
    expect(result.output.blocker).toBe('checks failed: test');
    expect(merges(fixture)).toEqual([]);
  });

  test('a pending check blocks without --wait', () => {
    const fixture = setup({ checks: [[{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }]] });
    const result = land(fixture, ['7', '--yes']);
    expect(result.output.status).toBe('blocked');
    expect(result.output.blocker).toBe('checks still pending: test');
    expect(merges(fixture)).toEqual([]);
  });

  test('--wait polls until pending checks pass, then merges', () => {
    const fixture = setup({ checks: [
      [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }],
      [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }],
      [{ name: 'test', state: 'SUCCESS', bucket: 'pass' }],
    ] });
    const result = land(fixture, ['7', '--yes', '--wait']);
    expect(result.output.status).toBe('merged');
    expect(calls(fixture).filter((call) => call.tool === 'gh' && call.argv[1] === 'checks').length).toBe(3);
  });

  test('--wait stops at the timeout and leaves the PR open', () => {
    const fixture = setup({ checks: [[{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }]] });
    const result = land(fixture, ['7', '--yes', '--wait', '--timeout', '0']);
    expect(result.output.status).toBe('blocked');
    expect(merges(fixture)).toEqual([]);
  });

  test('a PR with no checks is blocked unless --allow-no-checks is given', () => {
    const fixture = setup({ checks: [null] });
    const blocked = land(fixture, ['7', '--yes']);
    expect(blocked.output.status).toBe('blocked');
    expect(blocked.output.blocker).toBe('no checks reported; pass --allow-no-checks to merge a PR without checks');
    expect(merges(fixture)).toEqual([]);

    const allowed = land(fixture, ['7', '--dry-run', '--allow-no-checks']);
    expect(allowed.output.status).toBe('dry-run');
    expect(allowed.output.checks).toEqual({ status: 'none', total: 0, failed: [], pending: [] });
  });

  test('--wait keeps polling while CI has not registered any check', () => {
    const fixture = setup({ checks: [null, null, [{ name: 'test', state: 'SUCCESS', bucket: 'pass' }]] });
    const result = land(fixture, ['7', '--yes', '--wait']);
    expect(result.output.status).toBe('merged');
    expect(calls(fixture).filter((call) => call.tool === 'gh' && call.argv[1] === 'checks').length).toBe(3);
  });

  test('every gh call after the first names the PR by its URL', () => {
    const fixture = setup({ checks: [[{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }], [{ name: 'test', state: 'SUCCESS', bucket: 'pass' }]] });
    land(fixture, ['https://example.test/pr/7', '--yes', '--wait']);
    const ghCalls = calls(fixture).filter((call) => call.tool === 'gh');
    expect(ghCalls.length).toBeGreaterThan(3);
    for (const call of ghCalls) expect(call.argv[2]).toBe('https://example.test/pr/7');
  });

  test('--wait stops when the PR becomes a draft or closes', () => {
    const fixture = setup({ checks: [[{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }]], views: [{}, { isDraft: true }] });
    const result = land(fixture, ['7', '--yes', '--wait']);
    expect(result.output.status).toBe('blocked');
    expect(result.output.blocker).toBe('PR is a draft');
    expect(calls(fixture).filter((call) => call.tool === 'gh' && call.argv[1] === 'checks').length).toBe(2);
  });

  test('a PR merged by someone else during --wait takes the already-merged path', () => {
    const fixture = setup({ checks: [[{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }]], views: [{}, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }] });
    const result = land(fixture, ['7', '--yes', '--wait']);
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({ status: 'merged', reused: true, merge_commit: 'e'.repeat(40) });
    expect(result.output.after.sync.status).toBe('pulled');
    expect(merges(fixture)).toEqual([]);
  });

  test('a failed base sync after the merge exits non-zero', () => {
    const fixture = setup();
    fixture.env.LAND_GK_FAIL = 'pull';
    const result = land(fixture, ['7', '--yes']);
    expect(result.code).toBe(1);
    expect(result.output.status).toBe('merged');
    expect(result.output.after.sync).toMatchObject({ status: 'failed', error: 'pull refused' });
  });

  test('a draft or conflicting PR is blocked', () => {
    const draft = setup();
    const state = JSON.parse(readFileSync(draft.files.state, 'utf8'));
    state.pr.isDraft = true;
    writeFileSync(draft.files.state, JSON.stringify(state));
    expect(land(draft, ['7', '--yes']).output.blocker).toBe('PR is a draft');

    const conflicting = setup();
    const other = JSON.parse(readFileSync(conflicting.files.state, 'utf8'));
    Object.assign(other.pr, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    writeFileSync(conflicting.files.state, JSON.stringify(other));
    expect(land(conflicting, ['7', '--yes']).output.blocker).toBe('PR mergeable state is CONFLICTING');
    expect(merges(draft).concat(merges(conflicting))).toEqual([]);
  });

  test('--require-review accepts only a finished LGTM review of the current head', () => {
    const fixture = setup();
    writeReview(fixture, 'review-1-old-head', { commit: 'c'.repeat(40) });
    writeReview(fixture, 'review-2-failed', { outcome: 'failed' });
    writeReview(fixture, 'review-3-changes', { verdict: 'Request Changes' });
    const missing = land(fixture, ['7', '--yes', '--require-review']);
    expect(missing.output.status).toBe('blocked');
    expect(missing.output.blocker).toBe(`no finished LGTM review for head ${HEAD}`);
    expect(merges(fixture)).toEqual([]);

    writeReview(fixture, 'review-0-approved');
    const approved = land(fixture, ['7', '--yes', '--require-review']);
    expect(approved.output.status).toBe('merged');
    expect(approved.output.review).toEqual({ status: 'approved', run_id: 'review-0-approved', verdict: 'LGTM' });
  });

  test('a PR that is already merged skips the merge and still runs the follow-up', () => {
    const fixture = setup();
    const state = JSON.parse(readFileSync(fixture.files.state, 'utf8'));
    Object.assign(state.pr, { state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } });
    writeFileSync(fixture.files.state, JSON.stringify(state));
    const result = land(fixture, ['7', '--yes']);
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({ status: 'merged', reused: true, merge_commit: 'd'.repeat(40) });
    expect(result.output.after.sync.status).toBe('pulled');
    expect(merges(fixture)).toEqual([]);
  });

  test('a merge that gh accepted but did not finish is reported as pending', () => {
    const fixture = setup({ mergeQueued: true });
    const result = land(fixture, ['7', '--yes']);
    expect(result.code).toBe(2);
    expect(result.output.status).toBe('merge_pending');
  });

  test('a refused merge is reported as blocked', () => {
    const fixture = setup({ mergeFails: true });
    const result = land(fixture, ['7', '--yes']);
    expect(result.code).toBe(2);
    expect(result.output.status).toBe('blocked');
    expect(result.output.blocker).toContain('merge refused');
  });

  test('--cleanup removes the head branch worktree from the base worktree', () => {
    const fixture = setup();
    const headTree = join(fixture.cwd, '..', `${fixture.cwd.split('/').pop()}-feat-x`);
    git(fixture.cwd, ['worktree', 'add', '-b', 'feat/x', headTree]);
    setHead(fixture, git(headTree, ['rev-parse', 'HEAD']));
    const result = land(fixture, ['7', '--yes', '--cleanup']);
    expect(result.output.after.cleanup).toEqual({ status: 'removed', worktree: realpathSync(headTree) });
    const remove = calls(fixture).find((call) => call.tool === 'gk' && call.argv[0] === 'worktree');
    expect(remove.argv).toEqual(['worktree', 'remove', realpathSync(headTree)]);
    expect(remove.cwd).toBe(fixture.cwd);
  });

  test('--cleanup skips a same-named worktree that is not at the merged head, and fork PRs', () => {
    const fixture = setup();
    const headTree = join(fixture.cwd, '..', `${fixture.cwd.split('/').pop()}-feat-x`);
    git(fixture.cwd, ['worktree', 'add', '-b', 'feat/x', headTree]);
    const moved = land(fixture, ['7', '--yes', '--cleanup']);
    expect(moved.output.after.cleanup).toEqual({ status: 'skipped', reason: `${realpathSync(headTree)} is not at the merged head ${HEAD}` });

    const fork = setup({ pr: { ...JSON.parse(readFileSync(fixture.files.state, 'utf8')).pr, state: 'OPEN', mergeCommit: null, isCrossRepository: true, headRefOid: git(headTree, ['rev-parse', 'HEAD']) } });
    const forked = land(fork, ['7', '--yes', '--cleanup']);
    expect(forked.output.after.cleanup).toEqual({ status: 'skipped', reason: 'the PR comes from another repository' });
    expect(calls(fixture).concat(calls(fork)).some((call) => call.tool === 'gk' && call.argv[0] === 'worktree')).toBe(false);
  });

  test('the base sync is skipped when no worktree has the base checked out', () => {
    const fixture = setup();
    git(fixture.cwd, ['switch', '-c', 'other']);
    const result = land(fixture, ['7', '--yes']);
    expect(result.output.after.sync).toEqual({ status: 'skipped', reason: 'develop is not checked out in any worktree' });
    expect(calls(fixture).some((call) => call.tool === 'gk')).toBe(false);
  });

  test('the xm dispatcher routes `xm pr land`', () => {
    const fixture = setup();
    const result = land(fixture, ['7', '--dry-run'], XM);
    expect(result.code).toBe(0);
    expect(result.output.status).toBe('dry-run');
  });
});
