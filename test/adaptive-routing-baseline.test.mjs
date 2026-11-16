/**
 * `route start` runs each gate once before the change, so the receipt can say
 * which gates already passed and therefore did not observe the change.
 * The result is reported, never used to fail a run: a refactor's gates pass
 * both times, and a test added by the change cannot fail before it exists.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'xm-adaptive-baseline-'));
process.env.X_BUILD_ROOT = root;

beforeEach(async () => {
  const { adaptiveRoutingPath } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
  rmSync(adaptiveRoutingPath(), { force: true });
});

afterAll(() => {
  delete process.env.X_BUILD_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function fixtureRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'xm-route-baseline-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'fixture']);
  return cwd;
}

const eligible = { task_class: 'bounded-transform', scope: 'bounded', independent: true, file_count: 2, risk: 'low', failure_modes: 2, gates: ['test', 'boundary'] };
// `test` fails until the change lands; `boundary` passes before and after.
const GATES = ['test=grep -q "value = 2" src/value.mjs', 'boundary=test -s src/value.mjs'];
const byGate = (rows) => Object.fromEntries(rows.map((row) => [row.gate, row]));
const leaseFile = (id) => join(root, 'adaptive-runs', `${id}.lease.json`);

async function started(cwd, gateCommands = GATES, extra = {}) {
  const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
  const decision = module.decideAdaptiveRoute(eligible);
  module.recordAdaptiveDecision(decision);
  const lease = module.startAdaptiveRun({ decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'], gate_commands: gateCommands, now_ms: 1000, ...extra });
  return { module, decision, lease };
}

describe('route start baseline gate run', () => {
  test('records pass or fail per gate, without the command or its output', async () => {
    const cwd = fixtureRepo();
    try {
      const { lease } = await started(cwd);
      expect(byGate(lease.baseline_gates)).toEqual({ test: { gate: 'test', passed: false }, boundary: { gate: 'boundary', passed: true } });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('the receipt names the gates that passed before the change and still passes', async () => {
    const cwd = fixtureRepo();
    try {
      const { module, decision } = await started(cwd);
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1100 });
      expect(receipt.passed).toBe(true);
      expect(byGate(receipt.gates).test.passed_at_baseline).toBe(false);
      expect(byGate(receipt.gates).boundary.passed_at_baseline).toBe(true);
      expect(receipt.gates_passing_before_change).toEqual(['boundary']);
      const finished = module.finishAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1200 });
      expect(finished.receipt.gates_passing_before_change).toEqual(['boundary']);
      expect(finished.outcome.outcome).toBe('accepted');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a gate that passed before the change but fails after it is not listed', async () => {
    const cwd = fixtureRepo();
    try {
      const { module, decision } = await started(cwd, ['test=grep -q "value = 1" src/value.mjs', 'boundary=test -s src/value.mjs']);
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1100 });
      expect(receipt.passed).toBe(false);
      expect(receipt.gates_passing_before_change).toEqual(['boundary']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('the fallback reuses the stored baseline results instead of running the gates again', async () => {
    const cwd = fixtureRepo();
    const counter = join(root, 'baseline-runs.log');
    rmSync(counter, { force: true });
    try {
      const gates = [`test=echo run >> ${counter}; test -f src/ok.marker`, 'boundary=test -s src/value.mjs'];
      const { module, decision, lease } = await started(cwd, gates);
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1100 }).passed).toBe(false);
      git(cwd, ['checkout', '--', 'src/value.mjs']);
      const runsBeforeFallback = readFileSync(counter, 'utf8').trim().split('\n').length;
      const fallback = module.startAdaptiveRun({ decision_id: decision.decision_id, cwd, fallback: true, now_ms: 1200 });
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(runsBeforeFallback);
      expect(fallback.baseline_gates).toEqual(lease.baseline_gates);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a lease written before baseline runs existed verifies with unknown baseline results', async () => {
    const cwd = fixtureRepo();
    try {
      const { module, decision } = await started(cwd);
      const stored = JSON.parse(readFileSync(leaseFile(decision.decision_id), 'utf8'));
      delete stored.baseline_gates;
      writeFileSync(leaseFile(decision.decision_id), JSON.stringify(stored));
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1100 });
      expect(receipt.passed).toBe(true);
      expect(receipt.gates.map((gate) => gate.passed_at_baseline)).toEqual([null, null]);
      expect(receipt.gates_passing_before_change).toEqual([]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('the run duration starts after the baseline gates finish', async () => {
    const cwd = fixtureRepo();
    try {
      const before = Date.now();
      const { lease } = await started(cwd, ['test=sleep 0.3', 'boundary=true'], { now_ms: undefined });
      expect(Date.parse(lease.started_at) - before).toBeGreaterThanOrEqual(300);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
