/**
 * dispatch — lightweight tracked execution (R4).
 * Contract under test: works WITHOUT a PRD (loud exemption notice), records a
 * full metric lineage on completion, refuses empty instructions, never
 * duplicates the auto-created project, and nudges toward a PRD once dispatch
 * tasks accumulate.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function run(args, cwd) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', cwd });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

function dispatchJSON(tmp, extra = []) {
  const r = run(['dispatch', 'README의 오탈자 3곳을 수정한다', ...extra, '--json'], tmp);
  const raw = r.stdout;
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

describe('dispatch — lightweight tracked execution', () => {
  test('runs without a PRD, emits a run-shaped entry, and records a metric on completion', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-dispatch-'));
    try {
      const out = dispatchJSON(tmp);
      expect(out.mode).toBe('dispatch');
      expect(out.prd_exempt).toBe(true);
      expect(out.notice.join(' ')).toContain('PRD/phase 게이트 미적용');
      expect(out.task.task_id).toBe('t1');
      expect(out.task.prompt).toContain('## Definition of Done');
      expect(out.task.on_complete).toContain('tasks update t1');

      const done = run(['tasks', 'update', 't1', '--status', 'completed', '--no-commit'], tmp);
      expect(done.stdout).toContain('completed');
      const metrics = readFileSync(join(tmp, '.xm', 'build', 'metrics', 'sessions.jsonl'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
      const m = metrics.reverse().find((x) => x.type === 'task_complete');
      expect(m).toBeTruthy();
      expect(m.project).toBe('dispatch');
      expect(m.correlation_id).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refuses an empty instruction', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-dispatch-'));
    try {
      const r = run(['dispatch'], tmp);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr + r.stdout).toContain('instruction');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('second dispatch reuses the project (no duplicates) and nudges toward a PRD', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-dispatch-'));
    try {
      dispatchJSON(tmp);
      const out2 = dispatchJSON(tmp);
      expect(out2.task.task_id).toBe('t2');
      expect(out2.notice.join(' ')).toContain('PRD로 승격');
      const projects = readdirSync(join(tmp, '.xm', 'build', 'projects'));
      expect(projects.filter((p) => p.startsWith('dispatch')).length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--model pin overrides routing in the emitted entry and persisted task', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-dispatch-'));
    try {
      const out = dispatchJSON(tmp, ['--model', 'haiku']);
      expect(out.task.model).toBe('haiku');
      const tasks = JSON.parse(readFileSync(join(tmp, '.xm', 'build', 'projects', 'dispatch', 'phases', '02-plan', 'tasks.json'), 'utf8'));
      expect(tasks.tasks[0]._assigned_model).toBe('haiku');
      expect(tasks.tasks[0].status).toBe('running');
      expect(tasks.tasks[0].started_at).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
