/**
 * x-build/cost-engine — Cost estimation, model profiles, and budget guard
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, statSync, unlinkSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ROOT } from './root.mjs';
import { loadSharedConfig } from './config-loader.mjs';

// ── Event schema version ─────────────────────────────────────────────
// v1 = legacy (no schema_v field). v2 = adds schema_v, machine_id, event_id.
// Readers MUST treat events without schema_v as v1 and apply v1→v2 adapter.
export const EVENT_SCHEMA_VERSION = 2;

function machineId() {
  // Stable per-host identifier; used to dedup events when multiple machines
  // share .xm/ via x-sync. Short hostname is sufficient for single-user setups.
  try { return hostname(); } catch { return 'unknown'; }
}

function generateEventId() {
  // 12-hex: enough entropy for session-scoped dedup, short enough to read.
  return 'ev-' + randomBytes(6).toString('hex');
}

// ── v1→v2 event adapter ──────────────────────────────────────────────
// Readers should wrap raw events via adaptEvent() so downstream code can
// assume v2 shape. Events with schema_v:2 pass through unchanged.
export function adaptEvent(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.schema_v === 2) return raw;
  return {
    ...raw,
    schema_v: raw.schema_v ?? 1,
    machine_id: raw.machine_id ?? null,
    event_id: raw.event_id ?? null,
  };
}

// ── Metrics path ─────────────────────────────────────────────────────

export function metricsPath() {
  return join(ROOT, 'metrics', 'sessions.jsonl');
}

function tokenActualsPath() {
  return join(ROOT, 'metrics', 'token-actuals.json');
}

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
  // Inject v2 schema fields if absent. Callers may preset schema_v/machine_id/
  // event_id (e.g., for dedup replay from remote); we only fill the gaps.
  const event = {
    schema_v: EVENT_SCHEMA_VERSION,
    machine_id: machineId(),
    event_id: generateEventId(),
    ...data,
  };
  const p = metricsPath();
  mkdirSync(dirname(p), { recursive: true });
  const lockPath = p + '.lock';
  const acquired = acquireWriteLock(lockPath);
  if (!acquired) {
    // Graceful degradation: log warning and proceed without lock
    process.stderr.write('[x-build] appendMetric: failed to acquire write lock (' + lockPath + '), proceeding without lock\n');
  }
  try {
    if (existsSync(p)) {
      try {
        const sz = statSync(p).size;
        if (sz > METRICS_MAX_BYTES) {
          const rotated = p + '.1';
          renameSync(p, rotated);
        }
      } catch { /* ignore rotation errors */ }
    }
    appendFileSync(p, JSON.stringify(event) + '\n', 'utf8');
  } finally {
    if (acquired) releaseWriteLock(lockPath);
  }
}

// ── INHERIT_MODEL ─────────────────────────────────────────────────────
// Sentinel tier meaning "use the session model the user picked via /model".
// It is NOT a billable tier: it must never become a key of MODEL_COSTS /
// VENDOR_MODELS, and it must never reach the Agent tool as a literal value —
// the orchestrating layer expresses inherit by OMITTING the model parameter.
export const INHERIT_MODEL = 'inherit';

// Roles whose output quality scales directly with model capability — these are
// the roles MODEL_PROFILES routes to 'inherit' under default/max, and the ones
// agent_type promotion treats as deep work even without a concrete 'opus'.
export const JUDGMENT_ROLES = [
  'architect', 'reviewer', 'security', 'planner', 'critic', 'debugger', 'deep-executor',
];

// ── MODEL_COSTS ───────────────────────────────────────────────────────

// Prices per 1M tokens (USD). Last updated: 2026-04 (Claude 4.x family).
export const MODEL_COSTS = {
  'haiku':  { input: 1.00, output: 5.00 },
  'sonnet': { input: 3.00, output: 15.00 },
  'opus':   { input: 15.00, output: 75.00 },
};

// Real cost (USD) from measured token counts. Use when actual usage is known —
// unlike estimateTaskCost(), which projects from size heuristics. Feeding the
// result back into the metrics stream (tagged cost_source:'actual') is what
// lets computeTokenActuals() learn from ground truth instead of recycling its
// own estimates.
export function costFromTokens(model, inputTokens, outputTokens) {
  // 'inherit' has no price of its own: bill at the opus ceiling so the number
  // errs high, never low. Callers that know the real session model should pass
  // it instead (tasks update --resolved-model).
  const costs = model === INHERIT_MODEL ? MODEL_COSTS.opus
    : (MODEL_COSTS[model] || MODEL_COSTS.sonnet);
  const i = Math.max(0, Number(inputTokens) || 0);
  const o = Math.max(0, Number(outputTokens) || 0);
  return (i / 1_000_000) * costs.input + (o / 1_000_000) * costs.output;
}

// ── Vendor abstraction layer ──────────────────────────────────────────
// Adds a vendor dimension (claude, codex, …) on top of the canonical tier
// vocabulary WITHOUT touching getModelForRole's contract: role→tier routing
// keeps returning the plain 'haiku'/'sonnet'/'opus' strings that 15 consumers
// compare and index by. Vendor resolution is a SEPARATE, opt-in step layered
// after routing (option A), so no existing lookup path changes.

/**
 * Canonical tier → vendor-specific model spec.
 *
 * The keys `haiku` / `sonnet` / `opus` are CANONICAL TIER ALIASES, not literal
 * Claude model names — they denote the light / standard / max capability tiers
 * that role routing already speaks in. Under vendor `claude` each tier maps to
 * itself; under other vendors it maps to that vendor's model spec (optionally
 * `model:effort`). Human-facing display labels (light / standard / max) are the
 * UI layer's job, NOT this table's — never surface these tier keys to users.
 */
export const VENDOR_MODELS = {
  claude: { haiku: 'haiku',        sonnet: 'sonnet', opus: 'opus' },
  codex:  { haiku: 'gpt-5.4-mini', sonnet: 'gpt-5.4', opus: 'gpt-5.5:high' },
};

// Reasoning-effort levels accepted in a `model:effort` spec, ordered low→high.
// Used to validate the optional effort suffix before it reaches a vendor CLI.
export const MODEL_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// Per-vendor prices per 1M tokens (USD). The `claude` block mirrors the flat
// MODEL_COSTS above (single source: same numbers, kept in sync intentionally —
// the flat map stays for backward-compatible MODEL_COSTS[model] lookups).
//
// 출처: OpenAI pricing, 2026-07 확인 — 수동 관리
// TODO(cost): GPT-5.4 / 5.5 official per-1M pricing is NOT fully confirmed at
// authoring time (2026-07). The codex numbers below are CONSERVATIVE
// APPROXIMATIONS chosen to avoid silently under-reporting spend — revisit and
// replace with published figures. Surfacing an approximate-but-labeled number
// beats a silent wrong estimate (FM4).
export const MODEL_COSTS_BY_VENDOR = {
  claude: {
    haiku:  { input: 1.00,  output: 5.00 },
    sonnet: { input: 3.00,  output: 15.00 },
    opus:   { input: 15.00, output: 75.00 },
  },
  codex: {
    haiku:  { input: 0.25, output: 2.00 },   // gpt-5.4-mini  (approx, unverified)
    sonnet: { input: 1.25, output: 10.00 },  // gpt-5.4       (approx, unverified)
    opus:   { input: 2.50, output: 20.00 },  // gpt-5.5:high  (approx, unverified)
  },
};

/**
 * Parse a `"model[:effort]"` spec into its parts.
 *
 * The optional trailing `:effort` segment is validated against
 * MODEL_EFFORT_LEVELS. On a typo the model is still returned with
 * `effort: null` plus a `warning` string, so the caller can decide whether to
 * surface it or proceed with a default effort (FM2 — never swallow the signal).
 *
 * Rules:
 *  - No colon → whole string is the model, effort null, no warning.
 *  - Multiple colons ("a:b:c") → split at the LAST colon; only the final
 *    segment is an effort candidate ("a:b" is the model).
 *  - Empty / non-string input → { model:null, effort:null, warning }.
 *
 * @param {string} spec
 * @returns {{ model: string|null, effort: string|null, warning: string|null }}
 */
export function parseModelSpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    return {
      model: null,
      effort: null,
      warning: `parseModelSpec: spec must be a non-empty string (got ${spec === '' ? '""' : typeof spec})`,
    };
  }
  const trimmed = spec.trim();
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) {
    return { model: trimmed, effort: null, warning: null };
  }
  const model = trimmed.slice(0, idx);
  const effortCandidate = trimmed.slice(idx + 1);
  if (model === '') {
    return { model: null, effort: null, warning: `parseModelSpec: empty model in spec "${trimmed}"` };
  }
  if (effortCandidate === '') {
    return { model, effort: null, warning: `parseModelSpec: trailing ':' with no effort in "${trimmed}"` };
  }
  if (!MODEL_EFFORT_LEVELS.includes(effortCandidate)) {
    return {
      model,
      effort: null,
      warning: `parseModelSpec: unknown effort "${effortCandidate}" (expected one of ${MODEL_EFFORT_LEVELS.join(', ')})`,
    };
  }
  return { model, effort: effortCandidate, warning: null };
}

/**
 * Resolve a canonical tier into a vendor model spec.
 *
 * Priority chain:
 *   1. cfg.vendor_models[vendor][tier]  — user override, always wins
 *   2. VENDOR_MODELS[vendor][tier]      — built-in table
 *   3. vendor === 'claude'              — tier passed through as-is
 *   4. otherwise                        — { spec:null, warning } (FM1)
 *
 * FM1: an unknown vendor/tier returns a null spec plus a warning so the caller
 * can fall back to claude rather than get a silently wrong model.
 * FM7: a non-object cfg.vendor_models is warned about and ignored.
 *
 * @param {string} tier   canonical tier ('haiku'|'sonnet'|'opus')
 * @param {string} [vendor='claude']
 * @param {object} [cfg={}] shared config (reads cfg.vendor_models)
 * @returns {{ spec: string|null, source: string|null, warning: string|null }}
 */
export function resolveVendorModel(tier, vendor = 'claude', cfg = {}) {
  const warnings = [];

  // FM7: config.vendor_models must be a plain object; otherwise warn and ignore.
  let vendorModels = cfg?.vendor_models ?? null;
  if (vendorModels != null && (typeof vendorModels !== 'object' || Array.isArray(vendorModels))) {
    warnings.push(`resolveVendorModel: config.vendor_models must be an object (got ${Array.isArray(vendorModels) ? 'array' : typeof vendorModels}) — ignoring`);
    vendorModels = null;
  }

  // 1. Config override — highest priority.
  const override = vendorModels?.[vendor]?.[tier];
  if (override != null) {
    if (typeof override === 'string' && override.trim() !== '') {
      return { spec: override, source: 'config', warning: warnings.join('; ') || null };
    }
    warnings.push(`resolveVendorModel: config.vendor_models.${vendor}.${tier} is not a non-empty string — ignoring`);
  }

  // 2. Built-in vendor table.
  const builtin = VENDOR_MODELS[vendor]?.[tier];
  if (typeof builtin === 'string' && builtin) {
    return { spec: builtin, source: 'builtin', warning: warnings.join('; ') || null };
  }

  // 3. Claude passthrough — role routing already emits tier names.
  if (vendor === 'claude') {
    return { spec: tier, source: 'claude-passthrough', warning: warnings.join('; ') || null };
  }

  // 4. FM1: unknown vendor/tier — null spec + warning, caller falls back to claude.
  warnings.push(`resolveVendorModel: no mapping for tier "${tier}" under vendor "${vendor}" — caller should fall back to claude`);
  return { spec: null, source: null, warning: warnings.join('; ') };
}

/**
 * Measured cost (USD) for a vendor+tier, mirroring costFromTokens() but on the
 * vendor-nested price table. On a missing vendor or tier it falls back to
 * claude/sonnet pricing AND returns a `warning` — never a silent wrong estimate
 * (FM4). Callers should log the warning; the numeric cost is best-effort.
 *
 * @returns {{ cost_usd: number, warning: string|null }}
 */
export function costFromTokensVendor(vendor, tier, inputTokens, outputTokens) {
  let warning = null;
  let costs;
  const vendorTable = MODEL_COSTS_BY_VENDOR[vendor];
  if (!vendorTable) {
    warning = `costFromTokensVendor: unknown vendor "${vendor}" — falling back to claude/sonnet pricing`;
    costs = MODEL_COSTS_BY_VENDOR.claude.sonnet;
  } else if (!vendorTable[tier]) {
    warning = `costFromTokensVendor: unknown tier "${tier}" for vendor "${vendor}" — falling back to sonnet pricing`;
    costs = vendorTable.sonnet || MODEL_COSTS_BY_VENDOR.claude.sonnet;
  } else {
    costs = vendorTable[tier];
  }
  const i = Math.max(0, Number(inputTokens) || 0);
  const o = Math.max(0, Number(outputTokens) || 0);
  const cost_usd = (i / 1_000_000) * costs.input + (o / 1_000_000) * costs.output;
  return { cost_usd, warning };
}

// ── SIZE_TOKEN_ESTIMATES ──────────────────────────────────────────────

export const SIZE_TOKEN_ESTIMATES = {
  small:  { input: 8000,  output: 3000,  turns: 3 },
  medium: { input: 15000, output: 6000,  turns: 6 },
  large:  { input: 30000, output: 12000, turns: 12 },
};

// ── STRATEGY_MULTIPLIERS ──────────────────────────────────────────────
// Values reflect average token overhead relative to a single-agent baseline.

export const STRATEGY_MULTIPLIERS = {
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
// FIXED concrete-tier table consumed by the codex installer transform
// (resolveCodexSpec throws on specs it cannot resolve). NEVER put 'inherit'
// here — this table must always resolve to a billable tier. Session-model
// routing lives in MODEL_PROFILES below.

export const ROLE_MODEL_MAP_HR = {
  architect: 'opus', reviewer: 'opus', security: 'opus',
  executor: 'sonnet', designer: 'sonnet', debugger: 'sonnet',
  explorer: 'haiku', writer: 'haiku',
  'deep-executor': 'opus', planner: 'opus', critic: 'opus',
  verifier: 'sonnet', researcher: 'sonnet',
};

// ── MODEL_PROFILES ────────────────────────────────────────────────────
// model_profile in .xm/config.json expresses COST INTENT (how much to spend),
// not a per-role mixing strategy. Three tiers on a single axis: economy → default → max.
//
// Script-only commands (xm config show, version, agents list, …) are still
// routed to haiku via the Model Guardrail in xm/skills/kit/SKILL.md — that
// layer is independent of these role-based profiles.
//
// Legacy names ("balanced", "performance") are accepted and remapped via
// LEGACY_PROFILE_MAP below.

// default/max route JUDGMENT roles (architect, reviewer, security, planner,
// critic, debugger, deep-executor) to 'inherit' — "use the session model the
// user picked via /model". The profile decides WHERE to save; /model decides
// what quality means. economy keeps every role on a fixed tier: its whole
// point is a spend ceiling, and an inherited session model can be arbitrarily
// expensive (getModelForRole enforces this even against model_overrides).
export const MODEL_PROFILES = {
  // Sonnet-centric. For users without Opus budget — still usable quality.
  // haiku reserved for cheap roles (explorer, writer). No 'inherit' here.
  economy: {
    architect: 'sonnet', reviewer: 'sonnet', security: 'sonnet',
    executor:  'sonnet', designer:  'sonnet', debugger: 'sonnet',
    explorer:  'haiku',  writer:    'haiku',
    'deep-executor': 'sonnet', planner: 'sonnet', critic: 'sonnet',
    verifier: 'sonnet', researcher: 'haiku',
  },
  // Judgment roles ride the session model; mechanical/execution roles keep
  // their fixed tiers (executor opus, designer sonnet, explorer sonnet, …).
  default: {
    architect: 'inherit', reviewer: 'inherit', security: 'inherit',
    executor:  'opus', designer:  'sonnet', debugger: 'inherit',
    explorer:  'sonnet', writer:  'haiku',
    'deep-executor': 'inherit', planner: 'inherit', critic: 'inherit',
    verifier: 'sonnet', researcher: 'sonnet',
  },
  // Quality-first. Judgment roles inherit; remaining execution roles stay on
  // opus except trivial ones (explorer, writer) where opus is over-investment.
  max: {
    architect: 'inherit', reviewer: 'inherit', security: 'inherit',
    executor:  'opus', designer:  'opus', debugger: 'inherit',
    explorer:  'sonnet', writer:  'haiku',
    'deep-executor': 'inherit', planner: 'inherit', critic: 'inherit',
    verifier: 'opus', researcher: 'sonnet',
  },
};

// Accepts old names without breaking existing .xm/config.json files.
// "balanced" maps to "default" (the closest semantic match), "performance" → "max".
export const LEGACY_PROFILE_MAP = {
  balanced: 'default',
  performance: 'max',
};

export function resolveProfileName(name) {
  if (!name) return 'default';
  return LEGACY_PROFILE_MAP[name] || name;
}

// ── ROLE_ALIASES / PHASE_ROLE_GROUPS ──────────────────────────────────
// Aliases map role names that appear in docs/presets but are not routing
// keys onto their canonical MODEL_PROFILES role.

export const ROLE_ALIASES = {
  'test-engineer': 'verifier',
  'build-fixer': 'executor',
  documenter: 'writer',
  se: 'executor',
};

export function resolveRole(role) {
  return ROLE_ALIASES[role] || role;
}

// Phase presets in the config wizard / dashboard expand a per-phase model
// choice into model_overrides for these role groups. explorer/writer are
// deliberately in no group — they stay profile/override-driven.
export const PHASE_ROLE_GROUPS = {
  plan:      ['architect', 'planner', 'critic', 'security', 'researcher'],
  implement: ['executor', 'deep-executor', 'designer', 'debugger'],
  review:    ['reviewer', 'verifier'],
};

// ── getModelForRole ───────────────────────────────────────────────────
// Override priority chain:
//   1. model_overrides[role]   — user explicit setting, ALWAYS wins
//   2. MODEL_PROFILES[profile] — static profile default
//   3. fallback: "sonnet"      — safe default

export function getModelForRole(role, size, config) {
  if (!config) config = loadSharedConfig();
  role = resolveRole(role);

  // Profile resolves first so the economy gate below can see it.
  const rawProfile = config.model_profile || 'default';
  const profile = resolveProfileName(rawProfile);
  if (!MODEL_PROFILES[profile]) {
    console.error(`⚠ Unknown model_profile "${rawProfile}" — falling back to default`);
  }
  const baseMap = MODEL_PROFILES[profile] || MODEL_PROFILES.default;

  // 1. User explicit override — ALWAYS wins, with one exception: economy never
  //    resolves to 'inherit'. economy is a spend ceiling, and an inherited
  //    session model can be arbitrarily expensive.
  const overrides = config.model_overrides || {};
  if (overrides[role]) {
    if (overrides[role] === INHERIT_MODEL && profile === 'economy') {
      const fallback = baseMap[role] || baseMap.executor || 'sonnet';
      console.warn(`⚠ model_overrides.${role}="inherit" is ignored under the economy profile — using "${fallback}"`);
      return fallback;
    }
    return overrides[role];
  }

  // 2. Static profile (with legacy name remap: balanced→default, performance→max)
  if (!baseMap[role]) {
    console.warn(`⚠ Unknown role "${role}" — falling back to executor model`);
  }
  const model = baseMap[role] || baseMap.executor;
  if (size === 'large' && model === 'haiku') {
    console.warn(`  ⚠ ${role} uses haiku for large task — consider: /xm config set model_overrides '{"${role}": "sonnet"}'`);
  }

  // 4. Fallback
  return model || 'sonnet';
}

// ── getModelForRoleWithCorrelation ────────────────────────────────────

export function generateCorrelationId() {
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
    if (!existsSync(tokenActualsPath())) return null;
    const actualsMtime = statSync(tokenActualsPath()).mtimeMs;
    const metricsMtime = statSync(metricsFile).mtimeMs;
    if (metricsMtime > actualsMtime) return null; // stale, needs recompute
    return JSON.parse(readFileSync(tokenActualsPath(), 'utf8'));
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
        // Exclude estimated samples — only token-measured ('actual') or legacy
        // untagged costs feed actuals. Newly-recorded estimates carry
        // cost_source:'estimated' (or 'estimated_inherit') and must never
        // recycle back as "actuals": that loop was circular (estimate → metric
        // → average → reused as actual). model:'inherit' samples are excluded
        // too — their cost was billed at the opus ceiling, not a real rate.
        if (m.type === 'task_complete' && !String(m.cost_source || '').startsWith('estimated')
            && m.model !== INHERIT_MODEL
            && typeof m.cost_usd === 'number' && m.size && groups[m.size]) {
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
    mkdirSync(dirname(tokenActualsPath()), { recursive: true });
    writeFileSync(tokenActualsPath(), JSON.stringify(result, null, 2), 'utf8');
  } catch (e) { process.stderr.write('[x-build] computeTokenActuals write error: ' + (e?.message || e) + '\n'); }

  return result;
}

// ── estimateTaskCost ──────────────────────────────────────────────────

export function estimateTaskCost(task, model = 'sonnet') {
  const size = task.size || 'medium';
  const base = SIZE_TOKEN_ESTIMATES[size] || SIZE_TOKEN_ESTIMATES.medium;
  // 'inherit' is priced at the opus ceiling (err high, never low — FM4
  // direction): the actual session model is unknown until run time.
  const isInherit = model === INHERIT_MODEL;
  const costs = isInherit ? MODEL_COSTS.opus : (MODEL_COSTS[model] || MODEL_COSTS.sonnet);
  const inheritFields = isInherit ? {
    confidence: 'low',
    warning: 'model "inherit" — cost assumes the opus ceiling; the actual session model is unknown until run time',
  } : {};

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
      ...inheritFields,
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
    ...inheritFields,
  };
}

// ── cmdForecastUpdate ─────────────────────────────────────────────────

export function cmdForecastUpdate() {
  computeTokenActuals();
  console.log('Token actuals updated.');
}

// ── spendCachePath ────────────────────────────────────────────────────

export function spendCachePath() {
  return join(ROOT, 'metrics', 'spend-cache.json');
}

// ── readSpendCache ────────────────────────────────────────────────────

function readSpendCache() {
  const cp = spendCachePath();
  if (!existsSync(cp)) return null;
  try {
    const obj = JSON.parse(readFileSync(cp, 'utf8'));
    if (typeof obj.total_usd === 'number' && typeof obj.last_line_offset === 'number') {
      return obj;
    }
  } catch { /* malformed cache */ }
  return null;
}

// ── writeSpendCache ───────────────────────────────────────────────────

function writeSpendCache(total_usd, last_line_offset, project_totals = {}) {
  const cp = spendCachePath();
  try {
    mkdirSync(dirname(cp), { recursive: true });
    writeFileSync(cp, JSON.stringify({ updated_at: new Date().toISOString(), total_usd, last_line_offset, project_totals }), 'utf8');
  } catch (e) { process.stderr.write('[x-build] writeSpendCache error: ' + (e?.message || e) + '\n'); }
}

// ── readLinesFromOffset ───────────────────────────────────────────────

function readLinesFromOffset(filePath, offset) {
  try {
    const fileSize = statSync(filePath).size;
    if (offset >= fileSize) return { text: '', endOffset: fileSize };
    const length = fileSize - offset;
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(filePath, 'r');
    let bytesRead;
    try {
      bytesRead = readSync(fd, buf, 0, length, offset);
    } finally {
      closeSync(fd);
    }
    return { text: buf.subarray(0, bytesRead).toString('utf8'), endOffset: fileSize };
  } catch {
    return { text: '', endOffset: offset };
  }
}

// ── scanMetrics ───────────────────────────────────────────────────────

function scanMetrics(config) {
  const projectBudgets = config.budget?.projects ?? {};
  const trackedProjectTotals = Object.keys(projectBudgets).length > 0;
  const windowHours = config.budget?.window_hours ?? null;
  const windowMs = windowHours != null ? Number(windowHours) * 3600000 : null;
  const cutoff = windowMs != null ? Date.now() - windowMs : null;

  const mp = metricsPath();
  let spent = 0;
  let projectSpentMap = {};

  if (!existsSync(mp)) return { spent, projectSpentMap };

  try {
    if (cutoff != null) {
      // Rolling window: must scan all lines to filter by timestamp — cache not applicable
      const lines = readFileSync(mp, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (typeof m.cost_usd === 'number') {
            const ts = typeof m.timestamp === 'number'
              ? m.timestamp
              : (m.timestamp ? new Date(m.timestamp).getTime() : 0);
            if (ts >= cutoff) {
              spent += m.cost_usd;
              if (trackedProjectTotals && m.project) {
                projectSpentMap[m.project] = (projectSpentMap[m.project] ?? 0) + m.cost_usd;
              }
            }
          }
        } catch { /* skip malformed */ }
      }
    } else {
      // No rolling window: use spend-cache for incremental reads
      const fileSize = statSync(mp).size;
      const cache = readSpendCache();

      let startOffset = 0;
      let cachedTotal = 0;
      let cachedProjectTotals = {};

      if (cache) {
        if (fileSize < cache.last_line_offset) {
          // File was rotated — invalidate cache, start from beginning
        } else {
          startOffset = cache.last_line_offset;
          cachedTotal = cache.total_usd;
          cachedProjectTotals = cache.project_totals ?? {};
        }
      }

      const { text: newText, endOffset } = readLinesFromOffset(mp, startOffset);
      let newSpend = 0;
      const newProjectSpend = {};
      if (newText) {
        for (const line of newText.split('\n')) {
          if (!line) continue;
          try {
            const m = JSON.parse(line);
            if (typeof m.cost_usd === 'number') {
              newSpend += m.cost_usd;
              if (trackedProjectTotals && m.project) {
                newProjectSpend[m.project] = (newProjectSpend[m.project] ?? 0) + m.cost_usd;
              }
            }
          } catch { /* skip malformed */ }
        }
      }

      spent = cachedTotal + newSpend;

      // Merge project totals
      projectSpentMap = { ...cachedProjectTotals };
      for (const [proj, val] of Object.entries(newProjectSpend)) {
        projectSpentMap[proj] = (projectSpentMap[proj] ?? 0) + val;
      }

      writeSpendCache(spent, endOffset, projectSpentMap);
    }
  } catch (e) { process.stderr.write('[x-build] checkBudget read error: ' + (e?.message || e) + '\n'); }

  return { spent, projectSpentMap };
}

// ── evaluateBudget ────────────────────────────────────────────────────

function evaluateBudget(spent, budget, additionalCost) {
  const projected = spent + additionalCost;
  const pct = projected / budget * 100;
  if (projected > budget) {
    return { ok: false, spent, projected, budget, pct, level: 'exceeded' };
  }
  if (pct > 80) {
    return { ok: true, spent, projected, budget, pct, level: 'warning' };
  }
  return { ok: true, spent, projected, budget, pct, level: 'normal' };
}

// ── mergeProjectBudget ────────────────────────────────────────────────

function mergeProjectBudget(globalResult, projectSpentMap, projectLimit, project, additionalCost) {
  const projSpent = projectSpentMap[project] ?? 0;
  const projectResult = { ...evaluateBudget(projSpent, projectLimit, additionalCost), project };

  // Return the more restrictive result (prefer not-ok, then higher pct)
  const globalPct = globalResult.pct;
  if (!projectResult.ok && globalResult.ok) return projectResult;
  if (!globalResult.ok && projectResult.ok) return globalResult;
  // Both ok or both not-ok: return whichever has higher pct (more restrictive)
  return projectResult.pct >= globalPct ? projectResult : globalResult;
}

// ── checkBudget ───────────────────────────────────────────────────────

export function checkBudget(additionalCost = 0, project = null) {
  const config = loadSharedConfig();
  const budget = Number(config.budget?.max_usd);
  if (!budget || isNaN(budget)) return { ok: true, budget: null };

  const projectBudgets = config.budget?.projects ?? {};
  const projectLimit = project != null ? Number(projectBudgets[project]) : NaN;
  const hasProjectLimit = project != null && !isNaN(projectLimit) && projectLimit > 0;

  const { spent, projectSpentMap } = scanMetrics(config);
  const globalResult = evaluateBudget(spent, budget, additionalCost);

  if (hasProjectLimit) {
    return mergeProjectBudget(globalResult, projectSpentMap, projectLimit, project, additionalCost);
  }

  return globalResult;
}
