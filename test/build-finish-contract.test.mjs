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
