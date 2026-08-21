import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI = join(import.meta.dirname, '..', 'x-plan', 'lib', 'x-plan-cli.mjs');
const run = (args, stdin, env = {}) => spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8', env: { ...process.env, ...env } });

describe('x-plan CLI', () => {
  test('accepts literal requirements and emits one compact JSON object', () => {
    const r = run(['- Add export\n- Add tests']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.requirements).toHaveLength(2);
    expect(out.executable).toBe(false);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });
  test('accepts stdin and file inputs', () => {
    const stdin = run([], '- One\n- Two');
    expect(JSON.parse(stdin.stdout).provenance.source).toBe('stdin');
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-'));
    try { const file = join(dir, 'req.txt'); writeFileSync(file, '- File req'); const r = run(['--file', file, '--pretty']); expect(JSON.parse(r.stdout).provenance.source).toBe('file'); expect(r.stdout.split('\n').length).toBeGreaterThan(2); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('validate mode uses exit 2 for JSON parse and 1 for schema failure', () => {
    expect(run(['--validate'], '{').status).toBe(2);
    const r = run(['--validate'], '{}'); expect(r.status).toBe(1); expect(JSON.parse(r.stdout).errors.some((e) => e.code === 'plan.missing_field')).toBe(true);
  });
  test('rejects conflicting output flags as JSON', () => {
    const r = run(['--pretty', '--compact', 'x']); expect(r.status).toBe(2); expect(JSON.parse(r.stdout).errors[0].code).toBe('cli.usage');
  });
  test('ultra validates distinct slots before invoking providers', () => {
    const one = run(['--mode', 'ultra', '--models', 'one', 'x']); expect(one.status).toBe(2); expect(JSON.parse(one.stdout).errors[0].code).toBe('cli.models');
    const duplicate = run(['--mode', 'ultra', '--models', 'one,one', 'x']); expect(duplicate.status).toBe(2);
  });
  test('ultra runs offline candidates and emits synthesized provenance', () => {
    const stub = join(import.meta.dirname, 'fixtures', 'x-plan-panel-stub.mjs');
    const r = run(['--mode', 'ultra', '--models', 'model-a,model-critic', 'Build export'], undefined, { X_PLAN_PANEL_CMD: stub });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.provenance.mode).toBe('ultra');
    expect(out.candidate_provenance).toHaveLength(2);
    expect(out.disagreements.some((d) => d.topic === 'decision.selected')).toBe(true);
  });
});
