import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI = join(import.meta.dirname, '..', 'x-plan', 'lib', 'x-plan-cli.mjs');
const run = (args, stdin, env = {}, cwd = import.meta.dirname) => spawnSync('node', [CLI, ...args], { cwd, input: stdin, encoding: 'utf8', env: { ...process.env, ...env } });

describe('x-plan CLI', () => {
  test('shows a readable plan and persists a parseable artifact by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-'));
    try {
      const r = run(['- Add export\n- Add tests'], undefined, {}, dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('# Plan: Add export');
      expect(r.stdout).toContain('## Implementation plan');
      expect(r.stdout.trim().startsWith('{')).toBe(false);
      const names = readdirSync(join(dir, '.xm', 'plan'));
      expect(names).toHaveLength(1);
      const out = JSON.parse(readFileSync(join(dir, '.xm', 'plan', names[0]), 'utf8'));
      expect(out.requirements).toHaveLength(2);
      expect(out.executable).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('recommends Quick only for a bounded local change and never auto-selects Ultra', () => {
    const quick = run(['--recommend', '--json', 'Update test/x-plan-cli.test.mjs to cover the local mode selector without changing public contracts']);
    expect(quick.status).toBe(0);
    expect(JSON.parse(quick.stdout)).toMatchObject({ action: 'select-mode', mode: 'quick', source: 'auto', confirmation_required: false });

    const risky = run(['--recommend', '--json', 'Migrate the public API schema and deploy the breaking change']);
    expect(risky.status).toBe(0);
    expect(JSON.parse(risky.stdout)).toMatchObject({ mode: 'standard', confidence: 'high', confirmation_required: false });

    const ambiguous = run(['--recommend', '--json', 'Improve it']);
    expect(JSON.parse(ambiguous.stdout)).toMatchObject({ mode: 'standard', confidence: 'low', confirmation_required: true });
  });

  test('explicit mode and exact models override recommendations', () => {
    const standard = run(['--recommend', '--json', '--mode', 'standard', 'Update docs/README.md locally']);
    expect(JSON.parse(standard.stdout)).toMatchObject({ mode: 'standard', source: 'explicit' });
    const ultra = run(['--recommend', '--json', '--models', 'model-a,model-b', 'Update docs/README.md locally']);
    expect(JSON.parse(ultra.stdout)).toMatchObject({ mode: 'ultra', source: 'explicit_models' });
  });

  test('recommend resumes a persisted session mode without another selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-recommend-session-'));
    try {
      const session = join(dir, '.xm', 'plan', 'existing');
      mkdirSync(session, { recursive: true });
      writeFileSync(join(session, 'manifest.json'), JSON.stringify({ mode: 'standard' }));
      const resumed = run(['--recommend', '--session', 'existing', '--json', 'Improve it'], undefined, {}, dir);
      expect(resumed.status).toBe(0);
      expect(JSON.parse(resumed.stdout)).toMatchObject({ mode: 'standard', source: 'session', confirmation_required: false });
      const missing = run(['--recommend', '--session', '../escape', '--json', 'Improve it'], undefined, {}, dir);
      expect(missing.status).toBe(2);
      expect(JSON.parse(missing.stdout).errors[0].message).toContain('plan session must stay under .xm/plan');
      const explicit = run(['--recommend', '--mode', 'quick', '--session', '../escape', '--json', 'Improve it'], undefined, {}, dir);
      expect(explicit.status).toBe(0);
      expect(JSON.parse(explicit.stdout)).toMatchObject({ mode: 'quick', source: 'explicit' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('recommend rejects validate and persist machine-operation combinations', () => {
    for (const operation of ['--validate', '--persist']) {
      const result = run(['--recommend', operation, '--json', '{"schema_version":1}']);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).errors[0].message).toContain('--recommend cannot be combined');
    }
  });

  test('accepts stdin and file inputs', () => {
    const stdin = run(['--json', '--no-save'], '- One\n- Two');
    expect(JSON.parse(stdin.stdout).provenance.source).toBe('stdin');
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-'));
    try { const file = join(dir, 'req.txt'); writeFileSync(file, '- File req'); const r = run(['--file', file, '--json', '--pretty', '--no-save']); expect(JSON.parse(r.stdout).provenance.source).toBe('file'); expect(r.stdout.split('\n').length).toBeGreaterThan(2); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('validate mode uses exit 2 for JSON parse and 1 for schema failure', () => {
    expect(run(['--validate'], '{').status).toBe(2);
    const r = run(['--validate'], '{}'); expect(r.status).toBe(1); expect(r.stdout).toContain('[plan.missing_field]');
  });
  test('rejects conflicting output flags as JSON', () => {
    const r = run(['--pretty', '--compact', 'x']); expect(r.status).toBe(2); expect(r.stderr).toContain('--pretty and --compact conflict');
  });
  test('keeps machine-readable CLI errors behind --json', () => {
    const r = run(['--json', '--file']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).errors[0].code).toBe('cli.usage');
  });
  test('ultra validates distinct slots before invoking providers', () => {
    const one = run(['--mode', 'ultra', '--models', 'one', 'x']); expect(one.status).toBe(2); expect(one.stderr).toContain('at least 2 distinct');
    const duplicate = run(['--mode', 'ultra', '--models', 'one,one', 'x']); expect(duplicate.status).toBe(2);
  });
  test('ultra runs offline candidates and emits synthesized provenance', () => {
    const stub = join(import.meta.dirname, 'fixtures', 'x-plan-panel-stub.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-ultra-'));
    const session = join(dir, '.xm', 'plan', 'interview');
    const evidence = join(dir, 'evidence.json');
    const questions = join(dir, 'questions.json');
    const seed = run(['--json', '--no-save', 'Build export']);
    writeFileSync(evidence, JSON.stringify({ schema_version: 1, items: [{ kind: 'path', value: 'src/export.mjs', verified: true }] }));
    writeFileSync(questions, JSON.stringify({ schema_version: 1, items: [] }));
    try {
      const initialized = run(['--persist', '--mode', 'standard', '--output', session, '--evidence', evidence, '--questions', questions], seed.stdout, {}, dir);
      expect(initialized.status).toBe(0);
      const r = run(['--mode', 'ultra', '--models', 'model-a,model-critic', '--session', 'interview', '--evidence', evidence, '--questions', questions, '--json', 'Build export'], undefined, { X_PLAN_PANEL_CMD: stub }, dir);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.provenance.mode).toBe('ultra');
      expect(out.provenance.candidates).toHaveLength(2);
      expect(out.disagreements.some((d) => d.topic === 'decision.selected')).toBe(true);
      expect(readdirSync(join(session, 'candidates'))).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('ultra rejects missing Standard interview context before providers run', () => {
    const r = run(['--mode', 'ultra', '--models', 'model-a,model-b', 'Build export'], undefined, { X_PLAN_PANEL_CMD: '/missing/provider' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Standard interview session');
  });
  test('persists an existing PlanEnvelope with --persist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-persist-'));
    const input = run(['--json', '--no-save', 'Build export']);
    try {
      const r = run(['--persist'], input.stdout, {}, dir);
      expect(r.status).toBe(0);
      expect(existsSync(join(dir, '.xm', 'plan'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('standard persists a resumable interview session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-standard-'));
    const envelope = run(['--json', '--no-save', 'Build export']);
    const evidence = join(dir, 'evidence.json');
    const questions = join(dir, 'questions.json');
    const critique = join(dir, 'critique.json');
    writeFileSync(evidence, JSON.stringify({ schema_version: 1, items: [{ kind: 'path', value: 'src/export.mjs', verified: true }] }));
    writeFileSync(questions, JSON.stringify({ schema_version: 1, items: [{ id: 'Q1', text: 'Format?', kind: 'user_owned', status: 'open', answer: null }] }));
    writeFileSync(critique, JSON.stringify({ schema_version: 1, status: 'not_recorded', findings: [] }));
    try {
      const r = run(['--persist', '--mode', 'standard', '--evidence', evidence, '--questions', questions, '--critique', critique], envelope.stdout, {}, dir);
      expect(r.status).toBe(0);
      const id = readdirSync(join(dir, '.xm', 'plan'))[0];
      const session = join(dir, '.xm', 'plan', id);
      expect(readdirSync(session).sort()).toEqual(['critique.json', 'envelope.json', 'evidence.json', 'manifest.json', 'plan.md', 'questions.json']);
      expect(JSON.parse(readFileSync(join(session, 'manifest.json'), 'utf8')).phase).toBe('clarify');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('standard generation cannot bypass the interview contract', () => {
    const r = run(['--mode', 'standard', 'Build export']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('requires an interviewed PlanEnvelope');
  });
  test('standard refuses executable plans without evidence and passing critique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-ready-'));
    const plan = {
      schema_version: 1, status: 'complete', executable: true, goal: 'Export',
      requirements: [{ id: 'R1', text: 'Export', priority: 'must' }], assumptions: [],
      decision: { selected: 'Implement', alternatives: [] },
      tasks: [{ id: 'T1', title: 'Implement export', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/export.mjs'], done_criteria: ['Works'] }],
      steps: [['T1']], validation: { commands: ['bun test'], requirement_refs: [] }, disagreements: [], unresolved_questions: [], provenance: {},
    };
    try {
      const r = run(['--persist', '--mode', 'standard'], JSON.stringify(plan), {}, dir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('repository evidence is required');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('standard resumes the same session as questions are answered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-resume-'));
    const input = run(['--json', '--no-save', 'Build export']);
    const evidence = join(dir, 'evidence.json');
    const questions = join(dir, 'questions.json');
    const critique = join(dir, 'critique.json');
    writeFileSync(evidence, JSON.stringify({ schema_version: 1, items: [{ kind: 'path', value: 'src/export.mjs', verified: true }] }));
    writeFileSync(questions, JSON.stringify({ schema_version: 1, items: [] }));
    writeFileSync(critique, JSON.stringify({ schema_version: 1, status: 'not_recorded', findings: [] }));
    try {
      const first = run(['--persist', '--mode', 'standard', '--evidence', evidence, '--questions', questions, '--critique', critique], input.stdout, {}, dir);
      expect(first.status).toBe(0);
      const id = readdirSync(join(dir, '.xm', 'plan'))[0];
      const second = run(['--persist', '--mode', 'standard', '--session', id, '--evidence', evidence, '--questions', questions, '--critique', critique], input.stdout, {}, dir);
      expect(second.status).toBe(0);
      expect(readdirSync(join(dir, '.xm', 'plan'))).toEqual([id]);
      expect(JSON.parse(readFileSync(join(dir, '.xm', 'plan', id, 'manifest.json'), 'utf8')).phase).toBe('clarify');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('standard limits an interview round to three classified questions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-questions-'));
    const input = run(['--json', '--no-save', 'Build export']);
    const questions = join(dir, 'questions.json');
    writeFileSync(questions, JSON.stringify({ schema_version: 1, items: Array.from({ length: 4 }, (_, index) => ({ id: 'Q' + index, text: 'Question', kind: 'user_owned', status: 'open', answer: null })) }));
    try {
      const r = run(['--persist', '--mode', 'standard', '--questions', questions], input.stdout, {}, dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('at most 3 planning questions');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('standard finalizes an executable plan only with evidence, answers, and passing critique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-final-'));
    const evidence = join(dir, 'evidence.json');
    const questions = join(dir, 'questions.json');
    const critique = join(dir, 'critique.json');
    const plan = {
      schema_version: 1, status: 'complete', executable: true, goal: 'Export',
      requirements: [{ id: 'R1', text: 'Export', priority: 'must' }], assumptions: [],
      decision: { selected: 'Implement', alternatives: [] },
      tasks: [{ id: 'T1', title: 'Implement export', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/export.mjs'], done_criteria: ['Works'] }],
      steps: [['T1']], validation: { commands: ['bun test'], requirement_refs: [] }, disagreements: [], unresolved_questions: [], provenance: {},
    };
    writeFileSync(evidence, JSON.stringify({ schema_version: 1, items: [{ kind: 'path', value: 'src/export.mjs', verified: true }] }));
    writeFileSync(questions, JSON.stringify({ schema_version: 1, items: [{ id: 'Q1', text: 'Format?', kind: 'user_owned', status: 'answered', answer: 'JSON' }] }));
    writeFileSync(critique, JSON.stringify({ schema_version: 1, status: 'passed', findings: [] }));
    try {
      const r = run(['--persist', '--mode', 'standard', '--evidence', evidence, '--questions', questions, '--critique', critique], JSON.stringify(plan), {}, dir);
      expect(r.status).toBe(0);
      const id = readdirSync(join(dir, '.xm', 'plan'))[0];
      expect(JSON.parse(readFileSync(join(dir, '.xm', 'plan', id, 'manifest.json'), 'utf8')).phase).toBe('finalize');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
