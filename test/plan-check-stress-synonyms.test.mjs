/**
 * plan-check's failure-mode gate accepts either Korean rendering of
 * "pathological".
 *
 * STRESS_RE decides whether a task in a risk domain has stress/adversarial
 * done_criteria. It matched 병적 but not 병리, so the check's verdict depended on
 * which ordinary synonym the plan author happened to choose — a done_criteria
 * reading "병리적 케이스에서도 응답한다" was rejected while "병적 입력에서도
 * 응답한다" passed.
 *
 * The regex is a local constant inside cmdPlanCheck, so it is read out of the
 * source rather than imported. That keeps the test honest about what actually
 * ships without exporting an internal for testing's sake.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_MJS = join(ROOT, 'x-build', 'lib', 'x-build', 'plan.mjs');

/** The STRESS_RE literal exactly as it ships. */
function shippedStressRe() {
  const src = readFileSync(PLAN_MJS, 'utf8');
  const m = src.match(/const STRESS_RE = (\/.+\/[a-z]*);/);
  if (!m) throw new Error('STRESS_RE literal not found in plan.mjs');
  // eslint-disable-next-line no-new-func -- reading the shipped literal, not user input
  return new Function(`return ${m[1]}`)();
}

describe('plan-check stress/adversarial detection', () => {
  const RE = shippedStressRe();

  test('accepts both Korean renderings of pathological', () => {
    expect(RE.test('병적 입력에서도 응답한다')).toBe(true);
    expect(RE.test('병리적 케이스에서도 응답한다')).toBe(true);
  });

  test('still accepts the English and other established markers', () => {
    for (const dc of [
      'pathological input handled',
      'adversarial payloads rejected',
      'stress test at 10x load',
      '스트레스 상황에서 동작',
      'no timeout under load',
      '무한 루프에 빠지지 않는다',
    ]) {
      expect(RE.test(dc)).toBe(true);
    }
  });

  test('does not fire on ordinary done_criteria', () => {
    // The gate is only useful if it still distinguishes: a plain success
    // criterion must NOT count as stress coverage.
    for (const dc of [
      '정상 입력을 처리한다',
      'returns the parsed result',
      '응답 시간이 200ms 이하',
    ]) {
      expect(RE.test(dc)).toBe(false);
    }
  });
});
