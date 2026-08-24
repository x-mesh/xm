import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const docs = [
  readFileSync(join(ROOT, 'README.md'), 'utf8'),
  readFileSync(join(ROOT, 'README.ko.md'), 'utf8'),
];

describe('planner and build public docs', () => {
  test('describe x-plan as the planner and x-build as lean native execution', () => {
    for (const doc of docs) {
      expect(doc).toContain('x-plan');
      expect(doc).toContain('PlanEnvelope');
      expect(doc).toMatch(/native execution|native 실행/);
      expect(doc).toMatch(/sequentially by default|순차.*기본/);
    }
  });

  test('document the deprecated alias and explicit legacy planner', () => {
    for (const doc of docs) {
      expect(doc).toContain('xm build plan');
      expect(doc).toContain('deprecated alias');
      expect(doc).toContain('xm build legacy-plan');
      expect(doc).toContain('/xm:plan');
      expect(doc).toMatch(/Legacy lifecycle|Legacy lifecycle 호환/);
    }
  });

  test('do not advertise the retired PRD-parallel-gate flow as the default', () => {
    for (const doc of docs) {
      expect(doc).not.toContain('→ PRD → task decomposition → parallel agents → verified');
      expect(doc).not.toContain('→ PRD → 태스크 분해 → 병렬 에이전트 실행 → 검증 완료');
      expect(doc).not.toContain('Project lifecycle & PRD pipeline');
      expect(doc).not.toContain('프로젝트 라이프사이클 & PRD 파이프라인');
    }
  });
});
