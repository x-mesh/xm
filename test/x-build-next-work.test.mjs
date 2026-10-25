import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');
const XM = join(ROOT, 'xm', 'scripts', 'xm');

// The fake gh answers `pr list` from a file, or fails when the file says so.
function setup({ prs = [], ghFails = false, later = {}, inbox = [] } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'xm-next-')));
  const xmDir = join(cwd, '.xm');
  for (const [project, items] of Object.entries(later)) {
    mkdirSync(join(xmDir, 'build', 'projects', project), { recursive: true });
    writeFileSync(join(xmDir, 'build', 'projects', project, 'later.json'), JSON.stringify({ items }));
  }
  mkdirSync(join(xmDir, 'inbox', 'archive'), { recursive: true });
  for (const item of inbox) writeFileSync(join(xmDir, 'inbox', `${item.id}.json`), JSON.stringify(item));
  writeFileSync(join(xmDir, 'inbox', 'archive', 'old.json'), JSON.stringify({ id: 'old', status: 'delivered', title: 'archived' }));
  writeFileSync(join(cwd, 'prs.json'), JSON.stringify(ghFails ? null : prs));
  writeFileSync(join(cwd, 'fake-gh.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.NEXT_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const prs = JSON.parse(readFileSync(process.env.NEXT_PRS, 'utf8'));
if (!prs) { process.stderr.write('gh: not logged in\\n'); process.exit(4); }
process.stdout.write(JSON.stringify(prs) + '\\n');
`);
  const env = { X_BUILD_ROOT: join(xmDir, 'build'), X_BUILD_GH_ARGV: JSON.stringify(['node', join(cwd, 'fake-gh.mjs')]), NEXT_PRS: join(cwd, 'prs.json'), NEXT_LOG: join(cwd, 'gh.log') };
  return { cwd, env };
}

function next(fixture, args = [], executable = CLI) {
  const command = executable === XM ? 'bash' : 'node';
  const argv = executable === XM ? [XM, 'next', ...args] : [CLI, 'next-work', ...args];
  const result = spawnSync(command, argv, { cwd: fixture.cwd, encoding: 'utf8', env: { ...process.env, XM_LIB: ROOT, XKIT_SERVER: undefined, ...fixture.env } });
  let output = null;
  try { output = JSON.parse(result.stdout); } catch {}
  return { code: result.status, output, stdout: result.stdout, stderr: result.stderr };
}

const pr = (number, extra = {}) => ({ number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], ...extra });
const laterItem = (id, extra = {}) => ({ id, title: `later ${id}`, status: 'open', impact: 'none', created_at: '2026-10-01T00:00:00Z', ...extra });

describe('xm next', () => {
  test('ranks a ready PR, then a failing PR, then inbox, then later items, oldest first within a level', () => {
    const fixture = setup({
      prs: [pr(5, { statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }), pr(4)],
      inbox: [{ id: 'toss-1', status: 'delivered', title: 'bug from b', from_project: 'b', created_at: '2026-10-02T00:00:00Z' }, { id: 'toss-2', status: 'resolved', title: 'done' }],
      later: { p1: [laterItem('l1', { created_at: '2026-10-05T00:00:00Z' }), laterItem('l2', { status: 'promoted' })], p2: [laterItem('l9', { created_at: '2026-09-01T00:00:00Z' })] },
    });
    const result = next(fixture, ['--limit', '10', '--json']);
    expect(result.code).toBe(0);
    expect(result.output.candidates.map((c) => `${c.source}:${c.id}`)).toEqual(['pr:#4', 'pr:#5', 'inbox:toss-1', 'later:l9', 'later:l1']);
    expect(result.output.candidates[0]).toMatchObject({ reason: 'checks passed and mergeable', command: 'xm pr land 4 --dry-run' });
    expect(result.output.candidates[1]).toMatchObject({ reason: 'checks failed', command: 'gh pr checks 5' });
    expect(result.output.candidates[2].command).toBe('xm inbox take toss-1');
    expect(result.output.candidates[3]).toMatchObject({ project: 'p2', command: 'xm build later promote l9 --project p2' });
    expect(result.output.sources).toEqual({ prs: { status: 'ok', count: 2 }, inbox: { status: 'ok', count: 1 }, later: { status: 'ok', count: 2 } });
  });

  test('a running check, a draft, a conflict, and a not-yet-computed mergeable state each get their own reason', () => {
    const fixture = setup({ prs: [pr(1, { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }), pr(2, { isDraft: true }), pr(3, { mergeable: 'CONFLICTING' }), pr(6, { mergeable: 'UNKNOWN' })] });
    const byId = Object.fromEntries(next(fixture, ['--limit', '5', '--json']).output.candidates.map((c) => [c.id, c]));
    expect(byId['#1']).toMatchObject({ reason: 'checks running', command: 'xm pr land 1 --wait --dry-run' });
    expect(byId['#2']).toMatchObject({ reason: 'draft PR', command: 'gh pr ready 2' });
    expect(byId['#3']).toMatchObject({ reason: 'merge conflict', command: 'gh pr view 3' });
    expect(byId['#6']).toMatchObject({ reason: 'checks passed, mergeability not computed yet', command: 'xm pr land 6 --dry-run' });
  });

  test('later impact raises an item above impact none', () => {
    const fixture = setup({ later: { p: [laterItem('l1'), laterItem('l2', { impact: 'unknown', created_at: '2026-10-09T00:00:00Z' })] } });
    expect(next(fixture, ['--json']).output.candidates.map((c) => c.id)).toEqual(['l2', 'l1']);
  });

  test('the default limit is 3, and a batch command lists the non-PR picks', () => {
    const fixture = setup({ prs: [pr(1)], later: { p: [laterItem('l1'), laterItem('l2'), laterItem('l3')] } });
    const result = next(fixture, ['--json']);
    expect(result.output.candidates).toHaveLength(3);
    expect(result.output.total).toBe(4);
    expect(result.output.batch_command).toBe('/xm:batch "later l1" "later l2"');
  });

  test('a gh failure is reported and the other sources still answer', () => {
    const fixture = setup({ ghFails: true, later: { p: [laterItem('l1')] } });
    const result = next(fixture, ['--json']);
    expect(result.code).toBe(0);
    expect(result.output.sources.prs).toEqual({ status: 'unavailable', count: 0, error: 'gh: not logged in' });
    expect(result.output.candidates.map((c) => c.id)).toEqual(['l1']);
    expect(next(fixture).stdout).toContain('⚠ PRs skipped: gh: not logged in');
  });

  test('it asks gh only for your own open PRs', () => {
    const fixture = setup();
    next(fixture, ['--json']);
    expect(JSON.parse(readFileSync(join(fixture.cwd, 'gh.log'), 'utf8').trim())).toEqual(['pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,url,isDraft,mergeable,statusCheckRollup']);
  });

  test('an empty queue says so, and bad arguments exit 2', () => {
    const fixture = setup();
    expect(next(fixture).stdout).toContain('Nothing to pick up');
    for (const args of [['--limit', '0'], ['--limit'], ['--bogus'], ['extra']]) expect(next(fixture, args).code).toBe(2);
  });

  test('the xm dispatcher routes `xm next`', () => {
    const fixture = setup({ later: { p: [laterItem('l1')] } });
    const result = next(fixture, ['--json'], XM);
    expect(result.code).toBe(0);
    expect(result.output.candidates[0].id).toBe('l1');
  });
});
