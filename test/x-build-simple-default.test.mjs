import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const buildSkill = readFileSync(join(ROOT, 'x-build', 'skills', 'build', 'SKILL.md'), 'utf8');
const planSkill = readFileSync(join(ROOT, 'x-plan', 'skills', 'plan', 'SKILL.md'), 'utf8');
const taskSource = readFileSync(join(ROOT, 'x-build', 'lib', 'x-build', 'tasks.mjs'), 'utf8');

describe('x-build simple default workflow', () => {
  test('routes bare goals through adaptive native execution', () => {
    expect(buildSkill).toContain('# x-build — Evidence → Route → Native Execute');
    expect(buildSkill).toContain('bare goal / `build me ...`: Default Workflow');
    expect(buildSkill).toContain('host native agent');
    expect(buildSkill).toContain('direct route');
    expect(buildSkill).toContain('planned route');
    expect(buildSkill).toContain('결정적 quality gate');
    expect(buildSkill).toContain('clean state에서 planned route로 한 번만 escalation');
    expect(buildSkill).toContain('xm build route decide');
    expect(buildSkill).toContain('xm build route start');
    expect(buildSkill).toContain('xm build route verify');
    expect(buildSkill).toContain('xm build route finish');
    expect(buildSkill).toContain('route start --decision-id <id> --fallback');
    expect(buildSkill).toContain('xm build route status');
    expect(buildSkill).toContain('route abandon --decision-id <id>');
    expect(buildSkill).toContain('xm build route prove');
    expect(buildSkill).toContain('escalation 비율이 40%');
    expect(buildSkill).toContain('비용 20%');
    expect(buildSkill).toContain('p50 시간 15%');
    expect(buildSkill).toContain('Legacy experimental opt-in only');
    expect(buildSkill).toContain('`plan ...`: x-plan과 동일한 engine');
    expect(buildSkill).toContain('`legacy-plan ...`');
  });

  test('requires evidence for fallbacks and challenges the requested method', () => {
    for (const text of [buildSkill, planSkill, taskSource]) {
      expect(text).toMatch(/fallback/i);
      expect(text).toMatch(/concrete.*failure|구체적.*실패/is);
      expect(text).toMatch(/actual.*goal|underlying.*goal/i);
      expect(text).toMatch(/simplest|smallest/i);
    }
    expect(taskSource).toContain('never hide failure behind broad catches, empty results, or arbitrary defaults');
  });

  test('uses existing validation instead of automatic meta-gates', () => {
    expect(buildSkill).toContain('test, lint, build, review를 고정 checklist로 모두 실행하지 않습니다');
    expect(buildSkill).toContain('순차 실행이 기본입니다');
    expect(buildSkill).toContain('lifecycle quality gate를 만들거나 호출하지 않습니다');
    expect(planSkill).toContain('Do not list test, lint, build, and review as a fixed checklist');
    expect(planSkill).toContain('Plan sequential execution by default');
    expect(taskSource).toContain('Sequential execution is the default');
    expect(taskSource).toContain('Do not run test, lint, build, and review as a fixed checklist');
  });
});
