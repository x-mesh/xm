/**
 * x-build/gate-panel — panel verdict → merge-gate exit code wrapper.
 *
 * Why this exists: `gk worktree finish --gate <cmd>` judges a feature merge by
 * the gate command's EXIT CODE only. `xm panel --json` exits 0 whenever it ran
 * successfully — even when it surfaced blocking consensus findings. So "run the
 * panel" and "turn the panel verdict into a merge-blocking policy" must not be
 * split. This wrapper runs `xm panel`, evaluates the verdict against a policy,
 * and converts it to an exit code: 0 pass / 1 policy block / 2 wrapper|panel error.
 *
 * Root resolution: the wrapper is invoked from a linked worktree cwd whose local
 * `.xm/` (if any) is NOT the canonical project state. It self-resolves the main
 * repo root via `git rev-parse --git-common-dir` so artifacts and the `xm panel`
 * subprocess env (`X_PANEL_ROOT`) point at the MAIN repo `.xm/`, surviving both
 * env-less gate invocation and `--cleanup` of the worktree. Explicit
 * `X_BUILD_ROOT` / `X_PANEL_ROOT` env wins over git self-resolution.
 *
 * See docs/x-build-worktree-pipeline-plan.md — "panel gate wrapper",
 * "root env 주입 계약 (P0)".
 */

import {
  spawnSync, resolve, join, dirname,
  readJSON, existsSync, mkdirSync, writeFileSync, renameSync,
  parseOptions, getExplicitProject, exitFail, C,
} from './core.mjs';
// Unified worktree config resolver + shared trust-boundary/root helpers (leaf
// module — no cycle back to worktrees.mjs).
import {
  loadWorktreeConfig, worktreeGatePolicyConfigured,
  validateIdSegment, resolveMainRepoRoot,
} from './worktree-shared.mjs';

const VALID_PHASES = ['before', 'after', 'release'];

const DEFAULT_POLICY = {
  block_confirmed: ['critical', 'high', 'medium'],
  block_unreviewed: ['critical', 'high'],
  block_contested: ['critical'],
  allow_low: true,
};

// Transient failures worth one retry: spawn failure, wall-clock timeout, and
// network/provider hiccups. Verdict failures (exit 1) are NEVER retried.
const TRANSIENT_RE = /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|temporarily unavailable|rate limit|429|502|503|504/i;

// ── Root resolution ──────────────────────────────────────────────────

/**
 * Resolve the main-repo-scoped x-build and panel roots from a (possibly
 * worktree) cwd. Explicit env wins; otherwise self-resolve via git-common-dir.
 * @returns {{ buildRoot: string, panelRoot: string, mainRepoRoot: string|null }}
 */
export function resolveMainRoots(cwd = process.cwd()) {
  // git-common-dir resolution lives in worktree-shared so gate-panel and
  // worktrees never diverge (see F6/F7). null → cwd-relative fallback below.
  const mainRepoRoot = resolveMainRepoRoot(cwd);

  const buildRoot = process.env.X_BUILD_ROOT
    ? resolve(process.env.X_BUILD_ROOT)
    : mainRepoRoot ? join(mainRepoRoot, '.xm', 'build') : join(cwd, '.xm', 'build');

  const panelRoot = process.env.X_PANEL_ROOT
    ? resolve(process.env.X_PANEL_ROOT)
    : mainRepoRoot ? join(mainRepoRoot, '.xm') : join(cwd, '.xm');

  return { buildRoot, panelRoot, mainRepoRoot };
}

// ── Policy ────────────────────────────────────────────────────────────

/**
 * Merge policy: defaults ← config (worktree.gate_policy) ← task metadata (gate_policy).
 * Per-key shallow override — a present key fully replaces the lower layer.
 */
export function mergePolicy({ config, task } = {}) {
  const configPolicy = config?.worktree?.gate_policy || {};
  const taskPolicy = task?.gate_policy || {};
  return { ...DEFAULT_POLICY, ...configPolicy, ...taskPolicy };
}

function blocksFor(findings, severities, allowLow) {
  const set = new Set((severities || []).map(s => String(s).toLowerCase()));
  const out = [];
  for (const f of findings || []) {
    const sev = String(f.severity || '').toLowerCase();
    if (allowLow && sev === 'low') continue;
    if (!set.has(sev)) continue;
    out.push({
      severity: f.severity,
      file: f.file ?? null,
      line: f.line ?? null,
      claim: f.claim ?? null,
      kind: undefined, // filled by caller
    });
  }
  return out;
}

/**
 * Evaluate a panel verdict record against policy.
 * @returns {{ decision: 'pass'|'fail', blocking: object[] }}
 */
export function evaluateVerdict(verdict, policy) {
  const allowLow = policy.allow_low !== false;
  const blocking = [];
  for (const b of blocksFor(verdict.confirmed, policy.block_confirmed, allowLow)) blocking.push({ ...b, kind: 'confirmed' });
  for (const b of blocksFor(verdict.unreviewed, policy.block_unreviewed, allowLow)) blocking.push({ ...b, kind: 'unreviewed' });
  for (const b of blocksFor(verdict.contested, policy.block_contested, allowLow)) blocking.push({ ...b, kind: 'contested' });
  return { decision: blocking.length ? 'fail' : 'pass', blocking };
}

// ── Panel invocation ─────────────────────────────────────────────────

// Base argv for the panel CLI. Overridable for tests (fake panel) via
// X_BUILD_PANEL_ARGV as a JSON array, e.g. ["node","/path/fake-panel.mjs"].
// Default is the `xm` dispatcher, which resolves the versioned x-panel lib.
function panelBaseArgv() {
  const raw = process.env.X_BUILD_PANEL_ARGV;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length && arr.every(x => typeof x === 'string')) return arr;
      throw new Error('X_BUILD_PANEL_ARGV must be a non-empty JSON string array');
    } catch (e) {
      throw new Error(`Invalid X_BUILD_PANEL_ARGV: ${e.message}`);
    }
  }
  return ['xm', 'panel'];
}

/**
 * Run `xm panel <patch> --json` once (no retry).
 * @returns {{ ok: true, verdict: object } | { ok: false, transient: boolean, error: string }}
 */
function runPanelOnce({ patch, taskId, phase, cwd, panelRoot, buildRoot }) {
  const base = panelBaseArgv();
  const cmd = base[0];
  const args = [
    ...base.slice(1),
    patch, '--json',
    '--source', 'build:worktree',
    '--title', `${taskId} ${phase}`,
  ];
  const env = { ...process.env, X_PANEL_ROOT: panelRoot, XM_ROOT: panelRoot, X_BUILD_ROOT: buildRoot };
  const timeoutMs = Number(process.env.X_BUILD_GATE_TIMEOUT_MS) || 600000;

  const res = spawnSync(cmd, args, {
    cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    const code = res.error.code || '';
    // Timeout (ETIMEDOUT) and network-ish spawn errors are transient. A missing
    // panel binary (ENOENT) is also treated as transient per the plan's
    // "spawn 실패" rule (one retry, then surface as infra error).
    const transient = code === 'ETIMEDOUT' || res.signal === 'SIGTERM' || TRANSIENT_RE.test(res.error.message || '') || code === 'ENOENT';
    return { ok: false, transient, error: `panel spawn failed: ${res.error.message}` };
  }
  if (res.signal) {
    return { ok: false, transient: true, error: `panel killed by signal ${res.signal} (likely timeout)` };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').toString();
    const transient = TRANSIENT_RE.test(stderr) || TRANSIENT_RE.test((res.stdout || '').toString());
    return { ok: false, transient, error: `panel exited ${res.status}: ${stderr.trim().slice(-500) || '(no stderr)'}` };
  }

  const stdout = (res.stdout || '').toString();
  let verdict;
  try {
    verdict = JSON.parse(stdout);
  } catch (e) {
    // Exit 0 but no parseable JSON — a wrapper/panel contract error, not transient.
    return { ok: false, transient: false, error: `panel --json produced unparseable output: ${e.message}` };
  }
  return { ok: true, verdict };
}

/**
 * Run panel with a single retry on transient failure.
 */
function runPanel(ctx) {
  const first = runPanelOnce(ctx);
  if (first.ok || !first.transient) return { ...first, attempts: 1 };
  process.stderr.write(`${C.yellow}⚠ gate-panel: transient panel failure, retrying once — ${first.error}${C.reset}\n`);
  const second = runPanelOnce(ctx);
  return { ...second, attempts: 2 };
}

// ── Artifact ─────────────────────────────────────────────────────────

function writeArtifact(path, data) {
  // Fail LOUD (L6): never silence a save error — the gate decision must be
  // auditable. Print to stderr but do not change the exit code.
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    // deliberate: artifact write failure must not block a valid merge (L6 loud-fail, see triage F13)
    process.stderr.write(`${C.red}✗ gate-panel: failed to save artifact ${path}: ${e.message}${C.reset}\n`);
  }
}

// ── Core runner (testable) ───────────────────────────────────────────

/**
 * Run the panel gate. Pure of process.exit — returns a result the caller maps
 * to an exit code. Writes the wrapper artifact as a side effect.
 *
 * @returns {{ result: object, exitCode: number, artifactPath: string }}
 */
export function runGatePanel({ project, taskId, phase, patch, cwd = process.cwd() }) {
  const { buildRoot, panelRoot } = resolveMainRoots(cwd);

  const artifactPath = join(buildRoot, 'projects', project, 'worktrees', taskId, `panel-${phase}.json`);

  // Merge policy: defaults ← unified worktree config (shared + build-local) ←
  // task metadata. loadWorktreeConfig applies the full resolution priority so a
  // gate_policy in EITHER .xm/config.json or .xm/build/config.json is honored.
  const wtConfig = loadWorktreeConfig({ buildRootDir: buildRoot });
  const tasksJson = readJSON(join(buildRoot, 'projects', project, 'phases', '02-plan', 'tasks.json'));
  const task = tasksJson?.tasks?.find(t => t.id === taskId) || null;
  const policy = mergePolicy({ config: { worktree: wtConfig }, task });
  const policyOverridden = !!(task?.gate_policy) || worktreeGatePolicyConfigured(buildRoot);

  const panel = runPanel({ patch, taskId, phase, cwd, panelRoot, buildRoot });

  if (!panel.ok) {
    const result = {
      ok: false,
      decision: 'error',
      exit_code: 2,
      task_id: taskId,
      phase,
      panel_run: null,
      source: 'build:worktree',
      policy,
      policy_overridden: policyOverridden,
      blocking_findings: [],
      attempts: panel.attempts,
      error: panel.error,
    };
    writeArtifact(artifactPath, result);
    return { result, exitCode: 2, artifactPath };
  }

  const verdict = panel.verdict;
  const { decision, blocking } = evaluateVerdict(verdict, policy);
  const exitCode = decision === 'fail' ? 1 : 0;
  const result = {
    ok: exitCode === 0,
    decision,
    exit_code: exitCode,
    task_id: taskId,
    phase,
    panel_run: verdict.run || null,
    source: 'build:worktree',
    policy,
    policy_overridden: policyOverridden,
    blocking_findings: blocking,
    counts: verdict.counts || null,
    attempts: panel.attempts,
  };
  writeArtifact(artifactPath, result);
  return { result, exitCode, artifactPath };
}

// ── CLI command ──────────────────────────────────────────────────────

export function cmdGatePanel(args) {
  const { opts } = parseOptions(args);

  // --project is MANDATORY (exit 2). The dispatcher strips --project and calls
  // setExplicitProject(); read it back rather than trusting positionals, which
  // the backward-compat unshift may have injected. Without an explicit project,
  // findCurrentProject() would collapse the gate result onto the wrong active
  // project in a multi-active workspace (see plan "gk 호출 계약").
  const project = getExplicitProject();
  if (!project) {
    console.error('❌ gate-panel requires --project <name>. Refusing to guess the target project.');
    exitFail(2);
    return;
  }
  // Trust boundary: --project flows into artifact paths (join) — reject traversal
  // / argv-injection segments before any filesystem or subprocess use (F3).
  const projErr = validateIdSegment(project, '--project');
  if (projErr) { console.error(`❌ gate-panel: ${projErr}`); exitFail(2); return; }

  const taskId = typeof opts.task === 'string' ? opts.task : null;
  const phase = typeof opts.phase === 'string' ? opts.phase : null;
  const patch = typeof opts.patch === 'string' ? opts.patch : null;
  const json = !!opts.json;

  if (!taskId) { console.error('❌ gate-panel requires --task <id>.'); exitFail(2); return; }
  const taskErr = validateIdSegment(taskId, '--task');
  if (taskErr) { console.error(`❌ gate-panel: ${taskErr}`); exitFail(2); return; }
  if (!phase || !VALID_PHASES.includes(phase)) {
    console.error(`❌ gate-panel requires --phase <${VALID_PHASES.join('|')}>.`);
    exitFail(2); return;
  }
  if (!patch) { console.error('❌ gate-panel requires --patch <path>.'); exitFail(2); return; }
  if (!existsSync(patch)) { console.error(`❌ gate-panel: patch file not found: ${patch}`); exitFail(2); return; }

  const { result, exitCode, artifactPath } = runGatePanel({ project, taskId, phase, patch });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const icon = result.decision === 'pass' ? `${C.green}✓ PASS${C.reset}`
      : result.decision === 'fail' ? `${C.red}✗ BLOCK${C.reset}`
      : `${C.red}✗ ERROR${C.reset}`;
    console.log(`${icon} gate-panel ${project}/${taskId} [${phase}] → exit ${exitCode}`);
    if (result.decision === 'fail') {
      for (const b of result.blocking_findings) {
        console.log(`  ${C.yellow}${b.severity}${C.reset} (${b.kind}) ${b.file ?? '?'}:${b.line ?? '?'} — ${b.claim ?? ''}`);
      }
    } else if (result.decision === 'error') {
      console.log(`  ${C.red}${result.error}${C.reset}`);
    }
    console.log(`${C.dim}  artifact: ${artifactPath}${C.reset}`);
  }

  exitFail(exitCode);
}
