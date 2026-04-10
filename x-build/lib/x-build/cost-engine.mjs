/**
 * x-build/cost-engine — Cost estimation, model profiles, and budget guard
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, statSync, unlinkSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ── ROOT resolution (mirrors core.mjs) ──────────────────────────────

const __filename_ce = fileURLToPath(import.meta.url);
const __dirname_ce = dirname(__filename_ce);

const XM_GLOBAL_CE = process.argv.includes('--global');
const ROOT_CE = process.env.X_BUILD_ROOT
  ? new URL('file://' + process.env.X_BUILD_ROOT).pathname
  : XM_GLOBAL_CE
    ? join(homedir(), '.xm', 'build')
    : join(process.cwd(), '.xm', 'build');

// ── Shared config loader (local copy to avoid circular dep) ─────────

function loadSharedConfigCE() {
  const sharedPath = join(ROOT_CE, '..', 'config.json');
  if (existsSync(sharedPath)) {
    try { return JSON.parse(readFileSync(sharedPath, 'utf8')); } catch { /* fall through */ }
  }
  const globalPath = join(homedir(), '.xm', 'config.json');
  if (existsSync(globalPath)) {
    try { return JSON.parse(readFileSync(globalPath, 'utf8')); } catch { /* fall through */ }
  }
  return {};
}

// ── Metrics path ─────────────────────────────────────────────────────

export function metricsPath() {
  return join(ROOT_CE, 'metrics', 'sessions.jsonl');
}

const TOKEN_ACTUALS_PATH = join(ROOT_CE, 'metrics', 'token-actuals.json');

export const METRICS_MAX_BYTES = 5 * 1024 * 1024; // 5MB rotation threshold

// ── Write lock helpers ────────────────────────────────────────────────

function acquireWriteLock(lockPath, maxRetries = 50, intervalMs = 20) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // exclusive create
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') {
        // Stale lock detection: if lock file is older than 10s, remove it
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 10000) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* lock may have been removed by another process */ }
        // Busy wait
        const start = Date.now();
        while (Date.now() - start < intervalMs) {} // spin
        continue;
      }
      throw e;
    }
  }
  return false;
}

function releaseWriteLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* best effort */ }
}

// ── appendMetric ─────────────────────────────────────────────────────

export function appendMetric(data) {
  const p = metricsPath();
  mkdirSync(dirname(p), { recursive: true });
  const lockPath = p + '.lock';
  const acquired = acquireWriteLock(lockPath);
  if (!acquired) {
    // Graceful degradation: log warning and proceed without lock
    process.stderr.write('[x-build] appendMetric: failed to acquire write lock, proceeding without lock\n');
  }
  try {
    if (existsSync(p)) {
      try {
        const sz = statSync(p).size;
        if (sz > METRICS_MAX_BYTES) {
          const rotated = p + '.1';
          if (existsSync(rotated)) writeFileSync(rotated, '', 'utf8');
          renameSync(p, rotated);
        }
      } catch { /* ignore rotation errors */ }
    }
    appendFileSync(p, JSON.stringify(data) + '\n', 'utf8');
  } finally {
    if (acquired) releaseWriteLock(lockPath);
  }
}

// ── MODEL_COSTS ───────────────────────────────────────────────────────

export const MODEL_COSTS = {
  'haiku':  { input: 0.25, output: 1.25 },
  'sonnet': { input: 3.00, output: 15.00 },
  'opus':   { input: 15.00, output: 75.00 },
};

// ── SIZE_TOKEN_ESTIMATES ──────────────────────────────────────────────

export const SIZE_TOKEN_ESTIMATES = {
  small:  { input: 8000,  output: 3000,  turns: 3 },
  medium: { input: 15000, output: 6000,  turns: 6 },
  large:  { input: 30000, output: 12000, turns: 12 },
};

// ── STRATEGY_MULTIPLIERS ──────────────────────────────────────────────
// Values reflect average token overhead relative to a single-agent baseline.

export const STRATEGY_MULTIPLIERS = {
  escalate: 0.4,     // starts haiku; average across 3 levels ≈ 40% of opus-only
  decompose: 1.2,    // splits into smaller parallel tasks
  distribute: 1.2,   // parallel independent subtasks
  tournament: 1.3,   // elimination reduces total work
  chain: 1.3,        // sequential A→B→C pipeline
  brainstorm: 1.3,   // free ideation + clustering
  hypothesis: 1.4,   // generate + falsify rounds
  persona: 1.4,      // multi-persona analysis
  scaffold: 1.4,     // design + dispatch + integrate
  review: 1.5,       // multi-lens code review
  investigate: 1.5,  // multi-angle + synthesis + gap analysis
  monitor: 1.2,      // single OODA cycle
  socratic: 1.5,     // question rounds
  council: 1.6,      // cross-examination + deep dive + converge
  debate: 1.6,       // opening + rebuttal + verdict
  'red-team': 1.6,   // attack + defend + report
  refine: 1.8,       // multiple refinement rounds
  compose: 2.0,      // multi-strategy pipeline
};

// ── ROLE_MODEL_MAP_HR ─────────────────────────────────────────────────

export const ROLE_MODEL_MAP_HR = {
  architect: 'opus', reviewer: 'opus', security: 'opus',
  executor: 'sonnet', designer: 'sonnet', debugger: 'sonnet',
  explorer: 'haiku', writer: 'haiku',
};

// ── MODEL_PROFILES ────────────────────────────────────────────────────
// model_profile in .xm/config.json controls role→model mapping globally.
// "economy" downgrades expensive roles; "performance" upgrades cheap ones.

export const MODEL_PROFILES = {
  economy: {
    architect: 'sonnet', reviewer: 'sonnet', security: 'sonnet',
    executor: 'haiku',  designer: 'haiku',  debugger: 'sonnet',
    explorer: 'haiku',  writer: 'haiku',
  },
  balanced: ROLE_MODEL_MAP_HR,
  performance: {
    architect: 'opus',  reviewer: 'opus',   security: 'opus',
    executor: 'opus',   designer: 'sonnet', debugger: 'opus',
    explorer: 'sonnet', writer: 'haiku',
  },
};

// ── getModelForRole ───────────────────────────────────────────────────

export function getModelForRole(role, size, config) {
  if (!config) config = loadSharedConfigCE();
  const profile = config.model_profile || 'balanced';
  if (!MODEL_PROFILES[profile]) {
    console.error(`⚠ Unknown model_profile "${profile}" — falling back to balanced`);
  }
  const baseMap = MODEL_PROFILES[profile] || MODEL_PROFILES.balanced;
  const overrides = config.model_overrides || {};
  const map = { ...baseMap, ...overrides };
  if (!baseMap[role]) {
    console.warn(`⚠ Unknown role "${role}" — falling back to executor model`);
  }
  const model = map[role] || map.executor;
  if (size === 'large' && model === 'haiku') {
    console.warn(`  ⚠ ${role} uses haiku for large task — consider: /x-kit config set model_overrides '{"${role}": "sonnet"}'`);
  }
  return model;
}

// ── getModelForRoleWithCorrelation ────────────────────────────────────

function generateCorrelationId() {
  return 'ce-' + randomBytes(4).toString('hex');
}

export function getModelForRoleWithCorrelation(role, size, config) {
  const model = getModelForRole(role, size, config);
  const correlationId = generateCorrelationId();
  return { model, correlationId };
}

// ── loadTokenActuals ──────────────────────────────────────────────────

export function loadTokenActuals() {
  try {
    const metricsFile = metricsPath();
    if (!existsSync(TOKEN_ACTUALS_PATH)) return null;
    const actualsMtime = statSync(TOKEN_ACTUALS_PATH).mtimeMs;
    const metricsMtime = statSync(metricsFile).mtimeMs;
    if (metricsMtime > actualsMtime) return null; // stale, needs recompute
    return JSON.parse(readFileSync(TOKEN_ACTUALS_PATH, 'utf8'));
  } catch { return null; }
}

// ── computeTokenActuals ───────────────────────────────────────────────

export function computeTokenActuals() {
  const metricsFile = metricsPath();
  if (!existsSync(metricsFile)) return null;

  const groups = { small: [], medium: [], large: [] };
  try {
    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n');
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (m.type === 'task_complete' && typeof m.cost_usd === 'number' && m.size && groups[m.size]) {
          groups[m.size].push(m.cost_usd);
        }
      } catch { /* skip malformed */ }
    }
  } catch { return null; }

  const sample_counts = {};
  const estimates = {};
  for (const size of Object.keys(groups)) {
    const samples = groups[size];
    sample_counts[size] = samples.length;
    if (samples.length > 0) {
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      estimates[size] = { avg_cost_usd: avg };
    }
  }

  const result = {
    updated_at: new Date().toISOString(),
    sample_counts,
    estimates,
  };

  try {
    mkdirSync(dirname(TOKEN_ACTUALS_PATH), { recursive: true });
    writeFileSync(TOKEN_ACTUALS_PATH, JSON.stringify(result, null, 2), 'utf8');
  } catch { /* best effort */ }

  return result;
}

// ── estimateTaskCost ──────────────────────────────────────────────────

export function estimateTaskCost(task, model = 'sonnet') {
  const size = task.size || 'medium';
  const base = SIZE_TOKEN_ESTIMATES[size] || SIZE_TOKEN_ESTIMATES.medium;
  const costs = MODEL_COSTS[model] || MODEL_COSTS.sonnet;

  // Complexity adjustments
  const depCount = task.depends_on?.length || 0;
  const depMultiplier = 1.0 + (depCount * 0.1); // +10% per dependency (context injection)

  const nameLower = (task.name || '').toLowerCase();
  const domainMultiplier =
    /\b(security|auth|oauth)\b/.test(nameLower) ? 1.4 :
    /\b(architect|design|refactor)\b/.test(nameLower) ? 1.3 :
    /\b(migration|database)\b/.test(nameLower) ? 1.2 :
    1.0;

  const strategyMultiplier = task.strategy
    ? (STRATEGY_MULTIPLIERS[task.strategy] || 1.5)
    : 1.0;

  const totalMultiplier = depMultiplier * domainMultiplier * strategyMultiplier;
  const adjustedInput = Math.round(base.input * totalMultiplier);
  const adjustedOutput = Math.round(base.output * totalMultiplier);

  // Use actuals-based cost if enough samples exist
  const actuals = loadTokenActuals();
  const sampleCount = actuals?.sample_counts?.[size] ?? 0;
  if (actuals && sampleCount >= 10 && actuals.estimates?.[size]?.avg_cost_usd != null) {
    const baseCostUsd = actuals.estimates[size].avg_cost_usd * totalMultiplier;
    return {
      input_tokens: adjustedInput * base.turns,
      output_tokens: adjustedOutput * base.turns,
      cost_usd: baseCostUsd,
      model,
      confidence: 'high',
      multiplier: totalMultiplier,
    };
  }

  const inputCost = (adjustedInput * base.turns / 1_000_000) * costs.input;
  const outputCost = (adjustedOutput * base.turns / 1_000_000) * costs.output;

  const confidence = totalMultiplier > 1.5 ? 'low' : totalMultiplier > 1.1 ? 'medium' : 'high';

  return {
    input_tokens: adjustedInput * base.turns,
    output_tokens: adjustedOutput * base.turns,
    cost_usd: inputCost + outputCost,
    model,
    confidence,
    multiplier: totalMultiplier,
  };
}

// ── cmdForecastUpdate ─────────────────────────────────────────────────

export function cmdForecastUpdate() {
  computeTokenActuals();
  console.log('Token actuals updated.');
}

// ── checkBudget ───────────────────────────────────────────────────────

export function checkBudget(additionalCost = 0) {
  const config = loadSharedConfigCE();
  const budget = Number(config.budget?.max_usd);
  if (!budget || isNaN(budget)) return { ok: true, budget: null };

  const mp = metricsPath();
  let spent = 0;
  if (existsSync(mp)) {
    try {
      const lines = readFileSync(mp, 'utf8').trim().split('\n');
      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          if (typeof m.cost_usd === 'number') spent += m.cost_usd;
        } catch { /* skip malformed */ }
      }
    } catch { /* ignore read errors */ }
  }

  const projected = spent + additionalCost;
  const pct = (projected / budget * 100);

  if (projected > budget) {
    return { ok: false, spent, projected, budget, pct, level: 'exceeded' };
  }
  if (pct > 80) {
    return { ok: true, spent, projected, budget, pct, level: 'warning' };
  }
  return { ok: true, spent, projected, budget, pct, level: 'normal' };
}
