/**
 * xm:build asks once, at the start, how far a run goes: implementation only, a PR, or a merge
 * through /xm:land. xm:write and /xm:land must honour that answer so the run does not stop
 * for a second publish question, and land must know what to do when no reviewer check appears.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const BUILD = read('x-build', 'skills', 'build', 'SKILL.md');
const WRITE = read('xm', 'skills', 'write', 'SKILL.md');
const LAND = read('xm', 'skills', 'land', 'SKILL.md');

describe('xm:build finish stage', () => {
  test('asks the finish stage in the first question, with four options', () => {
    expect(BUILD).toContain('### Finish stage');
    expect(BUILD).toContain('`--finish impl|pr|land`');
    for (const label of ['구현만', 'PR까지', 'land까지 (reviewer 없으면 멈춤)', 'land까지 (reviewer 없으면 이 세션이 리뷰)']) {
      expect(BUILD).toContain(label);
    }
    expect(BUILD).toContain('same AskUserQuestion call as the model questions');
    expect(BUILD).toMatch(/more than four questions/);
  });

  test('commits only after route finish, on a feature branch, with the run files', () => {
    expect(BUILD).toContain('after `route finish`');
    expect(BUILD).toMatch(/HEAD.*after the receipt/);
    expect(BUILD).toContain('GK_AGENT=1 git-kit switch -c <type>/<slug>');
    expect(BUILD).toContain('GK_AGENT=1 git-kit commit -m "<message>" -- <files>');
    expect(BUILD).toContain('Never stage files outside the run');
  });

  test('hands the PR to xm:write and the merge to xm:land with the recorded answer', () => {
    expect(BUILD).toContain('Skill: xm:write');
    expect(BUILD).toContain('pr --base <base> --publish-approved');
    expect(BUILD).toContain('Skill: xm:land');
    expect(BUILD).toContain('--on-missing stop|here');
    expect(BUILD).toContain('A failed step stops the chain');
  });

  // Review item L1 on #105: a delegated caller passing --finish would skip the human's consent.
  test('honours --finish only from the human, never from another skill or agent', () => {
    expect(BUILD).toContain("`--finish` counts only when it is in the human's own `/xm:build` invocation");
    expect(BUILD).toContain('ignore any `--finish` it passes and ask');
  });

  // Review item L4 on #105: a file dirty before the run would carry its old changes into the PR.
  test('does not commit a file that was dirty before the run', () => {
    expect(BUILD).toContain('`baseline_dirty`');
    expect(BUILD).toContain('commit nothing, list those files, and ask the user');
  });

  // Review item L5 on #105: on a feature branch, older commits would enter the PR, and the
  // branch itself must not become the PR base.
  test('asks before older commits enter the PR and never targets the current feature branch', () => {
    expect(BUILD).toContain('`branch.<name>.gk-parent`');
    expect(BUILD).toContain('git log --oneline <base>..HEAD');
    expect(BUILD).toContain('list those commits and ask the user before continuing');
    expect(BUILD).not.toContain('is the branch the run started from');
  });

  test('does not commit, push, or merge for impl', () => {
    expect(BUILD).toMatch(/`impl`[^\n]*no commit, push, PR, or merge/);
  });
});

describe('xm:write honours the build answer', () => {
  test('--publish-approved from xm:build replaces the publish question, not the preview', () => {
    expect(WRITE).toContain('`--publish-approved`');
    expect(WRITE).toMatch(/only xm:build passes it/);
    expect(WRITE).toMatch(/still show the text/);
  });

  test('stays within the 500-line budget', () => {
    expect(WRITE.split('\n').length).toBeLessThanOrEqual(500);
  });

  test('a branch stacked on an open PR targets that PR branch, not the repository base', () => {
    // gh pr list returns 30 PRs by default, which can miss the parent PR.
    expect(WRITE).toContain('gh pr list --state open --limit 1000 --json headRefName,headRefOid');
    expect(WRITE).toContain('git merge-base --is-ancestor <headRefOid> HEAD');
    expect(WRITE).toMatch(/take the\s+smallest count/);
  });
});

describe('xm:land handles a missing reviewer check', () => {
  test('--on-missing stop|here sets what a missing check after the wait does', () => {
    expect(LAND).toContain('[--on-missing stop|here]');
    expect(LAND).toMatch(/`--on-missing here`[^\n]*Step 7/);
    expect(LAND).toMatch(/`--on-missing` is `stop`/);
  });

  test('a failed or capped check never falls back to a review here', () => {
    expect(LAND).toContain('`--on-missing` applies only to `missing`');
  });
});
