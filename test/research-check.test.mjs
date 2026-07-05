/**
 * research-check — deterministic research-routing gauge tests.
 * The robustness contract (user requirement): quick-eligible ONLY at 0/4
 * signals; any unjudgeable signal fails SAFE (counts as HIT, pushing toward
 * research); a suggestion is never an automatic skip (that half lives in
 * SKILL.md, asserted by skill-structure conventions).
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function run(args, cwd) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', cwd });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

function runJSON(args, cwd) {
  const r = run([...args, '--json'], cwd);
  return JSON.parse(r.stdout);
}

// Seed an x-memory index whose tokens overlap the goal → signal 2 misses.
function seedMemory(tmp, title) {
  const memDir = join(tmp, '.xm', 'memory');
  mkdirSync(join(memDir, 'memories'), { recursive: true });
  writeFileSync(join(memDir, 'index.json'), JSON.stringify([
    { id: 'mem-1', title, tags: [], why: title, created_at: new Date().toISOString() },
  ]));
}

describe('research-check — deterministic gauge', () => {
  test('0/4 signals → quick-eligible (memory map exists, calm vocabulary)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rc-test-'));
    try {
      seedMemory(tmp, 'improve the wording of the welcome banner text');
      const out = runJSON(['research-check', '--goal', 'improve the wording of the welcome banner text'], tmp);
      expect(out.hits).toBe(0);
      expect(out.recommendation).toBe('quick-eligible');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('contract vocabulary alone → slim, NEVER quick-eligible', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rc-test-'));
    try {
      seedMemory(tmp, 'schema change for the task contract fields');
      const out = runJSON(['research-check', '--goal', 'add a schema field to the task contract'], tmp);
      expect(out.hits).toBeGreaterThanOrEqual(1);
      expect(out.recommendation).not.toBe('quick-eligible');
      const s1 = out.signals.find((s) => s.id === 'contract-vocabulary');
      expect(s1.hit).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no memory map (fresh project) → signal 2 HIT', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rc-test-'));
    try {
      const out = runJSON(['research-check', '--goal', 'improve the wording of the welcome banner text'], tmp);
      const s2 = out.signals.find((s) => s.id === 'no-memory-map');
      expect(s2.hit).toBe(true);
      expect(out.recommendation).not.toBe('quick-eligible');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('empty/short goal → every signal fails safe (4/4, full)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rc-test-'));
    try {
      const out = runJSON(['research-check', '--goal', 'fix'], tmp);
      expect(out.hits).toBe(4);
      expect(out.recommendation).toBe('full');
      expect(out.signals.every((s) => s.hit)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stress: very long non-ASCII goal judges without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rc-test-'));
    try {
      const goal = ('배포 파이프라인의 스키마 마이그레이션과 외부 계약 갱신 — ' + '한글토큰 '.repeat(2000)).slice(0, 12000);
      const out = runJSON(['research-check', '--goal', goal], tmp);
      expect(out.recommendation).toBe('full'); // contract + irreversible + no map ≥ 3 hits
      expect(out.hits).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('irreversibility vocabulary is detected in Korean and English', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rc-test-'));
    try {
      for (const goal of ['prepare the marketplace release checklist for the plugin', '대시보드 배포 절차를 정리한다 그리고 문서화한다']) {
        const out = runJSON(['research-check', '--goal', goal], tmp);
        const s3 = out.signals.find((s) => s.id === 'irreversible-surface');
        expect(s3.hit).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
