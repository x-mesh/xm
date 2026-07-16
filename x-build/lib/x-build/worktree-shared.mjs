/**
 * x-build/worktree-shared — leaf module for the worktree pipeline.
 *
 * Why this module exists (circular-import relief, t10 §4):
 *   tasks.mjs and worktrees.mjs used to import from each other (worktrees needed
 *   `isParallelSafe`/`normalizeExpectedFiles` from tasks; tasks needed
 *   `WORKTREE_STATUS`/`readRun`/`worktreesDir` from worktrees). That bidirectional
 *   edge put `WORKTREE_STATUS` in TDZ whenever worktrees.mjs was the graph entry
 *   (a test importing it directly), forcing the lazy-binding workaround in
 *   tasks.mjs. Separately, unifying gate-panel's policy config onto
 *   `loadWorktreeConfig` would have created a second cycle (gate-panel →
 *   worktrees → gate-panel).
 *
 * The fix: the pieces shared across modules live here, and this module imports
 * ONLY from core.mjs + shared-config.mjs (both leaves). The graph becomes a DAG:
 *
 *     core.mjs / shared-config.mjs
 *            ↓
 *     worktree-shared.mjs
 *        ↓          ↓
 *   gate-panel.mjs  worktrees.mjs → gate-panel.mjs
 *                        ↓
 *   tasks.mjs → worktree-shared.mjs, worktrees.mjs
 *
 * No module imported here imports back, so there is no import cycle and no TDZ.
 */

import { resolve, join, ROOT, readJSON, execSync } from './core.mjs';
import { readSharedConfig } from '../shared-config.mjs';

// ── input validation (shared trust-boundary guard) ───────────────────
//
// project / task-id segments flow into filesystem paths (artifact writes) and
// into gk argv/gate command templates. Validate them at the trust boundary so a
// value like `../x` (path traversal) or `--flag` (argv injection) is rejected
// before it reaches join()/spawnSync. Leading `_` is allowed so the reserved
// integration id `__integration__` passes; `..` is rejected outright.
const ID_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Validate an id segment (project / task id). Returns an error string when the
 * value is unsafe, or null when it is acceptable. Callers decide how to surface
 * the failure (CLI → exit 2; library → throw).
 */
export function validateIdSegment(value, label = 'value') {
  if (typeof value !== 'string' || !value) return `${label} is required`;
  if (value.includes('..')) return `${label} must not contain ".."`;
  if (!ID_SEGMENT_RE.test(value)) {
    return `${label} contains invalid characters (allowed: letters, digits, and . _ -, no leading . or -)`;
  }
  return null;
}

// ── main repo root resolution (worktree-safe) ────────────────────────
//
// A finish/gate/resume can run from a LINKED worktree cwd whose local `.xm/` is
// NOT the canonical project state. `git rev-parse --git-common-dir` resolves to
// the shared .git of the main repo from any linked worktree, so the main repo
// root is its parent. Returns null when cwd is not a git repo (caller falls back
// to cwd). This is the single source both gate-panel and worktrees use so the
// resolution never diverges.
export function resolveMainRepoRoot(cwd = process.cwd()) {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (commonDir) return resolve(cwd, commonDir, '..');
  } catch {
    // Not a git repo / git unavailable — caller falls back to cwd.
  }
  return null;
}

// ── expected_files utils (worktree parallel-batching signal) ─────────
//
// Plan-phase produces per-task `expected_files[]` so the worktree pipeline can
// decide which ready tasks are safe to run in parallel. Canonical rule is
// "when in doubt, run sequentially": a task with no/empty expected_files, or one
// whose files intersect another task's, is NOT parallel-safe.

// Coerce a task's expected_files into a clean string[] regardless of how it was
// stored (missing, null, non-array, dirty entries). Backward compatible: tasks
// written before this field existed normalize to [].
export function normalizeExpectedFiles(expected) {
  if (!Array.isArray(expected)) return [];
  return expected
    .filter(f => typeof f === 'string' && f.trim())
    .map(f => normalizeRelPath(f.trim()));
}

// Canonicalize a repo-relative path for overlap comparison so `./src/a.mjs`,
// `src//a.mjs` and `src/a.mjs` collide instead of slipping into the same
// parallel batch. Pure string normalization — no filesystem access.
function normalizeRelPath(p) {
  const segs = p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
  const out = [];
  for (const s of segs) {
    if (s === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

// Return the intersection of two tasks' expected_files (the files both touch).
// Empty array = no known overlap.
export function expectedFilesOverlap(taskA, taskB) {
  const a = normalizeExpectedFiles(taskA?.expected_files);
  const b = new Set(normalizeExpectedFiles(taskB?.expected_files));
  return a.filter(f => b.has(f));
}

// Partition tasks into parallel-safe vs sequential based on expected_files.
// Rules (canonical: unknown → sequential):
//   - no/empty expected_files          → sequential
//   - expected_files intersects another → sequential (both sides)
//   - otherwise                         → safe
// Returns { safe: string[], sequential: string[], reason: string }.
export function isParallelSafe(tasks) {
  const safe = [];
  const sequential = [];
  const reasons = [];
  const withFiles = [];

  for (const t of tasks || []) {
    const ef = normalizeExpectedFiles(t.expected_files);
    if (ef.length === 0) {
      sequential.push(t.id);
      reasons.push(`${t.id}: no expected_files (unknown → sequential)`);
    } else {
      withFiles.push(t);
    }
  }

  const overlapping = new Set();
  for (let i = 0; i < withFiles.length; i++) {
    for (let j = i + 1; j < withFiles.length; j++) {
      const ov = expectedFilesOverlap(withFiles[i], withFiles[j]);
      if (ov.length) {
        overlapping.add(withFiles[i].id);
        overlapping.add(withFiles[j].id);
        reasons.push(`${withFiles[i].id} ∩ ${withFiles[j].id}: ${ov.join(', ')}`);
      }
    }
  }

  for (const t of withFiles) {
    if (overlapping.has(t.id)) sequential.push(t.id);
    else safe.push(t.id);
  }

  return { safe, sequential, reason: reasons.join('; ') };
}

// ── build root (call-time) ───────────────────────────────────────────
// core.ROOT is captured at import time, so a test/orchestrator that sets
// X_BUILD_ROOT after some other module already imported core would silently
// resolve the wrong root. Resolve the env at call time instead.
export function buildRoot() {
  return process.env.X_BUILD_ROOT ? resolve(process.env.X_BUILD_ROOT) : ROOT;
}

// ── config (unified worktree.* resolution) ───────────────────────────
//
// Config Resolution Priority (plan "config 제안" / t10 §3):
//   CLI flag > `.xm/build/config.json` (build-local) > `.xm/config.json`
//   (shared) > WORKTREE_CONFIG_DEFAULTS.
//
// Historically two readers diverged: gate-panel read `worktree.gate_policy` from
// the build-local `.xm/build/config.json`, while loadWorktreeConfig read
// `worktree.*` from the shared `.xm/config.json`. They now go through this one
// function, and a value in EITHER location works (backward compatible).

export const WORKTREE_CONFIG_DEFAULTS = {
  enabled: true,
  base: 'develop',
  branch_prefix: 'feat/',
  max_parallel: 4,
  gate: 'panel',
  gate_phase: 'before',
  // Default calibration (docs/worktree-gate-optimization-plan.md §3A): per-task
  // gates block critical/high only — confirmed medium becomes advisory (recorded,
  // never dropped) and the `release` phase overlay re-adds it so the pre-release
  // integration review still blocks on medium. Phase overlay keys merge as single
  // keys across layers (a layer's overlay replaces the lower layer's wholesale).
  gate_policy: {
    block_confirmed: ['critical', 'high'],
    block_unreviewed: ['critical', 'high'],
    block_contested: ['critical'],
    allow_low: true,
    release: { block_confirmed: ['critical', 'high', 'medium'] },
  },
  // Round cap (plan §3E): past this many consecutive panel-fail rounds for a
  // task+phase, medium demotes from blocking to advisory (critical/high never
  // demote). 0 = no cap. Default 2 comes from one measured dogfooding case —
  // configurable, revisit when more data lands.
  gate_max_rounds: 2,
  // Pre-gate (plan §3F): cheap command template run BEFORE the expensive panel
  // ({patch} substituted; exit 0 = proceed, 1 = fail-fast block, ≥2 = warn +
  // proceed). null = disabled.
  pre_gate: null,
  preflight: true,
  cleanup: true,
  // Patch-size guard for review-integration. null = no cap (plan: the number
  // must come from measured panel-quality degradation, not judgment — L9).
  review_integration_max_bytes: null,
  // Backoff (ms) before retrying a finish that hit a target-merge gate lock.
  // Centralized here so it resolves through config like every other worktree key
  // (was an inline `?? 250` in worktrees.mjs).
  gate_lock_backoff_ms: 250,
};

// Read the raw `worktree` sub-objects from both config layers (no defaults
// applied). Used both by loadWorktreeConfig (merge) and by
// worktreeGatePolicyConfigured (provenance) so there is a single reader.
function readWorktreeLayers(buildRootDir) {
  let shared = {};
  try {
    const sc = readSharedConfig();
    if (sc && typeof sc.worktree === 'object' && sc.worktree) shared = sc.worktree;
  } catch { shared = {}; }

  let local = {};
  try {
    const bc = readJSON(join(buildRootDir || buildRoot(), 'config.json'));
    if (bc && typeof bc.worktree === 'object' && bc.worktree) local = bc.worktree;
  } catch { local = {}; }

  return { shared, local };
}

// Apply run-level CLI flag overrides (highest priority). Mutates + returns cfg.
function applyFlags(cfg, flags = {}) {
  if (typeof flags.base === 'string') cfg.base = flags.base;
  if (typeof flags.branch_prefix === 'string') cfg.branch_prefix = flags.branch_prefix;
  if (flags.max_parallel != null && flags.max_parallel !== true) cfg.max_parallel = Number(flags.max_parallel);
  if (typeof flags.gate === 'string') cfg.gate = flags.gate;
  if (typeof flags.gate_phase === 'string') cfg.gate_phase = flags.gate_phase;
  if (typeof flags.enabled === 'boolean') cfg.enabled = flags.enabled;
  if (typeof flags.cleanup === 'boolean') cfg.cleanup = flags.cleanup;
  return cfg;
}

/**
 * Resolve the effective worktree config. Layering (low → high):
 *   WORKTREE_CONFIG_DEFAULTS ← shared `.xm/config.json`.worktree
 *   ← build-local `.xm/build/config.json`.worktree ← CLI flags.
 * gate_policy is merged per-key across every layer (not wholesale-replaced), so
 * a layer can override one severity list without dropping the others.
 *
 * @param {{ flags?: object, buildRootDir?: string|null }} [opts]
 */
export function loadWorktreeConfig({ flags = {}, buildRootDir = null } = {}) {
  const { shared, local } = readWorktreeLayers(buildRootDir);
  const merged = { ...WORKTREE_CONFIG_DEFAULTS, ...shared, ...local };
  merged.gate_policy = {
    ...WORKTREE_CONFIG_DEFAULTS.gate_policy,
    ...(shared.gate_policy || {}),
    ...(local.gate_policy || {}),
  };
  return applyFlags(merged, flags);
}

/**
 * True when EITHER config layer explicitly set a `worktree.gate_policy`. Used by
 * gate-panel to record `policy_overridden` without treating the default policy
 * (always present after merge) as an override.
 */
export function worktreeGatePolicyConfigured(buildRootDir = null) {
  const { shared, local } = readWorktreeLayers(buildRootDir);
  return !!(shared.gate_policy || local.gate_policy);
}
