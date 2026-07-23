/**
 * x-build/core — Shared utilities, constants, and helpers
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync, renameSync, statSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { loadSharedConfig as _loadSharedConfig } from './config-loader.mjs';
import { SCHEMA } from '../config-schema.mjs';
import { resolveXmRoot } from './xm-root.mjs';
import {
  commandDescriptor, contentFingerprint, readPersistedSerialQualityEvidence,
  resolveEffectiveQualityConfig, runQualityPipeline, validateEvidence,
} from './quality-pipeline.mjs';

// Re-export node modules that sub-modules need
export { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync, renameSync, statSync, unlinkSync, realpathSync };
export { join, resolve, dirname, basename };
export { fileURLToPath };
export { createInterface };
export { execSync, spawnSync };
export { homedir, tmpdir };

// ── ROOT / PLUGIN_ROOT resolution ───────────────────────────────────

const __filename_core = fileURLToPath(import.meta.url);
const __dirname_core = dirname(__filename_core);

// ROOT resolution:
// 1. X_BUILD_ROOT env var (explicit override)
// 2. --global flag → ~/.xm/build/
// 3. default → cwd/.xm/build/, or the main repo's .xm/build/ (via
//    resolveXmRoot's git-common-dir walk-up) when cwd has no local .xm/ —
//    keeps subdirectories and worktrees from spawning a stray .xm/
export const XM_GLOBAL = process.argv.includes('--global');
export const ROOT = process.env.X_BUILD_ROOT
  ? resolve(process.env.X_BUILD_ROOT)
  : XM_GLOBAL
    ? resolve(homedir(), '.xm', 'build')
    : resolve(resolveXmRoot(), 'build');

// PLUGIN_ROOT: where templates and defaults live
// Original: resolve(__dirname, '..') from x-build-cli.mjs which is at xm/lib/
// From xm/lib/x-build/core.mjs we need to go up two levels: x-build/ -> lib/ -> xm/
export const PLUGIN_ROOT = resolve(__dirname_core, '..', '..');

// repoRoot: the user's project/repo root. ROOT is `<repo>/.xm/build`, so the
// repo root is two levels up. Every place that runs git or user scripts must
// use repoRoot(), NOT the old `resolve(ROOT, '..')` (= `<repo>/.xm`, one level
// short — it only worked by accident because git/npm walk upward to find
// `.git`/`package.json`).
// Single source of truth shared with later.mjs (workspaceRoot) and verify.mjs.
export function repoRoot() {
  return resolve(ROOT, '..', '..');
}

// ── CLI exit / library mode ──────────────────────────────────────────
// exitFail() replaces bare `process.exit(1)` in command/guard functions.
// In CLI mode (default) it exits the process exactly as before — byte-identical
// behavior, zero regression. An in-process caller (e.g. a long-running server)
// can call setLibraryMode(true) so guard failures throw CliError instead of
// killing the host process, then catch it. Guards print their reason via
// console.error before calling exitFail(); pass that reason as the optional
// `message` so a library caller can recover it from CliError without scraping
// stderr (existing call sites omit it and fall back to a generic message).
export class CliError extends Error {
  constructor(code = 1, message) {
    super(message || `x-build exited with code ${code}`);
    this.name = 'CliError';
    this.code = code;
  }
}

let LIBRARY_MODE = false;
export function setLibraryMode(on) { LIBRARY_MODE = !!on; }
export function exitFail(code = 1, message) {
  if (LIBRARY_MODE) throw new CliError(code, message);
  process.exit(code);
}

// ── Constants ────────────────────────────────────────────────────────

export const PHASES = [
  { id: '01-research', name: 'research', label: 'Research' },
  { id: '02-plan',     name: 'plan',     label: 'Plan' },
  { id: '03-execute',  name: 'execute',  label: 'Execute' },
  { id: '04-verify',   name: 'verify',   label: 'Verify' },
  { id: '05-close',    name: 'close',    label: 'Close' },
];

export const TASK_STATES = {
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const STATUS_ALIASES = {
  in_progress: 'running',
  done: 'completed',
  complete: 'completed',
  cancel: 'cancelled',
  fail: 'failed',
  todo: 'pending',
};

export const GATE_TYPES = ['auto', 'human-verify', 'human-action', 'quality', 'decision'];

// A gate that halts until a human runs `x-build gate pass`. Two types qualify, and
// they differ ONLY in how autopilot treats them: `human-verify` is a confirmation
// ("proceed?") and autopilot downgrades it to `auto`; `decision` is a direction
// approval ("is this plan what you actually asked for?") and autopilot must NOT
// touch it. Quality gates catch code that is wrong; only a decision gate catches
// code that is correct but built toward the wrong goal.
export function requiresSignoff(gateType) {
  return gateType === 'human-verify' || gateType === 'decision';
}

// ── ANSI Colors ──────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
export const C = isTTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
} : Object.fromEntries(['reset','bold','dim','red','green','yellow','blue','magenta','cyan'].map(k => [k, '']));

export function renderBar(done, total, width = 20) {
  if (total === 0) return `[${C.dim}${'░'.repeat(width)}${C.reset}] 0%`;
  const ratio = done / total;
  const filled = Math.round(ratio * width);
  const pct = Math.round(ratio * 100);
  return `[${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(width - filled)}${C.reset}] ${pct}% ${done}/${total}`;
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── File I/O Helpers ─────────────────────────────────────────────────

export function readJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Try .bak recovery
    const bak = path + '.bak';
    if (existsSync(bak)) {
      try {
        const recovered = JSON.parse(readFileSync(bak, 'utf8'));
        console.error(`  ${C.yellow}⚠ Corrupted JSON: ${basename(path)} — recovered from .bak${C.reset}`);
        writeFileSync(path, readFileSync(bak, 'utf8'));
        return recovered;
      } catch { /* bak also corrupted */ }
    }
    console.error(`  ${C.red}⚠ Failed to parse ${basename(path)}: ${err.message}${C.reset}`);
    return null;
  }
}

export function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/**
 * Atomic read-modify-write with file locking.
 * Use for high-contention files (e.g., tasks.json) where parallel agents
 * may read-modify-write simultaneously.
 * @param {string} path - JSON file path
 * @param {function} mutator - fn(data) => mutated data (or mutate in place)
 * @returns {*} the data after mutation
 */
export function modifyJSON(path, mutator) {
  const lockPath = path + '.lock';

  // Acquire the lock FIRST (separate from running the mutator), so a mutator's
  // CliError propagates cleanly instead of being mistaken for lock contention.
  let acquired = false;
  for (let attempt = 0; attempt < 50 && !acquired; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // unexpected fs error — surface it
      // Reclaim a lock left behind by a crashed process (mtime older than 10s).
      // Without this, one stale .lock degraded every later write forever.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10000) { unlinkSync(lockPath); continue; }
      } catch { continue; /* lock vanished between stat and now — retry immediately */ }
      // Lock genuinely held by a live writer — brief spin, then retry.
      const deadline = Date.now() + 20;
      while (Date.now() < deadline) { /* spin */ }
    }
  }

  if (!acquired) {
    // Fail loud (L6): never silently write unlocked — a concurrent writer may be
    // mid-update and an unlocked write would clobber it. Surface the contention.
    process.stderr.write(`[x-build] modifyJSON: lock contention on ${path} — could not acquire ${lockPath} after 50 attempts.\n`);
    process.stderr.write(`           If a process crashed, remove the stale lock: rm ${JSON.stringify(lockPath)}\n`);
    throw new Error(`modifyJSON: could not acquire lock for ${path}`);
  }

  try {
    const data = readJSON(path);
    const result = mutator(data);
    const out = result !== undefined ? result : data;
    writeJSON(path, out);
    return out;
  } finally {
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

export function readMD(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

export function writeMD(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

// ── Config ───────────────────────────────────────────────────────────

export function loadConfig() {
  return readJSON(join(ROOT, 'config.json')) || {};
}

// Delegates to config-loader's single tiered-merge resolver (빌드5). This used to
// be a private first-match copy that returned local OR global (never merged), so a
// project .xm/config.json shadowed the entire global config here too. One resolver
// now — core, cost-engine, drift, and shared-config all combine tiers identically.
export function loadSharedConfig() {
  return _loadSharedConfig();
}

export function readSharedConfig() {
  return loadSharedConfig();
}

// Phase-exit gate defaults, sourced from the config-schema registry (group
// 'gates') so the two never drift. Computed once at module load.
export const GATE_DEFAULTS = (() => {
  const out = {};
  for (const e of SCHEMA) {
    if (e.group === 'gates' && typeof e.key === 'string' && e.key.startsWith('gates.')) {
      out[e.key.slice('gates.'.length)] = e.default;
    }
  }
  return out;
})();

// Resolve the effective gate type for every phase exit: schema defaults ← shared
// config (.xm, global+local merged by 빌드5) ← build-local (.xm/build/config.json).
//
// Before 빌드1, phaseNext / cmdStatus / getPhaseActions each read
// `config.gates?.[key] || 'auto'` from loadConfig() = `.xm/build/config.json`, a
// file nothing writes — so EVERY gate silently resolved to 'auto', discarding both
// the human-verify/quality schema defaults AND any `xm config set gates.*` (which
// writes to the shared `.xm/config.json`). One resolver now feeds all consumers, so
// a configured gate is actually honored and the marquee "gate the agent cannot talk
// past" is no longer a no-op. Returns { [gateName]: type }.
// Both config layers may be injected. Production callers pass nothing and get the
// on-disk config; tests pass explicit objects so a gate assertion never depends on
// whatever `.xm/config.json` another test file happened to leave behind (that
// coupling made the autopilot suite fail differently on every run).
export function resolveGates(sharedIn, buildLocalIn) {
  const shared = sharedIn !== undefined ? sharedIn : loadSharedConfig();
  const sharedGates = (shared && typeof shared.gates === 'object' && shared.gates) ? shared.gates : {};
  const buildLocal = buildLocalIn !== undefined ? buildLocalIn : loadConfig();
  const buildGates = (buildLocal && typeof buildLocal.gates === 'object' && buildLocal.gates) ? buildLocal.gates : {};
  const merged = { ...GATE_DEFAULTS, ...sharedGates, ...buildGates };

  // Autopilot overlay (highest precedence): downgrade every human-verify gate to
  // auto so phase transitions stop blocking on `gate pass`. `quality` and `decision`
  // gates are left untouched on purpose — a failing test/lint/build must still halt
  // the pipeline, and a direction approval is not a confirmation prompt. Those two
  // are the safety floor that separates autopilot from "blind run": quality catches
  // wrong code, decision catches correct code built toward the wrong goal.
  if (autopilotActive(shared, buildLocal)) {
    for (const k of Object.keys(merged)) {
      if (merged[k] === 'human-verify') merged[k] = 'auto';
    }
  }
  return merged;
}

// Autopilot is active when the XMB_AUTOPILOT env var is set (one-shot, wins over
// config) OR the `autopilot` config key is true in either the shared (.xm) or
// build-local layer. Accepts already-loaded config objects to avoid re-reading.
export function autopilotActive(shared, buildLocal) {
  const env = process.env.XMB_AUTOPILOT;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false; // explicit off overrides config
  const s = shared !== undefined ? shared : loadSharedConfig();
  if (s?.autopilot === true) return true;
  const b = buildLocal !== undefined ? buildLocal : loadConfig();
  if (b?.autopilot === true) return true;
  return false;
}

export function writeSharedConfig(data) {
  const sharedPath = join(ROOT, '..', 'config.json');
  writeJSON(sharedPath, data);
}

export function getMode() {
  // Mode follows the same effective-config precedence as every other shared
  // setting: global ~/.xm/config.json under local .xm/config.json. Reading the
  // global file directly made a project's explicit normal mode invisible to
  // x-build's own output layer.
  const shared = loadSharedConfig();
  if (shared?.mode) return shared.mode;
  return 'developer';
}

export function getAgentCount() {
  const shared = loadSharedConfig();
  return shared.agent_max_count ?? 4;
}

export function isNormalMode() {
  return getMode() === 'normal';
}

// Normal mode label mappings (simple language)
export const NORMAL_LABELS = {
  'Research': '조사하기',
  'Plan': '계획 세우기',
  'Execute': '실행하기',
  'Verify': '확인하기',
  'Close': '마무리',
  'auto': '자동',
  'human-verify': '직접 확인',
  'human-action': '직접 작업',
  'quality': '품질 검사',
  'decision': '방향 승인',
  'pending': '대기 중',
  'ready': '준비됨',
  'running': '진행 중',
  'completed': '완료',
  'failed': '실패',
  'cancelled': '취소됨',
  'small': '간단',
  'medium': '보통',
  'large': '복잡',
};

export function L(key) {
  return isNormalMode() ? (NORMAL_LABELS[key] || key) : key;
}

// Error message pairs: [english, korean]
const ERROR_MESSAGES = {
  'no-project':       ['No project found. Run: x-build init <project-name>', '프로젝트가 없습니다. x-build init <이름> 으로 만드세요.'],
  'project-not-found':['Project "${name}" not found.', '"${name}" 프로젝트를 찾을 수 없습니다.'],
  'invalid-phase':    ['Invalid current phase in manifest.', '현재 단계 정보가 올바르지 않습니다.'],
  'task-not-found':   ['Task "${id}" not found.', '"${id}" 할 일을 찾을 수 없습니다.'],
  'unknown-phase':    ['Unknown phase: "${name}".', '알 수 없는 단계: "${name}".'],
};

export function E(key, vars = {}) {
  const pair = ERROR_MESSAGES[key];
  if (!pair) return key;
  let msg = isNormalMode() ? pair[1] : pair[0];
  for (const [k, v] of Object.entries(vars)) {
    msg = msg.replace(`\${${k}}`, v);
  }
  return msg;
}

// ── Path Helpers ─────────────────────────────────────────────────────

export function projectsDir() {
  return join(ROOT, 'projects');
}

export function projectDir(name) {
  return join(projectsDir(), name);
}

export function manifestPath(name) {
  return join(projectDir(name), 'manifest.json');
}

export function phaseDir(project, phaseId) {
  return join(projectDir(project), 'phases', phaseId);
}

export function phaseStatusPath(project, phaseId) {
  return join(phaseDir(project, phaseId), 'status.json');
}

export function tasksPath(project) {
  return join(phaseDir(project, '02-plan'), 'tasks.json');
}

export function stepsPath(project) {
  return join(phaseDir(project, '02-plan'), 'steps.json');
}

export function prdPath(project) {
  return join(phaseDir(project, '02-plan'), 'PRD.md');
}

export function checkpointsDir(project) {
  return join(projectDir(project), 'checkpoints');
}

export function contextDir(project) {
  return join(projectDir(project), 'context');
}

export function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
}

export function archiveDir(project) {
  return join(projectDir(project), 'archive');
}

export function decisionsPath(project) {
  return join(contextDir(project), 'decisions.json');
}

// ── Cost Engine (re-exports) ─────────────────────────────────────────
export { MODEL_COSTS, MODEL_PROFILES, ROLE_MODEL_MAP_HR, ROLE_ALIASES, resolveRole, PHASE_ROLE_GROUPS, SIZE_TOKEN_ESTIMATES, STRATEGY_MULTIPLIERS, INHERIT_MODEL, JUDGMENT_ROLES, getModelForRole, getModelForRoleWithCorrelation, generateCorrelationId, estimateTaskCost, costFromTokens, checkBudget, downgradeBudgetModel, appendCostEvent, appendMetric, metricsPath, METRICS_MAX_BYTES, COST_EVENT_MAX_BYTES, EVENT_SCHEMA_VERSION, adaptEvent, VENDOR_MODELS, MODEL_EFFORT_LEVELS, MODEL_COSTS_BY_VENDOR, parseModelSpec, resolveVendorModel, costFromTokensVendor, computeTokenActuals, loadTokenActuals, cmdForecastUpdate, aggregateRoi, roiSuggestion, readTaskMetrics, ROI_MIN_SAMPLES, COST_PREDICTION_MIN_SAMPLES, COST_PREDICTION_JACCARD_THRESHOLD, predictTaskCost, formatCostPrediction } from './cost-engine.mjs';

// ── Lifecycle Hooks ──────────────────────────────────────────────────

export function emitHook(event, payload) {
  const config = loadConfig();
  const hooks = (config.hooks || []).filter(h => h.event === event || h.event === '*');
  for (const h of hooks) {
    try {
      const input = JSON.stringify({ event, ...payload, timestamp: new Date().toISOString() });
      if (h.exec.endsWith('.mjs')) {
        spawnSync(process.execPath, [h.exec], { input, stdio: ['pipe', 'inherit', 'inherit'], cwd: repoRoot() });
      } else {
        spawnSync(h.exec, [], { input, stdio: ['pipe', 'inherit', 'inherit'], shell: true, cwd: repoRoot() });
      }
    } catch { /* hook errors are non-fatal */ }
  }
}

// ── Project Resolution ──────────────────────────────────────────────

export function findCurrentProject() {
  const candidates = findActiveProjects();
  return candidates[0]?.name || null;
}

// Returns all projects with a valid manifest, sorted by manifest file mtime descending.
// Using mtime (not updated_at) handles direct manifest edits that skip the CLI update path.
// findCurrentProject() returns the first entry; callers that want disambiguation
// (e.g., status display) iterate the full list.
export function findActiveProjects() {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  const projects = readdirSync(dir).filter(d => existsSync(manifestPath(d)));
  if (projects.length === 0) return [];
  return projects
    .map(p => ({ name: p, manifest: readJSON(manifestPath(p)) }))
    .filter(p => p.manifest)
    .sort((a, b) => {
      try {
        const diff = statSync(manifestPath(b.name)).mtimeMs - statSync(manifestPath(a.name)).mtimeMs;
        if (diff !== 0) return diff;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      } catch {
        return new Date(b.manifest.updated_at || 0) - new Date(a.manifest.updated_at || 0);
      }
    });
}

// NOTE: resolveProject needs cmdInit for autoInit, which creates a circular dep.
// We use a late-bound reference that project.mjs will set.
let _cmdInit = null;
export function setCmdInit(fn) { _cmdInit = fn; }

// Top-level `--project <name>` overrides findCurrentProject() so writes never
// land on the wrong active project when multiple are open. Set by the CLI
// dispatcher right after extractFlags(); cleared between in-process runs is
// not needed because each `node` invocation owns its own module state.
let _explicitProject = null;
export function setExplicitProject(name) { _explicitProject = name || null; }
export function getExplicitProject() { return _explicitProject; }

export function resolveProject(explicit, { autoInit = false } = {}) {
  const name = explicit || _explicitProject || findCurrentProject();
  if (!name) {
    console.error(`❌ ${E('no-project')}`);
    exitFail(1);
  }
  if (!existsSync(manifestPath(name))) {
    if (autoInit && _cmdInit) {
      console.error(`⚡ Project "${name}" not found — auto-initializing...`);
      return _cmdInit([name]);
    }
    console.error(`❌ ${E('project-not-found', { name })}`);
    exitFail(1);
  }
  return name;
}

export function resolveProjectDir(name) {
  return projectDir(resolveProject(name));
}

// ── Git Integration ──────────────────────────────────────────────────

function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe', cwd: repoRoot() });
    return true;
  } catch { return false; }
}

export function gitAutoCommit(project, task, phase) {
  if (!isGitRepo()) return null;
  const config = loadConfig();
  if (config.git?.auto_commit === false) return null;

  try {
    const cwd = repoRoot();

    // Stage only this project's tracking files (X-8). Previously `git add -A`
    // swept the entire working tree, which caused two distinct failures:
    //   1. user's in-progress edits got swallowed into task commits
    //   2. test/core-unit.test.mjs gitAutoCommit tests, invoked from cwd=repo,
    //      committed unstaged changes back to the host repo on every `bun test`
    // Scoping the add to projectDir means: .xm/-gitignored repos commit nothing
    // (which is correct), and other repos only get the metadata + whatever the
    // user themselves staged.
    const pdir = projectDir(project);
    try {
      execSync(`git add ${JSON.stringify(pdir)}`, { stdio: 'pipe', cwd });
    } catch { /* path may be ignored or absent — fine */ }

    const diff = execSync('git diff --cached --name-only', { stdio: 'pipe', cwd }).toString().trim();
    if (!diff) return null;

    // Skip metadata-only commits — when only x-build tracking files changed, no real code work happened.
    // Without this guard the CLI emits a commit per metadata flip, polluting history with
    // empty "[COMPLETED]" entries.
    const stagedFiles = diff.split('\n').filter(Boolean);
    const allMetadata = stagedFiles.every(f => f.startsWith('.xm/'));
    if (allMetadata) return null;

    const msg = `tm(${phase}/${task.id}): ${task.name} [${task.status.toUpperCase()}]`;
    execSync(`git commit -m ${JSON.stringify(msg)}`, { stdio: 'pipe', cwd });
    const sha = execSync('git rev-parse HEAD', { stdio: 'pipe', cwd }).toString().trim();
    return sha;
  } catch { return null; }
}

export function gitRollbackTask(task) {
  if (!isGitRepo() || !task.commit_sha) return false;
  const cwd = repoRoot();

  // Validate sha BEFORE any side effects (X-9). Previously this function ran
  // `git stash push` then `git reset --hard`; if the sha was invalid (e.g.,
  // test fixture passing 'deadbeef'), the reset failed but the stash stayed
  // behind, silently burying the user's working-tree changes. Now we verify
  // the sha first and bail out cleanly.
  try {
    execSync(`git rev-parse --verify ${JSON.stringify(task.commit_sha + '^{commit}')}`, { stdio: 'pipe', cwd });
  } catch { return false; }

  // Blast-radius guard (F2): `git reset --hard <sha>` rewinds HEAD and discards
  // EVERY commit made after <sha> — in a multi-task DAG run that silently throws
  // away later tasks' commits. Only proceed when commit_sha is the current HEAD,
  // so the reset merely drops uncommitted/working-tree changes (already stashed
  // below) and never deletes intervening history. If HEAD has moved on, refuse
  // and let the caller resolve manually instead of losing work.
  let head;
  try {
    head = execSync('git rev-parse HEAD', { stdio: 'pipe', cwd }).toString().trim();
  } catch {
    console.error(`  ${C.yellow}⚠ rollback skipped for ${task.id}: unable to read HEAD (git rev-parse failed).${C.reset}`);
    return false;
  }
  if (head !== task.commit_sha) {
    console.error(`  ${C.yellow}⚠ rollback skipped for ${task.id}: ${task.commit_sha.slice(0, 8)} is not HEAD — a hard reset would discard later commits. Resolve manually.${C.reset}`);
    return false;
  }

  let stashed = false;
  try {
    const out = execSync(`git stash push -m "tm-task-${task.id}-failed"`, { stdio: 'pipe', cwd }).toString();
    stashed = !/No local changes/.test(out);
    execSync(`git reset --hard ${task.commit_sha}`, { stdio: 'pipe', cwd });
    return true;
  } catch {
    // Restore the stash so callers don't lose work if reset somehow failed
    // after sha validation passed (e.g., concurrent ref change).
    if (stashed) {
      try { execSync('git stash pop', { stdio: 'pipe', cwd }); } catch { /* user must recover manually */ }
    }
    return false;
  }
}

// ── Quality Gate Runner ──────────────────────────────────────────────

export function runQualityChecks(project) {
  const config = resolveEffectiveQualityConfig(repoRoot());
  if (config.serial_quality_command || config.config_error) {
    const root = resolve(repoRoot());
    const outPath = join(phaseDir(project, '04-verify'), 'quality-results.json');
    // Consider both the previous Verify result and group-boundary evidence.
    // Only an exact candidate survives below, so a malformed/stale artifact
    // cannot force reuse or shadow a newer valid result.
    const candidates = [];
    const persisted = readPersistedSerialQualityEvidence(outPath);
    if (persisted.evidence) candidates.push(persisted.evidence);
    const groups = readJSON(join(phaseDir(project, '03-execute'), 'review-groups.json'));
    candidates.push(...Object.values(groups?.groups || {})
      .map((group) => group.group_quality?.serial_quality)
      .filter(Boolean));

    // A stale or malformed Verify artifact must not shadow newer exact group
    // evidence. Validate every candidate against the current command/env/cwd
    // and content fingerprint, then prefer the most recent exact record.
    let evidence = null;
    if (typeof config.serial_quality_command === 'string' && config.serial_quality_command) {
      const descriptor = commandDescriptor(config.serial_quality_command, root, config.serial_quality_env || {});
      const fingerprint = contentFingerprint(root);
      const expected = { cwd: root, command_hash: descriptor.command_hash, content_fingerprint: fingerprint };
      evidence = candidates
        .filter((candidate) => validateEvidence(candidate, expected).valid)
        .sort((a, b) => Date.parse(b.checked_at || '') - Date.parse(a.checked_at || ''))[0] || null;
    }
    const result = runQualityPipeline({ cwd: root, config, evidence });
    for (const [name, script] of Object.entries(config.gate_scripts || {})) {
      const out = spawnSync(script, [], { shell: true, cwd: repoRoot(), stdio: 'pipe', timeout: 120000 });
      result.push({ check: name, passed: out.status === 0, failed: out.status !== 0, exit_code: out.status === 0 ? 0 : 2, output: (out.stderr || '').toString().slice(-2000) });
    }
    writeJSON(outPath, { timestamp: new Date().toISOString(), results: result, passed: result.every(r => r.passed) });
    return result;
  }
  return detectAndRunQualityChecks(project);
}

function detectPackageManager(cwd) {
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bunfig.toml'))) return 'bun';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function packageScriptCommand(packageManager, scriptName) {
  if (packageManager === 'bun') return `bun run ${scriptName}`;
  if (packageManager === 'pnpm') return `pnpm run ${scriptName}`;
  if (packageManager === 'yarn') return scriptName === 'test' ? 'yarn test' : `yarn ${scriptName}`;
  return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
}

function shouldSkipRecursiveTestScript(testScript) {
  return process.env.NODE_ENV === 'test' && /\bbun\s+test\b/.test(testScript);
}

// ── Project Kind Gauge ────────────────────────────────────────────────
// Four-signal deterministic classifier: does `cwd` already hold a real
// project (brownfield) or is it empty/new (greenfield)? Reports signals
// only — makes no judgment beyond the fixed decision rule below. Mirrors
// scripts/sim-project-kind.mjs exactly (0 misclassifications across 5 base
// + 2 edge fixtures); do not change signal definitions here without
// re-running that simulator.

const PK_MANIFEST_FILES = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'Gemfile', 'composer.json'];
const PK_WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'];
const PK_GRADLE_PREFIX = 'build.gradle'; // build.gradle, build.gradle.kts, ...
const PK_LOCKFILES = ['bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'poetry.lock', 'uv.lock', 'Cargo.lock', 'go.sum'];
const PK_SRC_DIR_NAMES = ['src', 'lib', 'app', 'cmd', 'internal'];
const PK_UPWARD_BOUND = 6;

function pkHasManifestAt(dir) {
  for (const f of PK_MANIFEST_FILES) if (existsSync(join(dir, f))) return true;
  for (const f of PK_WORKSPACE_MARKERS) if (existsSync(join(dir, f))) return true;
  try {
    for (const f of readdirSync(dir)) if (f.startsWith(PK_GRADLE_PREFIX)) return true;
  } catch { /* unreadable dir — treat as no manifest here */ }
  return false;
}

function pkManifestPresentUpward(startDir, maxLevels) {
  let dir = resolve(startDir);
  const visited = new Set(); // realpaths already checked — blocks symlink cycles
  for (let level = 0; level <= maxLevels; level++) {
    let real;
    try { real = realpathSync(dir); } catch { real = dir; }
    if (visited.has(real)) return { hit: false, level, reason: 'symlink-cycle' };
    visited.add(real);
    if (pkHasManifestAt(dir)) return { hit: true, level };
    const parent = dirname(dir);
    if (parent === dir) return { hit: false, level, reason: 'reached-fs-root' };
    dir = parent;
  }
  return { hit: false, level: maxLevels, reason: 'bound-exhausted' };
}

function pkLockfilePresent(dir) {
  return PK_LOCKFILES.some((f) => existsSync(join(dir, f)));
}

function pkHasAnyFileRecursive(dir, depth = 0) {
  if (depth > 20) return false; // pathological symlink loop guard
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile()) return true;
    if (e.isDirectory() && pkHasAnyFileRecursive(p, depth + 1)) return true;
  }
  return false;
}

function pkSourceTreePresent(dir) {
  for (const name of PK_SRC_DIR_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        if (statSync(p).isDirectory() && pkHasAnyFileRecursive(p)) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

// git-history-present, with the absence-vs-error distinction the decision
// rule depends on: no repo / 0 commits is a MISS (nothing wrong, just new);
// git itself failing to run (ENOENT, or any other unrecognized non-zero
// exit) is an ERROR that overrides the whole gauge to brownfield below —
// we cannot safely call an unreadable directory "new".
function pkGitHistorySignal(dir) {
  // --max-count=2 (F9): the decision rule only needs to know count > 1, so
  // cap rev-list's walk at 2 commits instead of enumerating full history.
  // LC_ALL/LANG=C (F3): the stderr regexes below match git's ENGLISH
  // messages ("not a git repository", "does not have any commits"). Without
  // forcing the C locale, a non-English system locale makes git emit
  // translated stderr, the regexes miss, and the signal falls through to the
  // generic 'error' state — which overrides the whole gauge to brownfield
  // (see gaugeProjectKind below), misclassifying an empty/new directory.
  const res = spawnSync('git', ['rev-list', '--count', '--max-count=2', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (res.error) {
    return { hit: false, state: 'error', evidence: `error: git execution failed (${res.error.code || res.error.message})` };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').toLowerCase();
    if (/not a git repository/.test(stderr)) return { hit: false, state: 'miss-no-repo', evidence: 'not a git repository' };
    if (/bad revision|unknown revision|ambiguous argument|does not have any commits/.test(stderr)) {
      return { hit: false, state: 'miss-zero-commits', evidence: 'git repository with 0 commits' };
    }
    return { hit: false, state: 'error', evidence: `error: git exited ${res.status} (${stderr.trim().slice(0, 100) || 'unrecognized failure'})` };
  }
  const count = parseInt((res.stdout || '').trim(), 10) || 0;
  return { hit: count > 1, state: count > 1 ? 'hit' : 'miss-zero-commits', evidence: `${count} commit(s) via git rev-list --count HEAD` };
}

/**
 * gaugeProjectKind — deterministic greenfield/brownfield classifier for `cwd`.
 * Decision rule: all 4 signals miss -> greenfield; 1+ hit -> brownfield;
 * a git execution error overrides to brownfield regardless of the other 3
 * signals (fail-safe: an unreadable state is never reported as "new").
 * Reports signals only; callers decide what to do with the verdict.
 */
export function gaugeProjectKind(cwd) {
  const dir = resolve(cwd);
  const manifest = pkManifestPresentUpward(dir, PK_UPWARD_BOUND);
  const lockfile = pkLockfilePresent(dir);
  const sourceTree = pkSourceTreePresent(dir);
  const git = pkGitHistorySignal(dir);

  const signals = [
    { id: 'manifest-present', hit: manifest.hit, evidence: manifest.hit ? `manifest/workspace marker found at upward level ${manifest.level}` : `no manifest within ${PK_UPWARD_BOUND} upward level(s) (${manifest.reason})` },
    { id: 'lockfile-present', hit: lockfile, evidence: lockfile ? 'lockfile found in target directory' : 'no lockfile in target directory' },
    { id: 'source-tree-present', hit: sourceTree, evidence: sourceTree ? 'src/lib/app/cmd/internal contains >=1 file' : 'no populated src/lib/app/cmd/internal subdir' },
    { id: 'git-history-present', hit: git.hit, evidence: git.evidence },
  ];

  const hits = signals.filter((s) => s.hit).length;
  const kind = git.state === 'error' ? 'brownfield' : (hits === 0 ? 'greenfield' : 'brownfield');

  return { signals, hits, total: signals.length, kind };
}

export function cmdProjectKind(args) {
  const { opts, positional } = parseOptions(args);
  const targetCwd = resolve(opts.cwd != null ? String(opts.cwd) : (positional[0] || process.cwd()));
  const gauge = gaugeProjectKind(targetCwd);
  const out = { cwd: targetCwd, ...gauge };

  if (opts.json !== undefined) {
    console.log(JSON.stringify(out, null, 2));
    return out;
  }

  console.log(`\n${C.bold}Project kind${C.reset} — ${out.hits}/${out.total} signals`);
  console.log(`  ${C.dim}${out.cwd}${C.reset}\n`);
  for (const s of out.signals) {
    console.log(`  ${s.hit ? `${C.yellow}HIT ${C.reset}` : `${C.dim}miss${C.reset}`} ${s.id.padEnd(22)} ${C.dim}${s.evidence}${C.reset}`);
  }
  const label = out.kind === 'greenfield'
    ? `${C.green}greenfield${C.reset} — no existing project detected`
    : `${C.yellow}brownfield${C.reset} — existing project signal(s) found`;
  console.log(`\n  kind: ${label}\n`);
  return out;
}

function detectAndRunQualityChecks(project) {
  const cwd = repoRoot();
  const results = [];
  const config = loadConfig();

  // Custom gate scripts
  const scripts = config.gate_scripts || {};
  for (const [name, script] of Object.entries(scripts)) {
    try {
      const out = spawnSync(script, [], { shell: true, cwd, stdio: 'pipe', timeout: 120000 });
      results.push({ check: name, passed: out.status === 0, output: out.stderr?.toString().slice(-200) || '' });
    } catch (e) {
      results.push({ check: name, passed: false, output: e.message });
    }
  }

  // Auto-detect test runners
  const detections = [
    { file: 'package.json', kind: 'package-test' },
    { file: 'pytest.ini', cmd: 'pytest', name: 'pytest' },
    { file: 'pyproject.toml', cmd: 'pytest', name: 'pytest' },
    { file: 'go.mod', cmd: 'go test ./...', name: 'go-test' },
    { file: 'Cargo.toml', cmd: 'cargo test', name: 'cargo-test' },
  ];

  for (const d of detections) {
    const filePath = join(cwd, d.file);
    if (!existsSync(filePath)) continue;
    let cmd = d.cmd;
    let name = d.name;
    if (d.kind === 'package-test') {
      try {
        const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
        const testScript = pkg.scripts?.test || '';
        if (!testScript || testScript.includes('no test specified')) continue;
        // Unit tests invoke `x-build quality` as a subprocess. If this repo's
        // package test script is `bun test`, auto-running it from inside Bun's
        // own test environment recursively spawns the full suite.
        if (shouldSkipRecursiveTestScript(testScript)) continue;
        const packageManager = detectPackageManager(cwd);
        cmd = packageScriptCommand(packageManager, 'test');
        name = `${packageManager}-test`;
      } catch { continue; }
    }
    try {
      const out = spawnSync(cmd, [], { shell: true, cwd, stdio: 'pipe', timeout: 300000 });
      results.push({ check: name, passed: out.status === 0, output: out.stderr?.toString().slice(-200) || '' });
    } catch (e) {
      results.push({ check: name, passed: false, output: e.message });
    }
  }

  // Auto-detect linters
  const linters = [
    { files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'], cmd: 'npx eslint .', name: 'eslint' },
    { files: ['.golangci.yml', '.golangci.yaml'], cmd: 'golangci-lint run', name: 'golangci-lint' },
  ];

  for (const l of linters) {
    if (l.files.some(f => existsSync(join(cwd, f)))) {
      try {
        const out = spawnSync(l.cmd, [], { shell: true, cwd, stdio: 'pipe', timeout: 120000 });
        results.push({ check: l.name, passed: out.status === 0, output: out.stderr?.toString().slice(-200) || '' });
      } catch (e) {
        results.push({ check: l.name, passed: false, output: e.message });
      }
    }
  }

  // Auto-detect build
  const builds = [
    { file: 'package.json', kind: 'package-build' },
    { file: 'go.mod', cmd: 'go build ./...', name: 'go-build' },
  ];

  for (const b of builds) {
    const filePath = join(cwd, b.file);
    if (!existsSync(filePath)) continue;
    let cmd = b.cmd;
    let name = b.name;
    if (b.kind === 'package-build') {
      try {
        const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!pkg.scripts?.build) continue;
        const packageManager = detectPackageManager(cwd);
        cmd = packageScriptCommand(packageManager, 'build');
        name = `${packageManager}-build`;
      } catch { continue; }
    }
    try {
      const out = spawnSync(cmd, [], { shell: true, cwd, stdio: 'pipe', timeout: 300000 });
      results.push({ check: name, passed: out.status === 0, output: out.stderr?.toString().slice(-200) || '' });
    } catch (e) {
      results.push({ check: name, passed: false, output: e.message });
    }
  }

  // Save results
  writeJSON(join(phaseDir(project, '04-verify'), 'quality-results.json'), {
    timestamp: new Date().toISOString(),
    results,
    passed: results.length === 0 || results.every(r => r.passed),
  });

  return results;
}

// ── Circuit Breaker ─────────────────────────────────────────────────

const RETRY_DEFAULTS = { max_retries: 3, base_delay_ms: 2000, max_delay_ms: 60000, jitter: 0.25 };
const CIRCUIT_DEFAULTS = { threshold: 3, cooldown_ms: 30000 };
const CIRCUIT_STATES = new Set(['closed', 'open', 'half-open']);
const CIRCUIT_REASONS = new Set(['failure', 'budget']);

function getRetryConfig() {
  const config = loadConfig();
  return { ...RETRY_DEFAULTS, ...config.retry };
}

function getCircuitConfig() {
  const config = loadConfig();
  return { ...CIRCUIT_DEFAULTS, ...config.circuit_breaker };
}

export function computeRetryDelay(attempt, cfg) {
  const base = cfg.base_delay_ms * Math.pow(2, attempt);
  const capped = Math.min(base, cfg.max_delay_ms);
  const jitter = capped * cfg.jitter * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}

function circuitBreakerPath(project) {
  return join(projectDir(project), 'circuit-breaker.json');
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function asTimestamp(value) {
  return validTimestamp(value) ? value : null;
}

/**
 * Read-time adapter for v1 circuit-breaker files. Invalid persisted state is
 * fail-open: a damaged status file must not indefinitely block all work.
 */
export function normalizeCircuitState(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const state = CIRCUIT_STATES.has(input.state) ? input.state : 'closed';
  const reason = CIRCUIT_REASONS.has(input.reason) ? input.reason : 'failure';
  const malformedReason = input.reason != null && !CIRCUIT_REASONS.has(input.reason);
  const cooldownUntil = asTimestamp(input.cooldown_until);
  // An open failure breaker without a usable deadline cannot safely recover.
  // Treat it as closed instead of reproducing the v1 permanent-block edge case.
  const usableState = malformedReason || (state === 'open' && reason === 'failure' && !cooldownUntil) ? 'closed' : state;
  const failures = Number(input.consecutive_failures);
  return {
    ...input,
    state: usableState,
    reason,
    consecutive_failures: Number.isInteger(failures) && failures >= 0 ? failures : 0,
    opened_at: asTimestamp(input.opened_at),
    cooldown_until: usableState === 'open' && reason === 'failure' ? cooldownUntil : null,
    half_open_at: usableState === 'half-open' ? asTimestamp(input.half_open_at) : null,
  };
}

function nowMs(now) {
  const value = typeof now === 'number' ? now : Date.parse(now);
  return Number.isFinite(value) ? value : Date.now();
}

function iso(now) {
  return new Date(nowMs(now)).toISOString();
}

/**
 * Deterministic circuit state machine. Callers provide `now` so state
 * transitions are unit-testable without clocks or filesystem state.
 */
export function transitionCircuitState(raw, event, { now, threshold = CIRCUIT_DEFAULTS.threshold, cooldown_ms = CIRCUIT_DEFAULTS.cooldown_ms } = {}) {
  const cb = normalizeCircuitState(raw);
  const current = nowMs(now);
  const timestamp = iso(current);
  const cooldown = Number.isFinite(Number(cooldown_ms)) && Number(cooldown_ms) >= 0
    ? Number(cooldown_ms) : CIRCUIT_DEFAULTS.cooldown_ms;
  const failureThreshold = Number.isFinite(Number(threshold)) && Number(threshold) > 0
    ? Number(threshold) : CIRCUIT_DEFAULTS.threshold;

  if (event === 'failure') {
    const failures = cb.consecutive_failures + 1;
    const mustOpen = cb.state === 'half-open' || (cb.state === 'closed' && failures >= failureThreshold);
    if (!mustOpen) return { ...cb, consecutive_failures: failures, last_failure_at: timestamp };
    return {
      ...cb, state: 'open', reason: 'failure', consecutive_failures: failures,
      last_failure_at: timestamp, opened_at: timestamp,
      cooldown_until: iso(current + cooldown), half_open_at: null,
    };
  }

  if (event === 'success') {
    // A task success is never evidence that a budget cap recovered.
    if (cb.reason === 'budget' && cb.state !== 'closed') return cb;
    if (cb.state === 'half-open') {
      return { ...cb, state: 'closed', reason: 'failure', consecutive_failures: 0, opened_at: null, cooldown_until: null, half_open_at: null };
    }
    if (cb.state === 'closed') return { ...cb, consecutive_failures: Math.max(0, cb.consecutive_failures - 1) };
    return cb;
  }

  if (event === 'budget_exceeded') {
    // Failure protection wins. A budget check must not replace its recovery
    // deadline or failure counter with budget state.
    if (cb.reason === 'failure' && cb.state !== 'closed') return cb;
    return { ...cb, state: 'open', reason: 'budget', opened_at: timestamp, cooldown_until: null, half_open_at: null };
  }

  if (event === 'budget_recovered') {
    if (cb.state === 'open' && cb.reason === 'budget') {
      return { ...cb, state: 'closed', opened_at: null, cooldown_until: null, half_open_at: null };
    }
    return cb;
  }

  if (event === 'probe') {
    if (cb.reason !== 'failure') return cb;
    const cooldownUntil = Date.parse(cb.cooldown_until);
    const probeStarted = Date.parse(cb.half_open_at);
    const openReady = cb.state === 'open' && Number.isFinite(cooldownUntil) && current >= cooldownUntil;
    // v1 persisted half-open state has no half_open_at lease. It was
    // intentionally non-blocking, so adapt it into exactly one fresh probe.
    const legacyHalfOpen = cb.state === 'half-open' && !Number.isFinite(probeStarted);
    const abandonedProbe = cb.state === 'half-open' && Number.isFinite(probeStarted) && current >= probeStarted + cooldown;
    if (openReady || legacyHalfOpen || abandonedProbe) {
      return { ...cb, state: 'half-open', reason: 'failure', half_open_at: timestamp };
    }
  }
  return cb;
}

/** Pure gate predicate used by the project-backed reader and tests. */
export function shouldBlockCircuit(raw, { now, cooldown_ms = CIRCUIT_DEFAULTS.cooldown_ms } = {}) {
  const cb = normalizeCircuitState(raw);
  const current = nowMs(now);
  if (cb.reason === 'budget') return false; // budget is re-evaluated by checkBudget.
  if (cb.state === 'open') {
    const deadline = Date.parse(cb.cooldown_until);
    return !Number.isFinite(deadline) || current < deadline;
  }
  if (cb.state === 'half-open') {
    const probeStarted = Date.parse(cb.half_open_at);
    const cooldown = Number(cooldown_ms);
    // Missing half_open_at is a v1 state with no probe lease. Let the caller
    // atomically claim it through beginHalfOpenProbe instead of wedging work.
    if (!Number.isFinite(probeStarted)) return false;
    return !Number.isFinite(cooldown) || current < probeStarted + cooldown;
  }
  return false;
}

export function getCircuitState(project) {
  return normalizeCircuitState(readJSON(circuitBreakerPath(project)));
}

export function updateCircuitBreaker(project, taskFailed) {
  const cfg = getCircuitConfig();
  const before = getCircuitState(project);
  const cb = modifyJSON(circuitBreakerPath(project), (raw) => transitionCircuitState(raw, taskFailed ? 'failure' : 'success', { ...cfg, now: Date.now() }));
  if (taskFailed && before.state === 'half-open' && cb.state === 'open') {
    console.log(`  ${C.red}⚡ Circuit breaker OPEN — half-open probe failed. Cooldown restarted.${C.reset}`);
  } else if (taskFailed && before.state === 'closed' && cb.state === 'open') {
    console.log(`  ${C.red}⚡ Circuit breaker OPEN — ${cb.consecutive_failures} consecutive failures. Step paused.${C.reset}`);
    console.log(`  ${C.dim}Cooldown until: ${cb.cooldown_until}${C.reset}`);
  } else if (!taskFailed && before.state === 'half-open' && cb.state === 'closed') {
    console.log(`  ${C.green}⚡ Circuit breaker CLOSED — half-open probe succeeded.${C.reset}`);
  }
  return cb;
}

/** Update only the budget-owned circuit state; failure state is never replaced. */
export function updateBudgetCircuitBreaker(project, budgetStatus) {
  const event = budgetStatus?.level === 'exceeded' ? 'budget_exceeded' : 'budget_recovered';
  return modifyJSON(circuitBreakerPath(project), (raw) => transitionCircuitState(raw, event, { now: Date.now() }));
}

// PURE predicate (F4): never writes. Returns whether work should be blocked.
// The open→half-open transition lives in beginHalfOpenProbe() so that callers
// using this for display/logging can't accidentally flip the breaker's state.
// A v2 half-open state has a short, exclusive probe lease. A legacy v1
// half-open state without that lease remains immediately recoverable.
export function isCircuitOpen(project) {
  const cb = getCircuitState(project);
  return shouldBlockCircuit(cb, { now: Date.now(), cooldown_ms: getCircuitConfig().cooldown_ms });
}

// MUTATING transition (F4): call right before dispatching the recovery probe,
// after isCircuitOpen() has returned false for an open breaker whose cooldown
// has elapsed. Moves open→half-open. No-op (returns false) when the breaker is
// not in that ready-to-probe state, so it is safe to call unconditionally.
export function beginHalfOpenProbe(project) {
  const cfg = getCircuitConfig();
  const now = Date.now();
  let claimed = false;
  const cb = modifyJSON(circuitBreakerPath(project), (raw) => {
    const before = normalizeCircuitState(raw);
    const next = transitionCircuitState(before, 'probe', { ...cfg, now });
    // This comparison runs while holding the JSON lock. A stale read outside
    // the lock let multiple processes believe they had won the same probe.
    claimed = next.state === 'half-open' && next.half_open_at !== before.half_open_at;
    return next;
  });
  if (claimed) {
    console.log(`  ${C.yellow}⚡ Circuit breaker HALF-OPEN — probe allowed.${C.reset}`);
    return true;
  }
  return false;
}

export function resetCircuitBreaker(project) {
  const cb = { state: 'closed', reason: 'failure', consecutive_failures: 0, opened_at: null, cooldown_until: null, half_open_at: null };
  writeJSON(circuitBreakerPath(project), cb);
  console.log(`  ${C.green}⚡ Circuit breaker manually reset to CLOSED.${C.reset}`);
  return cb;
}

// Persists the retry decision for task `id` to disk via its own atomic
// modifyJSON. Returns { scheduled, retry_count }. NOTE: takes the task id, not
// a task object — a previous signature accepted (task, data) where callers
// passed a task object aliased to a *different* data object than the one
// written, so retry_count/status/next_retry_at never reached disk and the
// retry feature was a silent no-op (cmdRun only re-picks PENDING/READY tasks).
export function scheduleRetry(project, id) {
  const cfg = getRetryConfig();
  const result = { scheduled: false, retry_count: 0 };

  modifyJSON(tasksPath(project), (data) => {
    if (!data?.tasks) return data;
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return data;

    const next = (task.retry_count || 0) + 1;
    if (next > cfg.max_retries) {
      result.retry_count = task.retry_count || 0;
      console.log(`  ${C.red}🚫 Max retries (${cfg.max_retries}) exhausted for ${id}.${C.reset}`);
      return data; // leave status as-is (stays FAILED) — do not reschedule
    }

    const delay = computeRetryDelay(next - 1, cfg);
    task.retry_count = next;
    task.status = TASK_STATES.PENDING;
    task.next_retry_at = new Date(Date.now() + delay).toISOString();
    result.scheduled = true;
    result.retry_count = next;
    console.log(`  ${C.yellow}🔄 Retry ${next}/${cfg.max_retries} scheduled in ${fmtDuration(delay)}${C.reset}`);
    return data;
  });

  return result;
}


// ── Templates ────────────────────────────────────────────────────────

export function templatesDir() {
  const local = join(ROOT, 'templates');
  if (existsSync(local)) return local;
  return join(PLUGIN_ROOT, 'templates');
}

export function loadTaskTemplate(templateName) {
  const tasksDir = join(templatesDir(), 'tasks');
  const path = join(tasksDir, `${templateName}.md`);
  if (!existsSync(path)) return null;
  return readMD(path);
}

export function renderTemplate(content, vars) {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

// ── parseOptions helper ─────────────────────────────────────────────

export function parseOptions(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      opts[key] = val;
    } else {
      positional.push(args[i]);
    }
  }
  return { opts, positional };
}

// ── Context Manifests ───────────────────────────────────────────────

export const CONTEXT_MANIFESTS = {
  research: ['goal', 'constraints', 'context_md', 'requirements_md'],
  plan:     ['goal', 'constraints', 'research_summary', 'context_md', 'requirements_md', 'roadmap_md'],
  execute:  ['plan_tasks', 'plan_steps', 'execute_progress', 'context_md', 'requirements_md'],
  verify:   ['plan_tasks', 'execute_artifacts', 'execute_errors', 'requirements_md'],
  close:    ['verify_report', 'execute_summary'],
};

export function loadPhaseContext(project, phaseName) {
  const manifest = CONTEXT_MANIFESTS[phaseName] || [];
  const m = readJSON(manifestPath(project));
  const taskData = readJSON(tasksPath(project));
  const stepData = readJSON(stepsPath(project));
  const decisions = readMD(join(contextDir(project), 'decisions.md'));
  const notes = readMD(join(phaseDir(project, '01-research'), 'notes.md'));

  const store = {
    goal: m?.display_name || project,
    constraints: '',
    research_summary: notes?.slice(0, 500) || '',
    plan_tasks: taskData?.tasks || [],
    plan_steps: stepData?.steps || [],
    execute_progress: taskData?.tasks?.map(t => ({ id: t.id, status: t.status })) || [],
    execute_artifacts: taskData?.tasks?.filter(t => t.status === TASK_STATES.COMPLETED).map(t => t.id) || [],
    execute_errors: taskData?.tasks?.filter(t => t.status === TASK_STATES.FAILED).map(t => ({ id: t.id, name: t.name })) || [],
    execute_summary: '',
    verify_report: '',
    context_md: readMD(join(contextDir(project), 'CONTEXT.md'))?.slice(0, 2000) || '',
    requirements_md: readMD(join(contextDir(project), 'REQUIREMENTS.md'))?.slice(0, 2000) || '',
    roadmap_md: readMD(join(contextDir(project), 'ROADMAP.md'))?.slice(0, 2000) || '',
  };

  const ctx = {};
  for (const key of manifest) {
    if (store[key] !== undefined) ctx[key] = store[key];
  }
  return ctx;
}

// ── Decision Logging ────────────────────────────────────────────────

export function logDecision(project, message) {
  const path = join(contextDir(project), 'decisions.md');
  const existing = readMD(path);
  const timestamp = new Date().toISOString().slice(0, 19);
  const entry = `- [${timestamp}] ${message}\n`;

  if (existing.trim()) {
    writeMD(path, existing + entry);
  } else {
    writeMD(path, `# Decisions Log\n\n${entry}`);
  }
}

export function addDecision(project, { type, title, rationale, alternatives, phase }) {
  const p = decisionsPath(project);
  const data = readJSON(p) || { decisions: [] };
  const manifest = readJSON(manifestPath(project));
  const currentPhase = phase || PHASES.find(ph => ph.id === manifest?.current_phase)?.name || 'unknown';

  data.decisions.push({
    id: `d${data.decisions.length + 1}`,
    type: type || 'decision',
    title,
    rationale: rationale || '',
    alternatives: alternatives || [],
    phase: currentPhase,
    timestamp: new Date().toISOString(),
  });

  writeJSON(p, data);
  logDecision(project, `[${type || 'decision'}] ${title}`);
}


// ── Interactive helpers ─────────────────────────────────────────────

export function createRL() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

export function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function pickMenu(rl, title, options) {
  console.log(`\n${title}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i].label}`);
  }
  console.log('  0) Exit\n');

  while (true) {
    const answer = await ask(rl, '  → ');
    const num = parseInt(answer.trim(), 10);
    if (num === 0) return null;
    if (num >= 1 && num <= options.length) return options[num - 1];
    console.log(`  ⚠ 1-${options.length} 또는 0을 입력하세요.`);
  }
}

// ── CSV / Size helpers ──────────────────────────────────────────────

export function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += ch;
      i++;
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { result.push(current); current = ''; i++; continue; }
      current += ch;
      i++;
    }
  }
  result.push(current);
  return result;
}

export function normSize(val) {
  if (!val) return 'medium';
  const v = val.toLowerCase();
  if (['small', 'low', '간단', 's'].includes(v)) return 'small';
  if (['large', 'high', '복잡', 'l', 'xl'].includes(v)) return 'large';
  return 'medium';
}
