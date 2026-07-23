/**
 * cost-engine.mjs unit tests
 * Covers: override priority chain, spinlock, budget rolling window,
 *         cold-start fallback, forecast actuals.
 *
 * Design note: ROOT_CE in cost-engine is evaluated once at module load time
 * from process.env.X_BUILD_ROOT. Static ESM imports are hoisted and evaluated
 * before any top-level statements, so we MUST use dynamic import() after
 * setting X_BUILD_ROOT to control the root path.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync,
  existsSync, readFileSync, utimesSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createFakeLLM } from './fixtures/fake-llm.mjs';

// ── One shared temp root — created and injected before dynamic imports ──────

const ORIG_X_BUILD_ROOT = process.env.X_BUILD_ROOT;
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'xb-ce-'));
process.env.X_BUILD_ROOT = TEST_ROOT;

// Dynamic imports so ROOT_CE sees TEST_ROOT
const ce = await import('../x-build/lib/x-build/cost-engine.mjs');
const cl = await import('../x-build/lib/x-build/config-loader.mjs');

afterAll(() => {
  if (ORIG_X_BUILD_ROOT !== undefined) {
    process.env.X_BUILD_ROOT = ORIG_X_BUILD_ROOT;
  } else {
    delete process.env.X_BUILD_ROOT;
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── Derived path helpers (delegated to module so we never hardcode them) ─────

function metricsFile()      { return ce.metricsPath(); }
function metricsDir()       { return dirname(ce.metricsPath()); }
function tokenActualsPath() { return join(metricsDir(), 'token-actuals.json'); }
function configPath()       { return join(TEST_ROOT, '..', 'config.json'); }

// ── Test helpers ──────────────────────────────────────────────────────────────

function writeConfig(cfg) {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg), 'utf8');
}

function clearConfig() {
  try { rmSync(configPath()); } catch { /* ok if missing */ }
}

function appendLines(...objects) {
  const p = metricsFile();
  mkdirSync(metricsDir(), { recursive: true });
  for (const obj of objects) {
    writeFileSync(p, JSON.stringify(obj) + '\n', { flag: 'a', encoding: 'utf8' });
  }
}

function clearMetrics() {
  try { rmSync(metricsFile()); }             catch { /* ok */ }
  try { rmSync(metricsFile() + '.lock', { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(ce.spendCachePath()); }       catch { /* ok */ }
  try { rmSync(tokenActualsPath()); }        catch { /* ok */ }
}

// ── 1. Override priority chain (getModelForRole) ──────────────────────────────

describe('ROI — Score/$ with L9 calibration guards (빅뱃1)', () => {
  const scored = (model, cost, q, n) => Array.from({ length: n }, () => ({ type: 'task_complete', model, role: 'executor', cost_source: 'actual', cost_usd: cost, quality_score: q, quality_scored: true }));
  const est = (model, n) => Array.from({ length: n }, () => ({ type: 'task_complete', model, role: 'executor', cost_source: 'estimated', cost_usd: 0, quality_score: 1, quality_scored: false }));

  test('a group calibrates only with ≥ROI_MIN_SAMPLES actual+scored completions', () => {
    const [g] = ce.aggregateRoi(scored('haiku', 0.01, 0.9, ce.ROI_MIN_SAMPLES), 'model');
    expect(g.calibrated).toBe(true);
    expect(g.score_per_usd).toBeCloseTo(0.9 / 0.01, 3);
    const [thin] = ce.aggregateRoi(scored('haiku', 0.01, 0.9, ce.ROI_MIN_SAMPLES - 1), 'model');
    expect(thin.calibrated).toBe(false);
    expect(thin.score_per_usd).toBeNull(); // no Score/$ without calibration
  });

  test('estimated cost / unscored quality never counts as signal', () => {
    const [g] = ce.aggregateRoi(est('sonnet', 20), 'model');
    expect(g.tasks).toBe(20);
    expect(g.calibrated_samples).toBe(0); // 20 tasks, 0 signal
    expect(g.calibrated).toBe(false);
    expect(g.score_per_usd).toBeNull();
  });

  test('suggestion fires only between calibrated groups with a real gap', () => {
    const rows = [...scored('haiku', 0.01, 0.9, 6), ...scored('opus', 0.10, 0.95, 6), ...est('sonnet', 6)];
    const stats = ce.aggregateRoi(rows, 'model');
    const sug = ce.roiSuggestion(stats);
    expect(sug.best).toBe('haiku');   // cheap + comparable quality wins
    expect(sug.worst).toBe('opus');
    expect(sug.ratio).toBeGreaterThan(1.3);
    // sonnet (estimate-only) is excluded from the recommendation entirely
    expect(stats.find(s => s.key === 'sonnet').calibrated).toBe(false);
  });

  test('no suggestion when calibrated groups are within the gap threshold', () => {
    const rows = [...scored('haiku', 0.01, 0.90, 6), ...scored('sonnet', 0.011, 0.90, 6)];
    expect(ce.roiSuggestion(ce.aggregateRoi(rows, 'model'))).toBeNull();
  });

  test('no suggestion from fewer than 2 calibrated groups (all estimate-only)', () => {
    expect(ce.roiSuggestion(ce.aggregateRoi(est('sonnet', 30), 'model'))).toBeNull();
  });
});

describe('mergeSharedTiers — global keys survive a local config (빌드5)', () => {
  test('keeps global keys absent from local — the dropped-override bug', () => {
    // Pre-fix, config-loader was first-match: a local .xm/config.json (even one
    // holding only mode/pipelines) made getModelForRole/checkBudget read a config
    // with NO model_overrides and NO budget. The merge restores them.
    const global = { model_overrides: { architect: 'opus' }, budget: { max_usd: 5 } };
    const local = { mode: 'normal', pipelines: { release: ['x-review'] } };
    const merged = cl.mergeSharedTiers(global, local);
    expect(merged.model_overrides).toEqual({ architect: 'opus' });
    expect(merged.budget).toEqual({ max_usd: 5 });
    expect(merged.mode).toBe('normal');
    expect(merged.pipelines).toEqual({ release: ['x-review'] });
  });
  test('local wins on conflicting top-level keys (shallow merge contract)', () => {
    const merged = cl.mergeSharedTiers(
      { mode: 'developer', model_overrides: { a: 'opus' } },
      { mode: 'normal' },
    );
    expect(merged.mode).toBe('normal');            // local wins
    expect(merged.model_overrides).toEqual({ a: 'opus' }); // shallow: local lacks it → global's survives whole
  });
  test('null/undefined tiers are safe', () => {
    expect(cl.mergeSharedTiers(null, { a: 1 })).toEqual({ a: 1 });
    expect(cl.mergeSharedTiers({ a: 1 }, null)).toEqual({ a: 1 });
    expect(cl.mergeSharedTiers(null, null)).toEqual({});
  });
});

describe('getModelForRole — override priority chain', () => {
  afterEach(() => { clearConfig(); clearMetrics(); });

  test('model_overrides always wins over profile default', () => {
    const result = ce.getModelForRole('executor', 'medium', {
      model_overrides: { executor: 'opus' },
      model_profile: 'economy',
    });
    expect(result).toBe('opus');
  });

  test('no overrides falls back to static profile model', () => {
    const result = ce.getModelForRole('executor', 'medium', {
      model_profile: 'default',
    });
    expect(result).toBe('sonnet');
  });

  test('unknown role falls back to executor model from profile', () => {
    const result = ce.getModelForRole('nonexistent-role', 'medium', {
      model_profile: 'default',
    });
    // default.executor = sonnet (measured sweet spot); unknown role uses that fallback
    expect(result).toBe('sonnet');
  });

  test('large task with haiku-mapped role emits a console warning', () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      // economy profile maps explorer -> haiku (writer too)
      ce.getModelForRole('explorer', 'large', { model_profile: 'economy' });
      expect(warnings.some(w => w.includes('haiku') && w.includes('large'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test('economy profile keeps architect on sonnet (cost-conscious)', () => {
    expect(ce.getModelForRole('architect', 'medium', { model_profile: 'economy' })).toBe('sonnet');
  });

  test('max profile upgrades executor to opus', () => {
    expect(ce.getModelForRole('executor', 'medium', { model_profile: 'max' })).toBe('opus');
  });

  test('legacy "balanced" is accepted and resolves to default', () => {
    expect(ce.getModelForRole('executor', 'medium', { model_profile: 'balanced' })).toBe('sonnet');
  });

  test('legacy "performance" is accepted and resolves to max', () => {
    expect(ce.getModelForRole('designer', 'medium', { model_profile: 'performance' })).toBe('opus');
  });

  test('model_overrides wins even against legacy profile names', () => {
    const result = ce.getModelForRole('architect', 'medium', {
      model_overrides: { architect: 'haiku' },
      model_profile: 'max',
    });
    expect(result).toBe('haiku');
  });
});

// ── 1b. Role registry — new roles, aliases, phase groups ──────────────────────

describe('getModelForRole — extended roles and aliases', () => {
  function captureWarnings(fn) {
    const warnings = [];
    const c = console.warn, e = console.error;
    console.warn = (...a) => warnings.push(a.join(' '));
    console.error = (...a) => warnings.push(a.join(' '));
    try { fn(); } finally { console.warn = c; console.error = e; }
    return warnings;
  }

  test('deep-executor resolves per profile without unknown-role warning', () => {
    const warnings = captureWarnings(() => {
      expect(ce.getModelForRole('deep-executor', 'large', { model_profile: 'economy' })).toBe('sonnet');
      expect(ce.getModelForRole('deep-executor', 'large', { model_profile: 'default' })).toBe('inherit');
      expect(ce.getModelForRole('deep-executor', 'large', { model_profile: 'max' })).toBe('inherit');
    });
    expect(warnings.some(w => w.includes('Unknown role'))).toBe(false);
  });

  test('planner/critic/researcher/verifier resolve without unknown-role warning', () => {
    const warnings = captureWarnings(() => {
      expect(ce.getModelForRole('planner', 'medium', { model_profile: 'default' })).toBe('inherit');
      expect(ce.getModelForRole('critic', 'medium', { model_profile: 'default' })).toBe('inherit');
      expect(ce.getModelForRole('verifier', 'medium', { model_profile: 'default' })).toBe('sonnet');
      expect(ce.getModelForRole('researcher', 'medium', { model_profile: 'economy' })).toBe('haiku');
    });
    expect(warnings.some(w => w.includes('Unknown role'))).toBe(false);
  });

  test('alias roles resolve to their canonical role model', () => {
    expect(ce.resolveRole('test-engineer')).toBe('verifier');
    expect(ce.getModelForRole('test-engineer', 'medium', { model_profile: 'max' })).toBe('opus'); // max.verifier
    expect(ce.getModelForRole('documenter', 'small', { model_profile: 'default' })).toBe('haiku'); // default.writer
  });

  test('override on the canonical role also applies to its alias', () => {
    const result = ce.getModelForRole('test-engineer', 'medium', {
      model_overrides: { verifier: 'opus' },
      model_profile: 'economy',
    });
    expect(result).toBe('opus');
  });

  test('every PHASE_ROLE_GROUPS role exists in every profile', () => {
    const allGroupRoles = Object.values(ce.PHASE_ROLE_GROUPS).flat();
    for (const profile of Object.keys(ce.MODEL_PROFILES)) {
      for (const role of allGroupRoles) {
        expect(ce.MODEL_PROFILES[profile][role]).toBeDefined();
      }
    }
  });

  test('truly unknown role still warns and falls back to executor model', () => {
    const warnings = captureWarnings(() => {
      expect(ce.getModelForRole('nonexistent-role', 'medium', { model_profile: 'default' })).toBe('sonnet');
    });
    expect(warnings.some(w => w.includes('Unknown role'))).toBe(true);
  });
});

// ── 2. Spinlock concurrency (appendMetric) ────────────────────────────────────

describe('appendCostEvent — payload and write lock', () => {
  beforeEach(() => { clearMetrics(); });
  afterEach(() => { clearMetrics(); });

  test('multiple sequential appendCostEvent calls produce valid JSONL', () => {
    const entries = [
      { type: 'task_complete', cost_usd: 0.01 },
      { type: 'task_complete', cost_usd: 0.02 },
      { type: 'task_complete', cost_usd: 0.03 },
    ];
    for (const e of entries) ce.appendCostEvent(e);

    expect(existsSync(metricsFile())).toBe(true);
    const lines = readFileSync(metricsFile(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0].cost_usd).toBe(0.01);
    expect(parsed[2].cost_usd).toBe(0.03);
  });

  test('20 rapid appendCostEvent calls each produce a valid JSON line', () => {
    for (let i = 0; i < 20; i++) {
      ce.appendCostEvent({ type: 'task_complete', cost_usd: i * 0.001 });
    }
    const lines = readFileSync(metricsFile(), 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(20);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('stale lock file (> 10s old) is cleaned up and write succeeds', () => {
    mkdirSync(metricsDir(), { recursive: true });
    const lockPath = metricsFile() + '.lock';
    mkdirSync(lockPath);
    // Backdate lock mtime to simulate stale lock
    const staleTimeSec = (Date.now() - 15_000) / 1000;
    try { utimesSync(lockPath, staleTimeSec, staleTimeSec); } catch { /* skip if unavailable */ }

    expect(() => ce.appendCostEvent({ type: 'task_complete', cost_usd: 0.05 })).not.toThrow();
    expect(existsSync(metricsFile())).toBe(true);
  });

  test('legacy stale regular-file lock is reclaimed during migration', () => {
    mkdirSync(metricsDir(), { recursive: true });
    const lockPath = metricsFile() + '.lock';
    writeFileSync(lockPath, '99999', 'utf8');
    const staleTimeSec = (Date.now() - 15_000) / 1000;
    utimesSync(lockPath, staleTimeSec, staleTimeSec);

    expect(() => ce.appendCostEvent({ type: 'task_complete', cost_usd: 0.05 })).not.toThrow();
    expect(existsSync(metricsFile())).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('lock file is released after a successful write', () => {
    ce.appendCostEvent({ type: 'task_complete', cost_usd: 0.01 });
    expect(existsSync(metricsFile() + '.lock')).toBe(false);
  });

  test('payloads over 4KB fail with a refs-out hint', () => {
    expect(() => ce.appendCostEvent({
      type: 'task_complete',
      detail: 'x'.repeat(ce.COST_EVENT_MAX_BYTES),
    })).toThrow(/4096 bytes.*refs-out/i);
    expect(existsSync(metricsFile())).toBe(false);
  });

  test('appendMetric remains a backward-compatible alias', () => {
    expect(ce.appendMetric).toBe(ce.appendCostEvent);
  });

  test('10 concurrent processes produce valid, complete JSONL', async () => {
    const moduleUrl = new URL('../x-build/lib/x-build/cost-engine.mjs', import.meta.url).href;
    const children = Array.from({ length: 10 }, (_, index) => new Promise((resolve, reject) => {
      const script = [
        `import { appendCostEvent } from ${JSON.stringify(moduleUrl)};`,
        `appendCostEvent({ type: 'task_complete', worker: ${index}, cost_usd: ${index} / 1000 });`,
      ].join('\n');
      const child = spawn('node', ['--input-type=module', '--eval', script], {
        env: { ...process.env, X_BUILD_ROOT: TEST_ROOT },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`append child ${index} exited ${code}: ${stderr}`));
      });
    }));

    await Promise.all(children);
    const lines = readFileSync(metricsFile(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(10);
    const events = lines.map(line => JSON.parse(line));
    expect(new Set(events.map(event => event.worker)).size).toBe(10);
    expect(new Set(events.map(event => event.event_id)).size).toBe(10);
  });
});

// ── 3. Budget rolling window (checkBudget) ────────────────────────────────────

describe('checkBudget — rolling window', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('window_hours filters out metrics older than the window', () => {
    const old    = new Date(Date.now() - 3 * 3_600_000).toISOString();  // 3h ago
    const recent = new Date(Date.now() -     30 * 60_000).toISOString(); // 30m ago
    appendLines(
      { type: 'task_complete', cost_usd: 0.90, timestamp: old },
      { type: 'task_complete', cost_usd: 0.05, timestamp: recent },
    );
    writeConfig({ budget: { max_usd: 0.50, window_hours: 1 } });

    const result = ce.checkBudget(0, null);
    expect(result.ok).toBe(true);
    expect(result.spent).toBeCloseTo(0.05, 5);
  });

  test('window_hours unset defaults to a 24h rolling window (docs contract)', () => {
    // Docs + config-schema promise a 24h default; unset must NOT silently
    // widen to full metrics lifetime (the pre-fix behavior).
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    appendLines(
      { type: 'task_complete', cost_usd: 0.40, timestamp: old },
      { type: 'task_complete', cost_usd: 0.40, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0, null);
    expect(result.ok).toBe(true); // 48h-old spend excluded by the default window
    expect(result.spent).toBeCloseTo(0.40, 5);
  });

  test('window_hours: 0 disables the window and scans the full metrics lifetime', () => {
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    appendLines(
      { type: 'task_complete', cost_usd: 0.40, timestamp: old },
      { type: 'task_complete', cost_usd: 0.40, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50, window_hours: 0 } });

    const result = ce.checkBudget(0, null);
    expect(result.ok).toBe(false);
    expect(result.level).toBe('exceeded');
  });

  test('negative window_hours falls back to the 24h default, never the lifetime scan', () => {
    // A sign typo (-24) is as invalid as NaN; it must not silently land in the
    // "explicit 0" branch and widen accounting to the full metrics lifetime.
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    appendLines(
      { type: 'task_complete', cost_usd: 0.40, timestamp: old },
      { type: 'task_complete', cost_usd: 0.05, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.30, window_hours: -24 } });

    const result = ce.checkBudget(0, null);
    expect(result.ok).toBe(true); // 24h fallback excludes the 48h-old spend
    expect(result.spent).toBeCloseTo(0.05, 5);
  });

  test('emergency reserve is release-only and has an exact hard boundary', () => {
    appendLines({ type: 'task_complete', cost_usd: 0.95, timestamp: new Date().toISOString() });
    writeConfig({ budget: { max_usd: 1, emergency_reserve_usd: 0.20 } });

    expect(ce.checkBudget(0.10, null)).toMatchObject({ ok: false, level: 'exceeded' });
    expect(ce.checkBudget(0.10, null, { release: true })).toMatchObject({
      ok: true,
      emergency_reserve_usd: 0.20,
      using_emergency_reserve: true,
    });
    // The reserve itself is an upper bound, not a second unlimited budget.
    expect(ce.checkBudget(0.26, null, { release: true })).toMatchObject({ ok: false, level: 'exceeded' });
  });

  test('downgradeBudgetModel follows only opus → sonnet → haiku', () => {
    expect(ce.downgradeBudgetModel('opus')).toBe('sonnet');
    expect(ce.downgradeBudgetModel('sonnet')).toBe('haiku');
    expect(ce.downgradeBudgetModel('haiku')).toBeNull();
    expect(ce.downgradeBudgetModel('inherit')).toBeNull();
  });

  test('per-project budget is enforced independently of global budget', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.08, project: 'alpha', timestamp: new Date().toISOString() },
      { type: 'task_complete', cost_usd: 0.01, project: 'beta',  timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 1.00, projects: { alpha: 0.05 } } });

    const result = ce.checkBudget(0, 'alpha');
    expect(result.ok).toBe(false);
    expect(result.level).toBe('exceeded');
    expect(result.project).toBe('alpha');
  });

  test('documented {max_usd} object shape enforces the per-project cap', () => {
    // Root CLAUDE.md + config wizard both produce { project: { max_usd: N } };
    // Number({...}) is NaN, which used to make this cap silently disappear.
    appendLines(
      { type: 'task_complete', cost_usd: 0.08, project: 'alpha', timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 1.00, projects: { alpha: { max_usd: 0.05 } } } });

    const result = ce.checkBudget(0, 'alpha');
    expect(result.ok).toBe(false);
    expect(result.level).toBe('exceeded');
    expect(result.project).toBe('alpha');
  });

  test('unparseable per-project value warns loudly and applies no cap', () => {
    const chunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (s) => { chunks.push(String(s)); return true; };
    try {
      appendLines(
        { type: 'task_complete', cost_usd: 0.08, project: 'alpha', timestamp: new Date().toISOString() },
      );
      writeConfig({ budget: { max_usd: 1.00, projects: { alpha: { usd: 'two' } } } });

      const result = ce.checkBudget(0, 'alpha');
      expect(result.ok).toBe(true); // the global budget still governs
      expect(result.project).toBeUndefined();

      const err = chunks.join('');
      expect(err).toContain('budget.projects["alpha"]'); // names the project
      expect(err).toContain('"usd":"two"');              // names the bad value
      expect(err).toContain('NOT applied');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('per-project cap applies even when no global budget.max_usd is set', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.08, project: 'alpha', timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { projects: { alpha: { max_usd: 0.05 } } } });

    const result = ce.checkBudget(0, 'alpha');
    expect(result.ok).toBe(false);
    expect(result.level).toBe('exceeded');
    expect(result.project).toBe('alpha');
  });

  test('backward-compatible call without project argument checks global budget only', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.10, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0);
    expect(result.ok).toBe(true);
    expect(result.spent).toBeCloseTo(0.10, 5);
  });

  test('no budget configured returns ok with null budget', () => {
    writeConfig({});
    const result = ce.checkBudget(0);
    expect(result.ok).toBe(true);
    expect(result.budget).toBeNull();
  });

  test('additional cost that pushes total over budget returns exceeded', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.45, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0.10);
    expect(result.ok).toBe(false);
    expect(result.level).toBe('exceeded');
  });

  test('spend above 80% of budget returns warning level', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.42, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('warning');
  });
});

// ── 4. Cold-start fallback ────────────────────────────────────────────────────

describe('cold-start fallback — empty or missing metrics', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('no metrics file — getModelForRole returns static profile model', () => {
    expect(ce.getModelForRole('executor', 'medium', { model_profile: 'default' })).toBe('sonnet');
  });

  test('no config overrides — static profile is used', () => {
    expect(ce.getModelForRole('executor', 'medium', { model_profile: 'economy' })).toBe('sonnet');
  });

  test('checkBudget with no metrics file returns ok with spent = 0', () => {
    writeConfig({ budget: { max_usd: 1.00 } });
    const result = ce.checkBudget(0);
    expect(result.ok).toBe(true);
    expect(result.spent).toBe(0);
  });
});

// ── 5. Forecast actuals (estimateTaskCost + loadTokenActuals) ─────────────────

describe('estimateTaskCost — forecast actuals', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('fewer than 10 samples — uses SIZE_TOKEN_ESTIMATES pricing not actuals', () => {
    mkdirSync(metricsDir(), { recursive: true });
    // sessions.jsonl older than token-actuals (fresh actuals but only 5 samples)
    writeFileSync(metricsFile(), '', 'utf8');
    const pastSec = (Date.now() - 5_000) / 1000;
    try { utimesSync(metricsFile(), pastSec, pastSec); } catch { /* ok */ }

    writeFileSync(tokenActualsPath(), JSON.stringify({
      updated_at: new Date().toISOString(),
      sample_counts: { small: 5, medium: 5, large: 5 },
      estimates: {
        small:  { avg_cost_usd: 999.99 },
        medium: { avg_cost_usd: 999.99 },
        large:  { avg_cost_usd: 999.99 },
      },
    }), 'utf8');

    const result = ce.estimateTaskCost({ name: 'setup', size: 'small' }, 'haiku');
    // sample_count 5 < 10 — must not use the 999.99 actuals
    expect(result.cost_usd).toBeLessThan(1.0);
  });

  test('10 or more samples — uses actuals cost and returns confidence=high', () => {
    mkdirSync(metricsDir(), { recursive: true });
    writeFileSync(metricsFile(), '', 'utf8');
    const pastSec = (Date.now() - 5_000) / 1000;
    try { utimesSync(metricsFile(), pastSec, pastSec); } catch { /* ok */ }

    const avgCost = 0.042;
    writeFileSync(tokenActualsPath(), JSON.stringify({
      updated_at: new Date().toISOString(),
      sample_counts: { small: 10, medium: 10, large: 10 },
      estimates: {
        small:  { avg_cost_usd: avgCost },
        medium: { avg_cost_usd: avgCost },
        large:  { avg_cost_usd: avgCost },
      },
    }), 'utf8');

    const result = ce.estimateTaskCost({ name: 'setup', size: 'small' }, 'sonnet');
    expect(result.confidence).toBe('high');
    expect(result.cost_usd).toBeCloseTo(avgCost, 5);
  });

  test('stale token-actuals (metrics newer) — loadTokenActuals returns null', () => {
    mkdirSync(metricsDir(), { recursive: true });
    // Write token-actuals first with an older mtime
    writeFileSync(tokenActualsPath(), JSON.stringify({
      updated_at: new Date(Date.now() - 10_000).toISOString(),
      sample_counts: { small: 20 },
      estimates: { small: { avg_cost_usd: 999.99 } },
    }), 'utf8');
    const staleActualsSec = (Date.now() - 5_000) / 1000;
    try { utimesSync(tokenActualsPath(), staleActualsSec, staleActualsSec); } catch { /* ok */ }

    // Write sessions.jsonl after so it has a newer mtime (makes actuals stale)
    writeFileSync(metricsFile(), '', 'utf8');

    expect(ce.loadTokenActuals()).toBeNull();
  });
});

// ── 6. cmdForecastUpdate ──────────────────────────────────────────────────────

describe('cmdForecastUpdate', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('cmdForecastUpdate creates token-actuals.json', () => {
    const ts = new Date().toISOString();
    appendLines(
      { type: 'task_complete', cost_usd: 0.10, size: 'small', timestamp: ts },
      { type: 'task_complete', cost_usd: 0.20, size: 'small', timestamp: ts },
    );
    ce.cmdForecastUpdate();
    const actualsPath = join(metricsDir(), 'token-actuals.json');
    expect(existsSync(actualsPath)).toBe(true);
    const data = JSON.parse(readFileSync(actualsPath, 'utf8'));
    expect(data.sample_counts.small).toBe(2);
    expect(data.estimates.small.avg_cost_usd).toBeCloseTo(0.15, 5);
  });
});

// ── 7. computeTokenActuals — direct unit tests ────────────────────────────────

describe('computeTokenActuals — averages from metrics', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('returns null when metrics file does not exist', () => {
    expect(ce.computeTokenActuals()).toBeNull();
  });

  test('known task_complete entries produce correct per-size averages', () => {
    const ts = new Date().toISOString();
    appendLines(
      { type: 'task_complete', cost_usd: 0.10, size: 'small',  timestamp: ts },
      { type: 'task_complete', cost_usd: 0.20, size: 'small',  timestamp: ts },
      { type: 'task_complete', cost_usd: 0.30, size: 'medium', timestamp: ts },
    );

    const result = ce.computeTokenActuals();
    expect(result).not.toBeNull();
    expect(result.estimates.small.avg_cost_usd).toBeCloseTo(0.15, 5);
    expect(result.estimates.medium.avg_cost_usd).toBeCloseTo(0.30, 5);
    expect(result.sample_counts.small).toBe(2);
    expect(result.sample_counts.medium).toBe(1);
  });

  test('empty metrics file returns result with zero sample_counts', () => {
    mkdirSync(metricsDir(), { recursive: true });
    writeFileSync(metricsFile(), '', 'utf8');

    const result = ce.computeTokenActuals();
    expect(result).not.toBeNull();
    expect(result.sample_counts.small).toBe(0);
    expect(result.sample_counts.medium).toBe(0);
    expect(result.sample_counts.large).toBe(0);
  });

  test('entries without size field are excluded from averages', () => {
    const ts = new Date().toISOString();
    appendLines(
      { type: 'task_complete', cost_usd: 0.50, timestamp: ts },           // no size
      { type: 'task_complete', cost_usd: 0.10, size: 'large', timestamp: ts },
    );
    const result = ce.computeTokenActuals();
    expect(result.sample_counts.large).toBe(1);
    expect(result.estimates.large.avg_cost_usd).toBeCloseTo(0.10, 5);
  });

  test('task_failed entries are excluded from averages', () => {
    const ts = new Date().toISOString();
    appendLines(
      { type: 'task_failed',   cost_usd: 0.99, size: 'small', timestamp: ts },
      { type: 'task_complete', cost_usd: 0.05, size: 'small', timestamp: ts },
    );
    const result = ce.computeTokenActuals();
    expect(result.sample_counts.small).toBe(1);
    expect(result.estimates.small.avg_cost_usd).toBeCloseTo(0.05, 5);
  });

  test('result includes updated_at timestamp string', () => {
    const ts = new Date().toISOString();
    appendLines({ type: 'task_complete', cost_usd: 0.05, size: 'small', timestamp: ts });
    const result = ce.computeTokenActuals();
    expect(typeof result.updated_at).toBe('string');
    expect(() => new Date(result.updated_at)).not.toThrow();
  });

  test('estimated samples (cost_source:estimated) are excluded — breaks circular loop', () => {
    const ts = new Date().toISOString();
    appendLines(
      { type: 'task_complete', cost_usd: 0.10, size: 'small', cost_source: 'estimated', timestamp: ts },
      { type: 'task_complete', cost_usd: 0.20, size: 'small', cost_source: 'actual',    timestamp: ts },
    );
    const result = ce.computeTokenActuals();
    // Only the measured ('actual') sample feeds actuals; the estimate is ignored,
    // so estimates can never recycle back as "actuals".
    expect(result.sample_counts.small).toBe(1);
    expect(result.estimates.small.avg_cost_usd).toBeCloseTo(0.20, 5);
  });

  test('legacy untagged samples remain counted (backward compatible)', () => {
    const ts = new Date().toISOString();
    appendLines({ type: 'task_complete', cost_usd: 0.30, size: 'medium', timestamp: ts });
    const result = ce.computeTokenActuals();
    expect(result.sample_counts.medium).toBe(1);
  });
});

// ── Cost prediction (t6) ────────────────────────────────────────────────────

describe('predictTaskCost — measured hierarchical lookup (t6)', () => {
  const actual = (cost_usd, overrides = {}) => ({
    type: 'task_complete', cost_source: 'actual', cost_usd,
    role: 'executor', strategy: null, size: 'medium',
    taskName: 'implement login endpoint', ...overrides,
  });

  test('uses an exact role+strategy+size tuple and interpolated IQR', () => {
    const result = ce.predictTaskCost({ description: 'Implement: login endpoint!', role: 'executor', size: 'medium' }, [
      actual(0.10, { taskName: 'implement auth endpoint' }),
      actual(0.20, { taskName: 'add login validation' }),
      actual(0.90, { taskName: 'wire session handling' }),
    ]);
    expect(result.source).toBe('exact');
    expect(result.sample_count).toBe(3);
    expect(result.p25_usd).toBeCloseTo(0.15, 8);
    expect(result.p50_usd).toBeCloseTo(0.20, 8);
    expect(result.p75_usd).toBeCloseTo(0.55, 8);
  });

  test('uses Jaccard candidates when an exact tuple is unavailable', () => {
    const result = ce.predictTaskCost({ description: 'implement secure login endpoint', role: 'executor', size: 'medium' }, [
      actual(0.10, { taskName: 'implement secure login feature', size: 'small' }),
      actual(0.20, { taskName: 'implement secure login feature', size: 'small' }),
      actual(0.30, { taskName: 'implement secure login feature', size: 'small' }),
      actual(9.99, { taskName: 'unrelated task', role: 'reviewer' }),
    ]);
    expect(result.source).toBe('jaccard');
    expect(result.sample_count).toBe(3);
    expect(result.p50_usd).toBeCloseTo(0.20, 8);
  });

  test('thin exact/Jaccard candidates fall back to global median', () => {
    const result = ce.predictTaskCost({ description: 'implement login endpoint', role: 'executor', size: 'medium' }, [
      actual(0.10), actual(0.20),
      actual(1.00, { taskName: 'different task', role: 'reviewer' }),
      actual(1.10, { taskName: 'different task', role: 'reviewer' }),
      actual(1.20, { taskName: 'different task', role: 'reviewer' }),
    ]);
    expect(result.source).toBe('global');
    expect(result.sample_count).toBe(5);
    expect(result.p50_usd).toBeCloseTo(1.00, 8);
  });

  test('keeps strategy medians separate before the all-history global fallback', () => {
    const result = ce.predictTaskCost({ description: 'new task', role: 'executor', strategy: 'review', size: 'medium' }, [
      actual(0.10, { strategy: 'review', size: 'small', taskName: 'other review' }),
      actual(0.20, { strategy: 'review', size: 'small', taskName: 'other review' }),
      actual(0.30, { strategy: 'review', size: 'small', taskName: 'other review' }),
      actual(1.00, { strategy: 'refine', taskName: 'other refine' }),
      actual(1.10, { strategy: 'refine', taskName: 'other refine' }),
      actual(1.20, { strategy: 'refine', taskName: 'other refine' }),
    ]);
    expect(result.source).toBe('strategy-global');
    expect(result.sample_count).toBe(3);
    expect(result.p50_usd).toBeCloseTo(0.20, 8);
  });

  test('excludes estimated events from the prediction population', () => {
    const result = ce.predictTaskCost({ description: 'implement login endpoint', role: 'executor', size: 'medium' }, [
      actual(0.10), actual(0.20), actual(0.30),
      { ...actual(99.99), cost_source: 'estimated' },
    ]);
    expect(result.source).toBe('exact');
    expect(result.sample_count).toBe(3);
    expect(result.p50_usd).toBeCloseTo(0.20, 8);
  });

  test('keeps untagged legacy actuals but excludes estimated and inherit rows', () => {
    const result = ce.predictTaskCost({ description: 'implement login endpoint', role: 'executor', size: 'medium' }, [
      actual(0.10),
      { ...actual(0.20), cost_source: undefined }, // schema-v1 measured completion
      actual(0.30),
      { ...actual(99.99), cost_source: 'estimated_inherit' },
      { ...actual(88.88), model: ce.INHERIT_MODEL },
    ]);
    expect(result.source).toBe('exact');
    expect(result.sample_count).toBe(3);
    expect(result.p50_usd).toBeCloseTo(0.20, 8);
  });

  test('fresh history uses a non-zero heuristic without inventing samples', () => {
    const result = ce.predictTaskCost({ description: 'fresh task', size: 'small' }, []);
    expect(result.source).toBe('heuristic');
    expect(result.sample_count).toBe(0);
    expect(result.p50_usd).toBeGreaterThan(0);
    expect(ce.formatCostPrediction(result)).toMatch(/^est\. \$\d+\.\d{2} \(p50, n=0, range \$\d+\.\d{2}–\$\d+\.\d{2}\)$/);
  });
});

// ── costFromTokens — measured cost ────────────────────────────────────────────

describe('costFromTokens — measured cost', () => {
  test('sonnet pricing: 1M in @$3 + 0.5M out @$15 = $10.50', () => {
    expect(ce.costFromTokens('sonnet', 1_000_000, 500_000)).toBeCloseTo(10.5, 6);
  });
  test('opus pricing: 100k in @$15 + 50k out @$75 = $5.25', () => {
    expect(ce.costFromTokens('opus', 100_000, 50_000)).toBeCloseTo(5.25, 6);
  });
  test('unknown model falls back to sonnet; negative tokens clamp to 0', () => {
    expect(ce.costFromTokens('zzz', 1_000_000, 0)).toBeCloseTo(3, 6);
    expect(ce.costFromTokens('sonnet', -5, -5)).toBe(0);
  });
});

// ── 12. checkBudget — 80% boundary precision ──────────────────────────────────

describe('checkBudget — 80% boundary precision', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('spend at exactly 80% of budget returns normal level (boundary is exclusive)', () => {
    // pct > 80 is the condition; exactly 80% does NOT trigger warning → normal
    appendLines(
      { type: 'task_complete', cost_usd: 0.40, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('normal');
  });

  test('spend just below 80% of budget returns normal level', () => {
    // 0.3999 / 0.50 = 79.98% → normal
    appendLines(
      { type: 'task_complete', cost_usd: 0.3999, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('normal');
  });

  test('spend just above 80% of budget returns warning level', () => {
    // 0.4001 / 0.50 = 80.02% → warning
    appendLines(
      { type: 'task_complete', cost_usd: 0.4001, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('warning');
  });

  test('additionalCost pushing total to exactly 80% returns normal (boundary is exclusive)', () => {
    // pct > 80 is the condition; exactly 80% does NOT trigger warning → normal
    appendLines(
      { type: 'task_complete', cost_usd: 0.30, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0.10);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('normal');
  });

  test('additionalCost pushing total just above 100% returns exceeded', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.49, timestamp: new Date().toISOString() },
    );
    writeConfig({ budget: { max_usd: 0.50 } });

    const result = ce.checkBudget(0.02);
    expect(result.ok).toBe(false);
    expect(result.level).toBe('exceeded');
  });
});

// ── 12b. checkBudget — explicit warn_at_usd (t11) ──────────────────────────

describe('checkBudget — explicit warn_at_usd thresholds', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('explicit global warning is exclusive at its exact USD boundary', () => {
    appendLines({ type: 'task_complete', cost_usd: 0.35, timestamp: new Date().toISOString() });
    writeConfig({ budget: { max_usd: 0.50, warn_at_usd: 0.35 } });
    expect(ce.checkBudget(0)).toMatchObject({ ok: true, level: 'normal', warn_at_usd: 0.35 });
    expect(ce.checkBudget(0.0001)).toMatchObject({ ok: true, level: 'warning', warn_at_usd: 0.35 });
  });

  test('invalid or missing warning threshold safely falls back to the legacy 80% threshold', () => {
    appendLines({ type: 'task_complete', cost_usd: 0.41, timestamp: new Date().toISOString() });
    writeConfig({ budget: { max_usd: 0.50, warn_at_usd: 0.50 } }); // warn must be below max
    expect(ce.checkBudget(0)).toMatchObject({ ok: true, level: 'warning', warn_at_usd: 0.40 });
    writeConfig({ budget: { max_usd: 0.50 } });
    expect(ce.checkBudget(0)).toMatchObject({ ok: true, level: 'warning', warn_at_usd: 0.40 });
  });

  test('project max/warn takes precedence when it is the more restrictive cap', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.41, project: 'alpha', timestamp: new Date().toISOString() },
    );
    writeConfig({
      budget: {
        max_usd: 1.00, warn_at_usd: 0.90,
        projects: { alpha: { max_usd: 0.50, warn_at_usd: 0.40 } },
      },
    });
    expect(ce.checkBudget(0, 'alpha')).toMatchObject({
      ok: true, level: 'warning', project: 'alpha',
      reason: 'budget.projects.alpha.max_usd', warn_at_usd: 0.40,
    });
    expect(ce.checkBudget(0.10, 'alpha')).toMatchObject({
      ok: false, level: 'exceeded', reason: 'budget.projects.alpha.max_usd',
    });
  });

  test('global warning beats a project normal result even at a lower percentage', () => {
    appendLines({ type: 'task_complete', cost_usd: 0.20, project: 'alpha', timestamp: new Date().toISOString() });
    writeConfig({
      budget: {
        max_usd: 1.00, warn_at_usd: 0.10,
        projects: { alpha: { max_usd: 0.50, warn_at_usd: 0.40 } },
      },
    });
    expect(ce.checkBudget(0, 'alpha')).toMatchObject({
      ok: true, level: 'warning', reason: 'budget.max_usd', warn_at_usd: 0.10,
    });
  });

  test('project warning beats a global normal result', () => {
    appendLines({ type: 'task_complete', cost_usd: 0.20, project: 'alpha', timestamp: new Date().toISOString() });
    writeConfig({
      budget: {
        max_usd: 1.00, warn_at_usd: 0.90,
        projects: { alpha: { max_usd: 0.50, warn_at_usd: 0.10 } },
      },
    });
    expect(ce.checkBudget(0, 'alpha')).toMatchObject({
      ok: true, level: 'warning', project: 'alpha',
      reason: 'budget.projects.alpha.max_usd', warn_at_usd: 0.10,
    });
  });

  test('global cap wins when it is more restrictive than the project cap', () => {
    appendLines(
      { type: 'task_complete', cost_usd: 0.49, project: 'alpha', timestamp: new Date().toISOString() },
    );
    writeConfig({
      budget: {
        max_usd: 0.50,
        projects: { alpha: { max_usd: 1.00, warn_at_usd: 0.80 } },
      },
    });
    expect(ce.checkBudget(0.02, 'alpha')).toMatchObject({
      ok: false, level: 'exceeded', reason: 'budget.max_usd',
    });
  });
});

// ── 13. getModelForRoleWithCorrelation ─────────────────────────────────────────

describe('getModelForRoleWithCorrelation', () => {
  test('returns model and a ce-prefixed correlationId', () => {
    const { model, correlationId } = ce.getModelForRoleWithCorrelation('executor', 'medium', {
      model_profile: 'default',
    });
    expect(model).toBe('sonnet');
    expect(typeof correlationId).toBe('string');
    expect(correlationId.startsWith('ce-')).toBe(true);
  });

  test('each call produces a unique correlationId', () => {
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      const { correlationId } = ce.getModelForRoleWithCorrelation('executor', 'medium', {});
      ids.add(correlationId);
    }
    expect(ids.size).toBe(10);
  });
});

describe('event schema v2 migration (t1)', () => {
  test('EVENT_SCHEMA_VERSION is 2', () => {
    expect(ce.EVENT_SCHEMA_VERSION).toBe(2);
  });

  test('appendMetric injects schema_v, machine_id, event_id when absent', () => {
    const mp = ce.metricsPath();
    // Fresh file for this test
    if (existsSync(mp)) writeFileSync(mp, '');
    ce.appendMetric({ type: 'task_complete', cost_usd: 0.01, role: 'executor' });
    const line = readFileSync(mp, 'utf8').trim().split('\n').pop();
    const ev = JSON.parse(line);
    expect(ev.schema_v).toBe(2);
    expect(typeof ev.machine_id).toBe('string');
    expect(ev.machine_id.length).toBeGreaterThan(0);
    expect(typeof ev.event_id).toBe('string');
    expect(ev.event_id.startsWith('ev-')).toBe(true);
    // Caller-provided fields survive
    expect(ev.type).toBe('task_complete');
    expect(ev.cost_usd).toBe(0.01);
    expect(ev.role).toBe('executor');
  });

  test('appendMetric preserves caller-provided schema_v / machine_id / event_id', () => {
    const mp = ce.metricsPath();
    if (existsSync(mp)) writeFileSync(mp, '');
    ce.appendMetric({
      type: 'task_complete', cost_usd: 0,
      schema_v: 99, machine_id: 'remote-host', event_id: 'ev-fixed123',
    });
    const line = readFileSync(mp, 'utf8').trim().split('\n').pop();
    const ev = JSON.parse(line);
    expect(ev.schema_v).toBe(99);
    expect(ev.machine_id).toBe('remote-host');
    expect(ev.event_id).toBe('ev-fixed123');
  });

  test('adaptEvent treats missing schema_v as v1 and back-fills fields', () => {
    const v1Event = { type: 'task_complete', cost_usd: 0.5, role: 'executor', timestamp: '2025-01-01T00:00:00Z' };
    const adapted = ce.adaptEvent(v1Event);
    expect(adapted.schema_v).toBe(1);
    expect(adapted.machine_id).toBeNull();
    expect(adapted.event_id).toBeNull();
    // Original fields intact
    expect(adapted.type).toBe('task_complete');
    expect(adapted.cost_usd).toBe(0.5);
    expect(adapted.role).toBe('executor');
  });

  test('adaptEvent passes v2 events through unchanged', () => {
    const v2Event = {
      type: 'task_complete', cost_usd: 0.1,
      schema_v: 2, machine_id: 'host-a', event_id: 'ev-abc123',
    };
    const adapted = ce.adaptEvent(v2Event);
    expect(adapted).toBe(v2Event); // same reference — no copy
  });

  test('adaptEvent handles null / non-object safely', () => {
    expect(ce.adaptEvent(null)).toBeNull();
    expect(ce.adaptEvent(undefined)).toBeUndefined();
    expect(ce.adaptEvent('string')).toBe('string');
  });
});

// ── FakeLLM fixture harness (t17) ───────────────────────────────────────────

describe('FakeLLM — deterministic cost fixture injection (t17)', () => {
  beforeEach(() => { clearMetrics(); clearConfig(); });
  afterEach(() => { clearMetrics(); clearConfig(); });

  test('an exact-prompt fixture returns stable tokens, cost, and virtual latency', async () => {
    const llm = createFakeLLM({
      prompts: {
        'summarize the diff': {
          content: 'deterministic summary', input_tokens: 120, output_tokens: 30,
          cost_usd: 0.0012, latency_ms: 45,
        },
      },
    });

    const first = await llm.complete('summarize the diff');
    const second = await llm.complete('summarize the diff');

    expect(first).toEqual({
      prompt: 'summarize the diff', content: 'deterministic summary',
      input_tokens: 120, output_tokens: 30, cost_usd: 0.0012,
      latency_ms: 45, model: 'fake-llm', call_index: 0,
    });
    expect(second).toMatchObject({ input_tokens: 120, output_tokens: 30, cost_usd: 0.0012, latency_ms: 45, call_index: 1 });
    expect(llm.totalLatencyMs).toBe(90); // virtual: no timer/network dependency
  });

  test('cache-style caller avoids a second FakeLLM invocation for the same prompt', async () => {
    const llm = createFakeLLM({
      'cacheable prompt': {
        content: 'cached result', input_tokens: 80, output_tokens: 20,
        cost_usd: 0.0008, latency_ms: 30,
      },
    });
    const cache = new Map();
    const completeWithCache = async (prompt) => {
      if (cache.has(prompt)) return { ...cache.get(prompt), cache_hit: true };
      const response = await llm.complete(prompt);
      cache.set(prompt, response);
      return { ...response, cache_hit: false };
    };

    const miss = await completeWithCache('cacheable prompt');
    const hit = await completeWithCache('cacheable prompt');

    expect(miss.cache_hit).toBe(false);
    expect(hit.cache_hit).toBe(true);
    expect(hit.cost_usd).toBe(miss.cost_usd);
    expect(llm.callCount).toBe(1);
    expect(llm.totalLatencyMs).toBe(30);
  });

  test('hard-cap check consumes the fixture cost deterministically', async () => {
    const llm = createFakeLLM({
      'expensive prompt': {
        content: 'would exceed the cap', input_tokens: 100, output_tokens: 50,
        cost_usd: 0.11, latency_ms: 10,
      },
    });
    appendLines({ type: 'task_complete', cost_usd: 0.90, timestamp: new Date().toISOString() });
    writeConfig({ budget: { max_usd: 1 } });

    const proposed = await llm.complete('expensive prompt');
    const guard = ce.checkBudget(proposed.cost_usd);

    expect(guard.ok).toBe(false);
    expect(guard.projected).toBeCloseTo(1.01, 6);
    expect(llm.callCount).toBe(1);
  });

  test('prediction calibration consumes repeatable fixture cost samples', async () => {
    const prompts = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `prediction sample ${index}`,
      {
        content: `result ${index}`, input_tokens: 100, output_tokens: 20,
        cost_usd: 0.025, latency_ms: 5,
      },
    ]));
    const llm = createFakeLLM({ prompts });

    for (const prompt of Object.keys(prompts)) {
      const response = await llm.complete(prompt);
      appendLines({
        type: 'task_complete', size: 'small', cost_source: 'actual',
        cost_usd: response.cost_usd, input_tokens: response.input_tokens,
        output_tokens: response.output_tokens, timestamp: new Date().toISOString(),
      });
    }
    const actuals = ce.computeTokenActuals();
    const forecast = ce.estimateTaskCost({ name: 'fixture prediction', size: 'small' }, 'sonnet');

    expect(actuals.sample_counts.small).toBe(10);
    expect(actuals.estimates.small.avg_cost_usd).toBeCloseTo(0.025, 6);
    expect(forecast.confidence).toBe('high');
    expect(forecast.cost_usd).toBeCloseTo(0.025, 6);
    expect(llm.totalLatencyMs).toBe(50);
  });
});
