/**
 * x-build/worktrees — worktree pipeline state model, artifacts + orchestration
 *
 * Concerns (see docs/x-build-worktree-pipeline-plan.md):
 *   1. gk finish result -> xm task/worktree state mapping (canonical table).
 *   2. project-scoped worktree artifact layer (run.json / preflight.json).
 *   3. dry-run planning + capability preflight (t5).
 *   4. worktree acquire automation + TASK-CONTEXT snapshot + env injection (t6).
 *   5. serialized finish queue + `worktrees resume` (base drift → re-gate) (t7).
 *   6. release-time `main...develop` batch review (t9, reuses gate-panel).
 *
 * gk/panel invocation: sections 3-6 shell out to gk and (via gate-panel) to the
 * panel. Every subprocess base command is injectable for tests —
 * X_BUILD_GK_ARGV / X_BUILD_PANEL_ARGV as JSON string arrays — so no test ever
 * touches a real git-kit or panel.
 */

import {
  resolve, join, dirname, basename,
  C,
  readJSON, writeJSON, modifyJSON,
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync,
  spawnSync, homedir,
  toSlug, tasksPath, resolveProject, getExplicitProject, parseOptions, exitFail,
} from './core.mjs';
import { runGatePanel } from './gate-panel.mjs';
import { taskCheckContractHash, taskCheckFingerprint } from './build-policy.mjs';
import { appendMetric, generateCorrelationId } from './cost-engine.mjs';
// Shared leaf module — see worktree-shared.mjs header for the DAG rationale.
// isParallelSafe/normalizeExpectedFiles used to come from tasks.mjs (the cycle);
// buildRoot/config used to be defined here (the gate-panel cycle). Both now live
// in the leaf so imports flow one direction only.
import {
  isParallelSafe, normalizeExpectedFiles,
  buildRoot, WORKTREE_CONFIG_DEFAULTS, loadWorktreeConfig, applyLifecycleWorktreePolicy,
  validateIdSegment, resolveMainRepoRoot,
} from './worktree-shared.mjs';

// Re-export so existing importers (tests, other modules) keep working unchanged.
export { WORKTREE_CONFIG_DEFAULTS, loadWorktreeConfig } from './worktree-shared.mjs';

// ── worktree_status constants ────────────────────────────────────────
// These are NOT x-build canonical TASK_STATES (pending|ready|running|...).
// worktree_status is a separate axis stored in run.json; core.TASK_STATES is
// left untouched by design (plan "상태 모델").
export const WORKTREE_STATUS = {
  READY: 'READY',
  WORKTREE_CREATED: 'WORKTREE_CREATED',
  RUNNING: 'RUNNING',
  VERIFYING: 'VERIFYING',
  REVIEWING: 'REVIEWING',
  MERGING: 'MERGING',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
  NEEDS_FIX: 'NEEDS_FIX',
};

// x-build canonical task statuses this module maps into. We only ever emit
// these three — the worktree pipeline never introduces a new tasks.json enum.
export const TASK_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

// ── gk finish envelope -> xm state mapping ───────────────────────────

// Extract the gate command's own exit code from the envelope, if gk surfaced
// it. Used to split worktree_gate_before_failed into:
//   exit 1 (panel verdict fail)  -> NEEDS_FIX (author must fix code)
//   exit 2 (wrapper/runtime err) -> BLOCKED   (panel/gate infra is broken)
// gk's field naming isn't nailed down across versions, so probe the plausible
// locations and return null when none is present (default to NEEDS_FIX).
function gateExitCode(envelope) {
  const g = envelope?.result?.gate;
  const e = envelope?.error;
  const candidates = [
    g?.exit_code, g?.gate_exit_code, g?.exit,
    e?.gate_exit_code, e?.exit_code,
  ];
  for (const c of candidates) {
    if (typeof c === 'number') return c;
  }
  // Measured against gk v0.106.0: on before-gate failure result.gate is null
  // and the gate's exit code only appears in the error message text, e.g.
  // "worktree finish: gate failed before merge (exit 2)".
  const msg = e?.message;
  if (typeof msg === 'string') {
    const m = msg.match(/\(exit (\d+)\)/);
    if (m) return Number(m[1]);
  }
  return null;
}

// gk agent mode writes ok envelopes to stdout but blocked/paused/error
// envelopes to stderr (measured against gk v0.106.0). Probe both streams;
// returns null when neither holds a JSON envelope.
function parseAgentEnvelope(res) {
  for (const raw of [res.stdout, res.stderr]) {
    const s = (raw || '').trim();
    if (!s) continue;
    try { return JSON.parse(s); } catch { /* not pure JSON — try to extract */ }
    // Human progress text can share a stream with the envelope (measured:
    // paused runs print promote progress on stderr). Try, in order:
    //   1. the outermost brace slice (envelope is the only JSON on the stream);
    //   2. a slice anchored at the '"schema"' key gk envelopes start with —
    //      survives extra brace-bearing text around the envelope.
    const end = s.lastIndexOf('}');
    const starts = [];
    const first = s.indexOf('{');
    if (first >= 0) starts.push(first);
    const schemaAt = s.indexOf('"schema"');
    if (schemaAt > 0) {
      const anchored = s.lastIndexOf('{', schemaAt);
      if (anchored >= 0 && !starts.includes(anchored)) starts.push(anchored);
    }
    for (const start of starts) {
      if (end > start) {
        try { return JSON.parse(s.slice(start, end + 1)); } catch { /* next candidate */ }
      }
    }
  }
  return null;
}

// Tail of both streams for last_error diagnostics when parsing fails.
function envelopeStreamsTail(res) {
  return {
    stdout: (res.stdout || '').slice(-500),
    stderr: (res.stderr || '').slice(-500),
  };
}

/**
 * Fold a gk `worktree finish` agent-mode envelope into xm state.
 *
 * @param {{state:string, ok?:boolean, result?:object, error?:object}} envelope
 * @returns {{
 *   task_status: string,        // one of TASK_STATUS
 *   worktree_status: string,    // one of WORKTREE_STATUS
 *   retryable: boolean,         // true only for transient lock contention
 *   save: object,               // what the orchestrator should persist to run.json
 * }}
 *
 * Canonical table (docs plan "gk state → xm task state 매핑"):
 *   ok                              -> completed / DONE
 *   blocked worktree_gate_before_failed -> running / NEEDS_FIX  (BLOCKED if gate exit 2)
 *   blocked worktree_gate_dirty     -> running / NEEDS_FIX
 *   blocked worktree_gate_locked    -> running / MERGING (retryable)
 *   blocked worktree_gate_no_target -> running / BLOCKED
 *   paused after-gate (result.gate.paused) -> running / BLOCKED + patch/recover
 *   paused merge conflict           -> running / BLOCKED + resume/abort remedies
 *   blocked worktree_resume_not_merged -> running / BLOCKED (data-loss guard)
 *
 * Throws on an unrecognized envelope shape rather than silently passing — a
 * malformed gk result must be visible, never mapped to a benign status.
 */
export function mapGkFinishResult(envelope) {
  const state = envelope?.state;
  const gate = envelope?.result?.gate;
  const errCode = envelope?.error?.code;

  if (state === 'ok') {
    return {
      task_status: TASK_STATUS.COMPLETED,
      worktree_status: WORKTREE_STATUS.DONE,
      retryable: false,
      save: {
        run_id: gate?.run_id ?? null,
        gate: gate ?? null,
        last_error: null,
        // A prior BLOCKED attempt may have persisted recover[]/patch; a later
        // successful finish must clear them or run.json advertises stale
        // (and now-wrong) rewind commands.
        recover: [],
        patch: null,
      },
    };
  }

  if (state === 'blocked') {
    const remedies = envelope?.error?.remedies ?? [];
    switch (errCode) {
      case 'worktree_gate_before_failed': {
        // exit 2 = wrapper/runtime failure -> infra problem (BLOCKED);
        // otherwise a panel verdict fail the author must fix (NEEDS_FIX).
        const wrapperError = gateExitCode(envelope) === 2;
        return {
          task_status: TASK_STATUS.RUNNING,
          worktree_status: wrapperError ? WORKTREE_STATUS.BLOCKED : WORKTREE_STATUS.NEEDS_FIX,
          retryable: false,
          save: { run_id: gate?.run_id ?? null, gate: gate ?? null, last_error: envelope.error, remedies },
        };
      }
      case 'worktree_gate_dirty':
        return {
          task_status: TASK_STATUS.RUNNING,
          worktree_status: WORKTREE_STATUS.NEEDS_FIX,
          retryable: false,
          save: { last_error: envelope.error, remedies },
        };
      case 'worktree_gate_locked':
        // target merge lock held (finish serialization / external holder).
        // Keep MERGING and let the orchestrator retry once with backoff.
        return {
          task_status: TASK_STATUS.RUNNING,
          worktree_status: WORKTREE_STATUS.MERGING,
          retryable: true,
          save: { last_error: envelope.error, remedies },
        };
      case 'worktree_gate_no_target':
        return {
          task_status: TASK_STATUS.RUNNING,
          worktree_status: WORKTREE_STATUS.BLOCKED,
          retryable: false,
          save: { last_error: envelope.error, remedies },
        };
      case 'worktree_resume_not_merged':
        // --resume-accept called on an unmerged branch: gk refuses to cleanup
        // so no data is lost. Needs human resolution, not a code fix.
        return {
          task_status: TASK_STATUS.RUNNING,
          worktree_status: WORKTREE_STATUS.BLOCKED,
          retryable: false,
          save: { last_error: envelope.error, remedies },
        };
      default:
        // Unknown blocked reason — surface it, do not assume it's benign.
        return {
          task_status: TASK_STATUS.RUNNING,
          worktree_status: WORKTREE_STATUS.BLOCKED,
          retryable: false,
          save: { last_error: envelope.error ?? { code: errCode ?? 'unknown_blocked' }, remedies },
        };
    }
  }

  if (state === 'paused') {
    if (gate?.paused) {
      // after-gate failure: merge is kept, cleanup withheld, recover[] provided.
      return {
        task_status: TASK_STATUS.RUNNING,
        worktree_status: WORKTREE_STATUS.BLOCKED,
        retryable: false,
        save: {
          run_id: gate?.run_id ?? null,
          gate,
          patch: gate?.patch ?? null,
          recover: gate?.recover ?? [],
          last_error: null,
        },
      };
    }
    // merge conflict pause: resume/abort remedies from gk merge/promote contract.
    const remedies = envelope?.result?.remedies ?? envelope?.error?.remedies ?? [];
    return {
      task_status: TASK_STATUS.RUNNING,
      worktree_status: WORKTREE_STATUS.BLOCKED,
      retryable: false,
      save: { recover: remedies, last_error: envelope?.error ?? null },
    };
  }

  if (state === 'error') {
    return {
      task_status: TASK_STATUS.RUNNING,
      worktree_status: WORKTREE_STATUS.BLOCKED,
      retryable: false,
      save: { last_error: envelope?.error ?? { code: 'unknown_error' }, remedies: envelope?.error?.remedies ?? [] },
    };
  }

  throw new Error(`mapGkFinishResult: unrecognized gk envelope state: ${JSON.stringify(state)}`);
}

// ── artifact layer (run.json / preflight.json) ───────────────────────
//
// Paths derive from core.ROOT/projectDir — never hardcode `.xm/build/...`.
// Layout (plan "artifact 저장"):
//   .xm/build/projects/<project>/worktrees/<task-id>/run.json
//   .xm/build/projects/<project>/worktrees/preflight.json
//
// WRITER CONTRACT: run.json has a SINGLE writer — the orchestrator. Worktree
// agents never write run.json; they leave artifacts/logs and the orchestrator
// folds state. Because of this single-writer invariant no file lock is needed
// (contrast core.modifyJSON, used for tasks.json which parallel agents share).
// All writes are still atomic (tmp + rename) so a crash can't leave a torn
// file. If a second writer is ever introduced, switch to an append-only event
// log instead of adding a lock.

// buildRoot() is imported from worktree-shared.mjs (call-time X_BUILD_ROOT
// resolution). It is the single source used by every artifact path below.
export function worktreesDir(project) {
  return join(buildRoot(), 'projects', project, 'worktrees');
}

export function worktreeRunDir(project, taskId) {
  return join(worktreesDir(project), taskId);
}

export function runJsonPath(project, taskId) {
  return join(worktreeRunDir(project, taskId), 'run.json');
}

export function preflightPath(project) {
  return join(worktreesDir(project), 'preflight.json');
}

/**
 * Build a fresh run.json record with the plan's minimal schema.
 * Only identity fields are caller-provided; status fields get safe defaults.
 */
export function newRunRecord({ task_id, branch = null, worktree = null, base = null } = {}) {
  if (!task_id) throw new Error('newRunRecord: task_id is required');
  return {
    task_id,
    branch,
    worktree,
    base,
    task_status: TASK_STATUS.RUNNING,
    worktree_status: WORKTREE_STATUS.READY,
    gk_runs: [],
    panel_artifacts: [],
    gk_gate_run_id: null,
    last_error: null,
    recover: [],
  };
}

export function readRun(project, taskId) {
  return readJSON(runJsonPath(project, taskId));
}

/**
 * Initialize (or overwrite) a run.json for a task and persist it atomically.
 * Returns the written record.
 */
export function initRun(project, taskId, fields = {}) {
  const record = newRunRecord({ task_id: taskId, ...fields });
  writeJSON(runJsonPath(project, taskId), record); // core.writeJSON = mkdir + tmp + rename
  return record;
}

/**
 * Partial update of an existing run.json. `patch` may be an object (shallow
 * merged over the current record) or a function (current) => nextRecord.
 * Single-writer, so read-modify-write without a lock is safe (see WRITER
 * CONTRACT above). Throws if the record does not exist — callers must initRun
 * first, so we never resurrect a deleted/absent record silently.
 */
export function updateRun(project, taskId, patch) {
  const current = readRun(project, taskId);
  if (!current) throw new Error(`updateRun: no run.json for task ${taskId} (call initRun first)`);
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  writeJSON(runJsonPath(project, taskId), next);
  return next;
}

/**
 * Compose mapGkFinishResult + persistence: fold a gk finish envelope into the
 * task's run.json. Appends the raw envelope to gk_runs, sets task/worktree
 * status, gk_gate_run_id, last_error, and recover[]. This is the entry point
 * the finish queue (later task) calls after each gk invocation.
 */
export function recordGkFinish(project, taskId, envelope) {
  const mapped = mapGkFinishResult(envelope);
  const save = mapped.save || {};
  return updateRun(project, taskId, (cur) => ({
    ...cur,
    task_status: mapped.task_status,
    worktree_status: mapped.worktree_status,
    gk_runs: [...(cur.gk_runs || []), { at: new Date().toISOString(), envelope }],
    gk_gate_run_id: save.run_id ?? cur.gk_gate_run_id ?? null,
    last_error: save.last_error !== undefined ? save.last_error : cur.last_error,
    recover: save.recover ?? cur.recover ?? [],
  }));
}

export function readPreflight(project) {
  return readJSON(preflightPath(project));
}

export function writePreflight(project, data) {
  writeJSON(preflightPath(project), data);
  return data;
}

// Worktree config (WORKTREE_CONFIG_DEFAULTS / loadWorktreeConfig) is resolved by
// worktree-shared.mjs with the full priority chain
// (CLI flag > .xm/build/config.json > .xm/config.json > defaults) and re-exported
// above so gate-panel and worktrees read from ONE resolver.

// ── subprocess base argv (injectable for tests) ──────────────────────

function parseArgvEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { throw new Error(`Invalid ${name}: ${e.message}`); }
  if (!Array.isArray(arr) || !arr.length || !arr.every(x => typeof x === 'string')) {
    throw new Error(`${name} must be a non-empty JSON string array`);
  }
  return arr;
}

// Default is the real `git-kit`. Tests inject e.g. ["node","/path/fake-gk.mjs"].
function gkBaseArgv() { return parseArgvEnv('X_BUILD_GK_ARGV') || ['git-kit']; }
// Default is the `xm panel` dispatcher (for `panel doctor`). Same var gate-panel
// uses, so a single injection covers both preflight and the gate.
function panelBaseArgv() { return parseArgvEnv('X_BUILD_PANEL_ARGV') || ['xm', 'panel']; }

// ── preflight (capability probe + degraded fallback) ─────────────────
//
// Version-string comparison is unreliable (build/install drift), so we probe the
// actual `--gate` surface (plan "preflight"). No gate surface -> degraded mode:
// we still emit the plan (manual-handoff commands) but never auto-run gk.

export function probeGkGateCapability(cwd = process.cwd()) {
  const base = gkBaseArgv();
  const res = spawnSync(base[0], [...base.slice(1), 'worktree', 'finish', '--help'], {
    cwd, encoding: 'utf8', env: { ...process.env, GK_AGENT: '1' },
  });
  if (res.error) return { gate_capable: false, reason: `gk not available: ${res.error.message}` };
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const capable = /--gate\b/.test(out);
  return {
    gate_capable: capable,
    reason: capable ? null : 'gk `worktree finish` has no --gate flag (upgrade git-kit >= v0.106.0)',
  };
}

export function probePanelDoctor(cwd = process.cwd()) {
  const base = panelBaseArgv();
  const res = spawnSync(base[0], [...base.slice(1), 'doctor', '--json'], { cwd, encoding: 'utf8' });
  if (res.error) return { ok: false, reason: `panel doctor failed to spawn: ${res.error.message}` };
  if (res.status !== 0) return { ok: false, reason: `panel doctor exited ${res.status}` };
  let doctor = null;
  try { doctor = JSON.parse(res.stdout || 'null'); } catch { /* non-JSON is a soft ok */ }
  return { ok: true, reason: null, doctor };
}

export function runPreflight({ project, cwd = process.cwd() } = {}) {
  if (!project) throw new Error('runPreflight: project is required');
  const gk = probeGkGateCapability(cwd);
  const panel = probePanelDoctor(cwd);
  const result = {
    checked_at: new Date().toISOString(),
    gate_capable: gk.gate_capable,
    gk_reason: gk.reason,
    panel_ok: panel.ok,
    panel_reason: panel.reason,
    // degraded when gk cannot enforce a gate — dry-run itself never depends on it.
    degraded: !gk.gate_capable,
  };
  writePreflight(project, result);
  return result;
}

// ── dry-run planning ─────────────────────────────────────────────────

function slugForBranch(name, max = 40) {
  const s = toSlug(name || '').replace(/^-+|-+$/g, '');
  return s.length > max ? s.slice(0, max).replace(/-+$/g, '') : s;
}

// Deterministic collision suffix: candidate, candidate-2, candidate-3, ...
function uniqueBranch(candidate, taken) {
  if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  let n = 2;
  while (taken.has(`${candidate}-${n}`)) n++;
  const b = `${candidate}-${n}`;
  taken.add(b);
  return b;
}

function branchNameFor(prefix, task) {
  const slug = slugForBranch(task.name);
  return `${prefix}${task.id}${slug ? '-' + slug : ''}`;
}

// gk gate template variables {phase} {patch} are LITERAL braces gk substitutes at
// finish time — not JS interpolation. --project is baked in as a literal (gk has
// no {project} var) so the gate never records onto the wrong active project.
function gateCommandString(project, taskId) {
  // Trust boundary (F3/F10): project/taskId are interpolated into the gk gate
  // command template that gk later tokenizes into argv. Reject traversal /
  // flag-injection segments here so a bad id can never reach gk's argv.
  const err = validateIdSegment(project, 'project') || validateIdSegment(taskId, 'task id');
  if (err) throw new Error(`gateCommandString: ${err}`);
  return `xm build gate-panel --project ${project} --task ${taskId} --phase {phase} --patch {patch} --json`;
}

// Ready = pending/ready tasks whose deps are all completed. Pure over taskData.
export function selectReadyTasks(taskData) {
  const tasks = taskData?.tasks || [];
  const byId = new Map(tasks.map(t => [t.id, t]));
  return tasks.filter(t => {
    if (!['ready', 'pending'].includes(t.status)) return false;
    return (t.depends_on || []).every(d => byId.get(d)?.status === 'completed');
  });
}

/**
 * Compute the worktree plan WITHOUT touching gk (dry-run). Pure over its inputs:
 * pass ready tasks + config + the set of existing branch names. Emits parallel
 * batches (expected_files-safe tasks chunked by max_parallel), sequential tasks
 * (unknown/overlapping -> one at a time), and per-task gk command plan strings.
 */
export function planWorktrees({
  project, tasks = [], config = WORKTREE_CONFIG_DEFAULTS,
  existingBranches = [], worktreeBase = null, degraded = false,
} = {}) {
  if (!project) throw new Error('planWorktrees: project is required');
  const base = config.base ?? 'develop';
  const prefix = config.branch_prefix ?? 'feat/';
  const maxParallel = Math.max(1, Number(config.max_parallel) || 1);
  const gatePhase = config.gate_phase ?? 'before';
  const cleanup = config.cleanup !== false;

  // gate_phase 'release' defers ALL gating to the pre-release integration review
  // (review-integration): per-task finishes merge UNGATED. This also fixes the
  // pass-through bug where 'release' leaked into gk's --gate-phase, which only
  // accepts before|after|both (plan §3B).
  const gateDeferred = gatePhase === 'release';

  const { safe, sequential, reason } = isParallelSafe(tasks);
  const taken = new Set(existingBranches);

  const entries = [];
  for (const t of tasks) {
    const branch = uniqueBranch(branchNameFor(prefix, t), taken);
    const finishParts = [
      'GK_AGENT=1 git-kit worktree finish',
      `--to ${base}`,
    ];
    if (!gateDeferred) {
      const gateCmd = gateCommandString(project, t.id);
      finishParts.push(`--gate ${JSON.stringify(gateCmd)}`, `--gate-phase ${gatePhase}`);
    }
    if (cleanup) finishParts.push('--cleanup');
    entries.push({
      task_id: t.id,
      name: t.name,
      parallel_safe: safe.includes(t.id),
      branch,
      // Predicted gk-managed worktree path (gk decides the real path at acquire;
      // this is a hint from the observed ~/.gk/worktree/<repo>/<branch> layout).
      worktree_hint: worktreeBase ? join(worktreeBase, branch) : null,
      acquire: `GK_AGENT=1 git-kit worktree acquire ${branch} --from ${base}`,
      finish: finishParts.join(' '),
    });
  }

  const parallel_batches = [];
  for (let i = 0; i < safe.length; i += maxParallel) {
    parallel_batches.push(safe.slice(i, i + maxParallel));
  }

  return {
    project, base, branch_prefix: prefix, max_parallel: maxParallel,
    gate: config.gate ?? 'panel', gate_phase: gatePhase, gate_deferred: gateDeferred,
    degraded, mode: degraded ? 'manual-handoff' : 'dry-run',
    parallel_batches, sequential, reason,
    tasks: entries,
  };
}

// Collect local branch names. spawnSync (NOT a shell) so a hostile branch/repo
// name can never be interpreted by /bin/sh (F9). Exported so both the dry-run
// planner and the real fan-out path feed planWorktrees the same collision set.
export function listExistingBranches(cwd = process.cwd()) {
  const res = spawnSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
    cwd, encoding: 'utf8',
  });
  if (res.error || res.status !== 0) return [];
  return (res.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// ── worktree acquire + TASK-CONTEXT snapshot + env injection ──────────

/**
 * Render the canonical TASK-CONTEXT markdown (plan template). This is the shared
 * ground for agent handoff, review, and failure recovery.
 */
export function renderTaskContext(task) {
  const dc = Array.isArray(task.done_criteria) ? task.done_criteria : [];
  const ef = normalizeExpectedFiles(task.expected_files);
  const deps = Array.isArray(task.depends_on) ? task.depends_on : [];
  return [
    '# Task',
    `${task.id}: ${task.name}`,
    '',
    '## Scope',
    task.description || '(no description — see the PRD slice for this task)',
    '',
    '## Done Criteria',
    ...(dc.length ? dc.map(c => `- ${c}`) : ['- (none specified)']),
    '',
    '## Expected Files',
    ...(ef.length ? ef.map(f => `- ${f}`) : ['- (none specified — task is not parallel-safe)']),
    '',
    '## Dependencies',
    ...(deps.length ? deps.map(d => `- ${d}`) : ['- (none)']),
    '',
    '## Verification',
    '- Run the project quality checks before finishing.',
    '- Confirm every Done Criteria item above is met.',
    '- Before finishing, self-review your FULL diff at low cost (async/race state',
    '  transitions, error paths, boundary values, resource cleanup). The merge gate',
    '  is an expensive cross-vendor panel (~10-15 min per round) — converge cheaply',
    '  first.',
    '- If the gate fails, fix the whole CATEGORY of each finding (one async-race',
    '  finding → audit every similar transition in your diff), not just the quoted',
    '  line. Partial fixes cost another full gate round.',
    '',
  ].join('\n');
}

export function taskContextArtifactPath(project, taskId) {
  return join(worktreeRunDir(project, taskId), 'task-context.md');
}

function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
  return path;
}

// Resolve info/exclude for a (possibly linked) worktree. Linked worktrees share
// the common .git, so `git -C <wt> rev-parse --git-path info/exclude` is the
// only correct way to find it (plan "worktree context").
function excludePathFor(worktreePath) {
  const res = spawnSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    throw new Error(`could not resolve git exclude path for ${worktreePath}: ${(res.stderr || res.error?.message || '').trim()}`);
  }
  return resolve(worktreePath, res.stdout.trim());
}

/**
 * Register `entry` in the worktree's info/exclude so the TASK-CONTEXT snapshot is
 * never committed to the feature branch. Idempotent.
 */
export function registerWorktreeExclude(worktreePath, entry = 'TASK-CONTEXT.md') {
  const excludePath = excludePathFor(worktreePath);
  mkdirSync(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (existing.split('\n').map(l => l.trim()).includes(entry)) {
    return { excludePath, added: false };
  }
  const next = (existing && !existing.endsWith('\n') ? existing + '\n' : existing) + entry + '\n';
  writeFileSync(excludePath, next, 'utf8');
  return { excludePath, added: true };
}

/**
 * Write the canonical task-context.md artifact, snapshot it into the worktree as
 * TASK-CONTEXT.md, and exclude that snapshot. The artifact is the source of
 * truth; the snapshot is a regenerated copy (plan "canonical 규칙").
 */
export function writeTaskContextSnapshot(project, task, worktreePath) {
  const content = renderTaskContext(task);
  const artifactPath = writeFileAtomic(taskContextArtifactPath(project, task.id), content);
  const snapshotPath = join(worktreePath, 'TASK-CONTEXT.md');
  writeFileSync(snapshotPath, content, 'utf8');
  const excl = registerWorktreeExclude(worktreePath, 'TASK-CONTEXT.md');
  return { artifactPath, snapshotPath, excludePath: excl.excludePath };
}

// ── gate findings feedback (plan §3G) ────────────────────────────────
//
// On a gate fail the findings used to reach the fix agent only via a manual
// orchestrator relay. Instead, fold them straight into the task context: a
// marker-delimited section is REPLACED (never appended twice) in both the
// canonical task-context artifact and the worktree TASK-CONTEXT.md snapshot,
// so round N always shows the latest findings exactly once.

const GATE_FINDINGS_START = '<!-- xm:gate-findings:start -->';
const GATE_FINDINGS_END = '<!-- xm:gate-findings:end -->';

// Replace the marker-delimited section in `content` (or append when absent).
export function upsertGateFindingsSection(content, section) {
  const start = content.indexOf(GATE_FINDINGS_START);
  const end = content.indexOf(GATE_FINDINGS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + section + content.slice(end + GATE_FINDINGS_END.length);
  }
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  return content + sep + section + '\n';
}

export function renderGateFindingsSection(gateArtifact) {
  const blocking = gateArtifact.blocking_findings || [];
  const advisory = gateArtifact.advisory_findings || [];
  const lines = [
    GATE_FINDINGS_START,
    `## Gate Findings — ${gateArtifact.phase} round ${gateArtifact.round ?? 1} (BLOCKED)`,
    '',
    'The merge gate blocked this branch. Fix every blocking finding below, run the',
    'quality checks, commit in this worktree, then the orchestrator resumes the merge.',
    'Fix the whole CATEGORY of each finding (one async-race finding → audit every',
    'similar transition in your diff), not just the quoted line — partial fixes cost',
    'another full gate round.',
    '',
    '### Blocking',
    ...(blocking.length
      ? blocking.map(b => `- [${b.severity ?? '?'}/${b.kind ?? '?'}] ${b.file ?? '?'}:${b.line ?? '?'} — ${b.claim ?? ''}`)
      : ['- (none recorded — see the gate artifact / pre-gate output)']),
  ];
  if (gateArtifact.pre_gate?.status === 'fail' && gateArtifact.pre_gate.output_tail) {
    lines.push('', '### Pre-gate output', '```', gateArtifact.pre_gate.output_tail, '```');
  }
  if (advisory.length) {
    lines.push('', '### Advisory (non-blocking — fix alongside if cheap, else they queue for the release review)',
      ...advisory.map(a => `- [${a.severity ?? '?'}] ${a.file ?? '?'}:${a.line ?? '?'} — ${a.claim ?? ''}`));
  }
  lines.push(GATE_FINDINGS_END);
  return lines.join('\n');
}

/**
 * Fold a failed gate's findings into the task context (canonical artifact +
 * worktree snapshot). No-op unless the gate artifact exists with decision
 * 'fail'. Failures WARN on stderr but never break the finish flow — feedback
 * injection is assistance, not a gate.
 * @returns {{ injected: boolean, reason?: string }}
 */
export function injectGateFindings({ project, taskId, phase, worktreePath }) {
  try {
    const art = readJSON(join(worktreeRunDir(project, taskId), `panel-${phase}.json`));
    if (!art || art.decision !== 'fail') return { injected: false, reason: 'no failed gate artifact' };
    const section = renderGateFindingsSection(art);

    const canonicalPath = taskContextArtifactPath(project, taskId);
    const canonical = existsSync(canonicalPath) ? readFileSync(canonicalPath, 'utf8') : '';
    const nextCanonical = upsertGateFindingsSection(canonical, section);
    writeFileAtomic(canonicalPath, nextCanonical);

    if (worktreePath && existsSync(worktreePath)) {
      const snapshotPath = join(worktreePath, 'TASK-CONTEXT.md');
      const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : nextCanonical;
      writeFileSync(snapshotPath, upsertGateFindingsSection(snapshot, section), 'utf8');
      // Re-assert the exclude: the snapshot must never dirty the worktree, or the
      // resume dirty-guard would trip on our own feedback file.
      registerWorktreeExclude(worktreePath, 'TASK-CONTEXT.md');
    }
    return { injected: true };
  } catch (e) {
    process.stderr.write(`${C.yellow}⚠ gate findings feedback failed for ${taskId} (${phase}): ${e.message}${C.reset}\n`);
    return { injected: false, reason: e.message };
  }
}

/**
 * Root env dict to inject into worktree agent processes AND the gk finish call.
 * XM_ROOT alone is NOT enough — x-build core reads X_BUILD_ROOT and x-panel reads
 * X_PANEL_ROOT, neither of which falls back to the main repo from a worktree cwd
 * (plan "root env 주입 계약").
 */
export function buildAgentEnv(mainRepoRoot) {
  if (!mainRepoRoot) throw new Error('buildAgentEnv: mainRepoRoot is required');
  const xm = join(mainRepoRoot, '.xm');
  return {
    X_BUILD_ROOT: join(xm, 'build'),
    X_PANEL_ROOT: xm,
    XM_ROOT: xm,
  };
}

/**
 * Acquire (create or reuse) a gk worktree for a task, initialize its run.json,
 * and drop the TASK-CONTEXT snapshot. Branches on the gk agent-mode envelope:
 *   state ok       -> WORKTREE_CREATED + snapshot
 *   blocked/error  -> BLOCKED, remedies saved (no snapshot)
 */
export function acquireWorktree({ project, task, config = WORKTREE_CONFIG_DEFAULTS, branch = null, cwd = process.cwd() } = {}) {
  if (!project) throw new Error('acquireWorktree: project is required');
  if (!task?.id) throw new Error('acquireWorktree: task with an id is required');
  // Trust boundary (F10): task.id is spliced into the branch name that becomes gk
  // acquire argv. Validate it before it reaches spawnSync argv.
  const idErr = validateIdSegment(task.id, 'task id');
  if (idErr) throw new Error(`acquireWorktree: ${idErr}`);
  const base = config.base ?? 'develop';
  const prefix = config.branch_prefix ?? 'feat/';
  const br = branch || branchNameFor(prefix, task);

  const gk = gkBaseArgv();
  const args = [...gk.slice(1), 'worktree', 'acquire', br, '--from', base, '--json'];
  const res = spawnSync(gk[0], args, { cwd, encoding: 'utf8', env: { ...process.env, GK_AGENT: '1' } });

  if (res.error) {
    initRun(project, task.id, { branch: br, base });
    updateRun(project, task.id, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: { code: 'acquire_spawn_failed', message: res.error.message },
    });
    return { ok: false, branch: br, envelope: null, error: res.error.message };
  }

  const envelope = parseAgentEnvelope(res);
  if (!envelope) {
    initRun(project, task.id, { branch: br, base });
    updateRun(project, task.id, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: { code: 'acquire_unparseable', message: 'no agent-mode envelope on stdout/stderr', ...envelopeStreamsTail(res) },
    });
    return { ok: false, branch: br, envelope: null, error: 'unparseable acquire envelope' };
  }

  if (envelope?.state === 'ok') {
    const worktreePath = envelope?.result?.path || null;
    // ok without a path is NOT a usable acquire: every later step (agent cwd,
    // finish, resume) needs the worktree location. Treat it as a failure.
    if (!worktreePath) {
      initRun(project, task.id, { branch: br, base });
      updateRun(project, task.id, {
        worktree_status: WORKTREE_STATUS.BLOCKED,
        last_error: { code: 'acquire_no_path', message: 'gk acquire returned ok without result.path' },
      });
      return { ok: false, branch: br, envelope, error: 'gk acquire returned ok without result.path' };
    }
    initRun(project, task.id, { branch: br, worktree: worktreePath, base });
    updateRun(project, task.id, { worktree_status: WORKTREE_STATUS.WORKTREE_CREATED });
    const context = writeTaskContextSnapshot(project, task, worktreePath);
    return { ok: true, branch: br, worktree: worktreePath, envelope, context };
  }

  const remedies = envelope?.error?.remedies ?? [];
  initRun(project, task.id, { branch: br, base });
  updateRun(project, task.id, {
    worktree_status: WORKTREE_STATUS.BLOCKED,
    last_error: envelope?.error ?? { code: envelope?.state || 'acquire_failed' },
    recover: remedies,
  });
  return { ok: false, branch: br, envelope, error: envelope?.error?.message || envelope?.state || 'acquire failed' };
}

// ── serialized finish queue (t7) ─────────────────────────────────────
//
// gk gate runs UNDER the target merge lock, so a panel (minutes) holds the
// develop lock the whole time. Firing several finishes in parallel just makes
// the losers bounce off `worktree_gate_locked`. So xm serializes the finish
// calls itself — one at a time — instead of relying on lock-retry churn. The
// `worktree_gate_locked` retry (once, with backoff) stays only as a defense
// against an EXTERNAL lock holder (plan "finish 직렬화").

// Call-time tasks.json path (mirror gate-panel's pattern): core.tasksPath is
// bound to the import-time ROOT, which is wrong when X_BUILD_ROOT is set after
// import (tests, worktree cwd). Derive from the call-time build root instead.
function taskDataPath(project) {
  return join(buildRoot(), 'projects', project, 'phases', '02-plan', 'tasks.json');
}

function plannedTaskCheckPassed(project, taskId, cwd) {
  const planState = join(buildRoot(), 'projects', project, 'phases', '02-plan', 'plan-state.json');
  if (!existsSync(planState)) return true; // legacy projects
  const task = readJSON(taskDataPath(project))?.tasks?.find((row) => row.id === taskId);
  const evidence = task?.task_check;
  const currentFingerprint = taskCheckFingerprint(cwd);
  return evidence?.passed === true
    && !!evidence.worktree_fingerprint
    && !!currentFingerprint
    && resolve(evidence.cwd || '.') === resolve(cwd)
    && evidence.contract_hash === taskCheckContractHash(cwd)
    && evidence.worktree_fingerprint === currentFingerprint;
}

// Mark a task completed in tasks.json. Uses core.modifyJSON (locked, atomic)
// directly rather than importing tasks.mjs — worktrees.mjs and tasks.mjs already
// have a runtime-bound circular import, and pulling tasks.mjs in here for a
// status flip would deepen it. Single canonical writer of tasks.json stays
// modifyJSON. Returns true if a task row was updated.
//
// Bookkeeping parity with `tasks update --status completed --no-commit`
// (tasks.mjs): stamp completed_at and emit the task_complete metric so
// gate-driven completions show up in cost/quality observability exactly like
// agent-driven ones. gitAutoCommit is intentionally skipped — the merge is
// gk's, not x-build's.
function markTaskCompleted(project, taskId) {
  const path = taskDataPath(project);
  if (!existsSync(path)) return false;
  let taskRef = null;
  modifyJSON(path, (data) => {
    const t = data?.tasks?.find((x) => x.id === taskId);
    if (t) {
      t.status = TASK_STATUS.COMPLETED;
      t.completed_at = new Date().toISOString();
      taskRef = { ...t };
    }
    return data;
  });
  if (taskRef?.started_at) {
    appendMetric({
      type: 'task_complete', project, taskId, taskName: taskRef.name,
      role: taskRef.role || 'executor',
      model: taskRef._assigned_model || 'sonnet',
      size: taskRef.size || 'medium',
      strategy: taskRef.strategy || null,
      cost_usd: taskRef._estimated_cost || 0,
      cost_source: 'estimated',
      actual_cost_usd: null,
      estimated_cost_usd: taskRef._estimated_cost ?? null,
      tokens_in: null,
      tokens_out: null,
      quality_score: taskRef.score != null ? taskRef.score : 1,
      success: true,
      retry_count: taskRef.retry_count || 0,
      failure_reason: null,
      routing_decision_id: taskRef._routing_decision_id || null,
      correlation_id: taskRef._routing_decision_id || generateCorrelationId(),
      duration_ms: new Date(taskRef.completed_at) - new Date(taskRef.started_at),
      timestamp: taskRef.completed_at,
    });
  }
  return taskRef != null;
}

// Synchronous sleep without spinning the CPU. Used for the single locked-retry
// backoff. spawnSync already blocks, so no async is needed here.
function sleepMs(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Spawn one `gk worktree finish` for a task. cwd is the task's own worktree (so
// gk resolves the linked worktree correctly); the root env is injected pointing
// at the MAIN repo .xm/ so the gate-panel child sees canonical state even from
// inside the worktree (plan "root env 주입 계약").
function runGkFinishOnce({ project, taskId, base, gatePhase, cleanup, worktreeCwd, agentEnv }) {
  const gk = gkBaseArgv();
  const args = [...gk.slice(1), 'worktree', 'finish', '--to', base];
  // gate_phase 'release' = UNGATED per-task merge; gating happens once at
  // review-integration (plan §3B). Never pass 'release' to gk — its --gate-phase
  // only accepts before|after|both.
  if (gatePhase !== 'release') {
    args.push('--gate', gateCommandString(project, taskId), '--gate-phase', gatePhase);
  }
  if (cleanup) args.push('--cleanup');
  args.push('--json');
  return spawnSync(gk[0], args, {
    cwd: worktreeCwd, encoding: 'utf8',
    env: { ...process.env, GK_AGENT: '1', ...agentEnv },
  });
}

// Parse + persist one finish result. Never silences failure: spawn/parse errors
// become a visible BLOCKED with last_error rather than being dropped. Returns
// the mapped decision (task_status/worktree_status/retryable) plus an `error`.
function applyFinishResult(project, taskId, res) {
  if (res.error) {
    updateRun(project, taskId, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: { code: 'finish_spawn_failed', message: res.error.message },
    });
    return { task_status: TASK_STATUS.RUNNING, worktree_status: WORKTREE_STATUS.BLOCKED, retryable: false, error: res.error.message };
  }
  const envelope = parseAgentEnvelope(res);
  if (!envelope || typeof envelope !== 'object' || typeof envelope.state !== 'string') {
    updateRun(project, taskId, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: { code: 'finish_empty_envelope', message: 'gk finish produced no agent-mode envelope on stdout/stderr', ...envelopeStreamsTail(res) },
    });
    return { task_status: TASK_STATUS.RUNNING, worktree_status: WORKTREE_STATUS.BLOCKED, retryable: false, error: 'empty finish envelope' };
  }
  const mapped = mapGkFinishResult(envelope);   // decision (incl. retryable)
  recordGkFinish(project, taskId, envelope);    // map+persist entry point
  return { task_status: mapped.task_status, worktree_status: mapped.worktree_status, retryable: mapped.retryable, error: null };
}

// Finish a single task, with one locked-retry. Reads run.json for the worktree
// path; falls back to `cwd` when the worktree path is absent/gone.
function finishOne({ project, taskId, base, gatePhase, cleanup, cwd, agentEnv, backoffMs }) {
  const run = readRun(project, taskId);
  const worktreeCwd = run?.worktree && existsSync(run.worktree) ? run.worktree : cwd;
  if (!plannedTaskCheckPassed(project, taskId, worktreeCwd)) {
    updateRun(project, taskId, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: { code: 'task_checks_missing', message: `run x-build task-check ${taskId} in the task worktree before finish` },
    });
    return {
      task_id: taskId,
      task_status: TASK_STATUS.RUNNING,
      worktree_status: WORKTREE_STATUS.BLOCKED,
      retried: false,
      error: 'task_checks_missing',
    };
  }
  const spawnArgs = { project, taskId, base, gatePhase, cleanup, worktreeCwd, agentEnv };

  let outcome = applyFinishResult(project, taskId, runGkFinishOnce(spawnArgs));
  let retried = false;
  if (outcome.retryable) {
    // worktree_gate_locked → an external holder may free the lock; back off once.
    sleepMs(backoffMs);
    retried = true;
    outcome = applyFinishResult(project, taskId, runGkFinishOnce(spawnArgs));
  }
  if (outcome.task_status === TASK_STATUS.COMPLETED) markTaskCompleted(project, taskId);

  // Gate fail → fold the findings into the task context so the fix agent gets
  // them without a manual orchestrator relay (plan §3G). NEEDS_FIX from other
  // causes (dirty guard) is a no-op inside — it requires a failed gate artifact.
  // Only a REAL worktree path gets the snapshot (never the fallback cwd).
  if (outcome.worktree_status === WORKTREE_STATUS.NEEDS_FIX) {
    const wtPath = run?.worktree && existsSync(run.worktree) ? run.worktree : null;
    injectGateFindings({ project, taskId, phase: gatePhase, worktreePath: wtPath });
  }

  return {
    task_id: taskId,
    task_status: outcome.task_status,
    worktree_status: outcome.worktree_status,
    retried,
    error: outcome.error,
  };
}

/**
 * Serialized finish queue. Runs `gk worktree finish` for each task ONE AT A TIME
 * (never in parallel — see section header). Each finish is mapped+persisted via
 * recordGkFinish; on `ok` the task is flipped to completed in tasks.json. A
 * `worktree_gate_locked` result is retried once with backoff, then left MERGING
 * and the queue continues. after-gate paused / merge-conflict → BLOCKED, recover
 * saved, cleanup withheld (gk already withholds it), queue continues.
 *
 * This is the entry point t10 (orchestrator) drives.
 *
 * @param {{project:string, taskIds:string[], config?:object, cwd?:string}} o
 * @returns {{project:string, base:string, results:Array<{
 *   task_id:string, task_status:string, worktree_status:string,
 *   retried:boolean, error:string|null }>}}
 */
export function finishWorktrees({ project, taskIds = [], config = WORKTREE_CONFIG_DEFAULTS, cwd = process.cwd() } = {}) {
  if (!project) throw new Error('finishWorktrees: project is required');
  const base = config.base ?? 'develop';
  const gatePhase = config.gate_phase ?? 'before';
  const cleanup = config.cleanup !== false;
  const backoffMs = config.gate_lock_backoff_ms ?? WORKTREE_CONFIG_DEFAULTS.gate_lock_backoff_ms;
  // cwd may be a linked worktree — resolve the MAIN repo root via git-common-dir
  // so the injected root env points at the main .xm/, not the worktree's (F6/F7).
  const mainRepoRoot = resolveMainRepoRoot(cwd) || resolve(cwd);
  const agentEnv = buildAgentEnv(mainRepoRoot);

  const results = [];
  for (const taskId of taskIds) {   // SERIAL: target merge lock is held per finish.
    // One malformed envelope (mapGkFinishResult throws on unknown state) must
    // fail THAT task, not abort the rest of the queue.
    try {
      results.push(finishOne({ project, taskId, base, gatePhase, cleanup, cwd, agentEnv, backoffMs }));
    } catch (e) {
      try {
        updateRun(project, taskId, {
          worktree_status: WORKTREE_STATUS.BLOCKED,
          last_error: { code: 'finish_exception', message: e.message },
        });
      } catch { /* run.json may not exist — the result row still surfaces it */ }
      results.push({ task_id: taskId, task_status: TASK_STATUS.RUNNING, worktree_status: WORKTREE_STATUS.BLOCKED, retried: false, error: e.message });
    }
  }
  return { project, base, results };
}

// ── resume (base drift resolution → re-gate) (t7) ────────────────────
//
// A NEEDS_FIX/MERGING worktree goes stale while other features land on develop.
// gk's target lock guarantees textual consistency at merge time but cannot catch
// semantic drift on an old base. `worktrees resume` therefore: (a) refuses a
// dirty tree (gk would block anyway), (b) resolves base drift via `gk sync`
// (never a raw git rebase — gk owns git correctness; on conflict it pauses and
// we stop with resume/abort remedies), then (c) enters the finish queue.
// after-gate paused (BLOCKED) is NOT a resume target: --resume-accept is a human
// decision (plan 비목표) — we only print guidance.

// True when the worktree has uncommitted changes. Linked worktrees are fine —
// `git -C <wt> status --porcelain` resolves the shared .git correctly.
function worktreeIsDirty(worktreePath) {
  const res = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
  if (res.error) throw new Error(`could not check worktree status for ${worktreePath}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git status in ${worktreePath} exited ${res.status}: ${(res.stderr || '').trim()}`);
  return (res.stdout || '').trim().length > 0;
}

// Resolve base drift with `gk sync` inside the worktree (agent mode). Returns a
// discriminated result the caller folds into run.json. Never runs raw git rebase.
// base is passed explicitly (`--base`) — gk's auto-detect needs a remote default
// branch and fails in local-only repos (measured in E2E), while the pipeline
// always knows its base from run.json/config.
function gkSync(worktreeCwd, agentEnv, base) {
  const gk = gkBaseArgv();
  const baseArgs = base ? ['--base', base] : [];
  const res = spawnSync(gk[0], [...gk.slice(1), 'sync', ...baseArgs, '--json'], {
    cwd: worktreeCwd, encoding: 'utf8',
    env: { ...process.env, GK_AGENT: '1', ...agentEnv },
  });
  if (res.error) return { ok: false, paused: false, error: { code: 'sync_spawn_failed', message: res.error.message }, remedies: [] };
  const envelope = parseAgentEnvelope(res);
  if (!envelope) {
    // Measured (gk v0.106.0): `gk sync` does NOT implement the agent-mode
    // envelope — GK_AGENT=1 --json still prints only human progress text. Fall
    // back to the exit code: 0 = integrated/up-to-date, non-zero = failure
    // (conflict pauses included — without an envelope we cannot distinguish, so
    // surface the stream tails and block).
    if (res.status === 0) return { ok: true, paused: false, envelope: null };
    return { ok: false, paused: false, error: { code: 'sync_failed', message: `gk sync exited ${res.status} with no agent-mode envelope`, ...envelopeStreamsTail(res) }, remedies: [] };
  }
  const state = envelope?.state;
  if (state === 'ok') return { ok: true, paused: false, envelope };
  if (state === 'paused') {
    // Conflict — stop per gk contract, save resume/abort remedies.
    const remedies = envelope?.result?.remedies ?? envelope?.error?.remedies ?? [];
    return { ok: false, paused: true, error: envelope?.error ?? { code: 'sync_conflict', message: 'gk sync paused (conflict)' }, remedies };
  }
  // blocked / error — save remedies, BLOCKED.
  const remedies = envelope?.error?.remedies ?? [];
  return { ok: false, paused: false, error: envelope?.error ?? { code: state || 'sync_failed' }, remedies };
}

// Worktree statuses that `resume` drives into the dirty-guard → sync → finish
// queue. Everything EXCEPT BLOCKED (human call) and DONE (already merged) is a
// resume target — this includes the happy-path states (WORKTREE_CREATED, RUNNING,
// VERIFYING, REVIEWING) so `resume` is the single finish-entry CLI (F2). READY is
// excluded: it has no worktree yet (acquire not done), so there is nothing to
// finish — it would only trip the worktree-missing guard.
const RESUME_TARGET_STATUSES = new Set([
  WORKTREE_STATUS.NEEDS_FIX,
  WORKTREE_STATUS.MERGING,
  WORKTREE_STATUS.WORKTREE_CREATED,
  WORKTREE_STATUS.RUNNING,
  WORKTREE_STATUS.VERIFYING,
  WORKTREE_STATUS.REVIEWING,
]);

// BLOCKED that carries a gk `--resume-accept` recover command is an after-gate
// pause — accepting or rewinding a merged-but-gate-failed integration is a
// human decision (plan 비목표). Any other BLOCKED (sync/spawn/parse/infra
// failure) is retryable via `worktrees resume` once the cause is fixed.
function isHumanDecisionBlocked(run) {
  return (run?.recover ?? []).some(r => typeof r?.command === 'string' && r.command.includes('--resume-accept'));
}

/**
 * Resume one task: dirty guard → gk sync → finish queue. Returns a per-task
 * outcome record. after-gate BLOCKED tasks are skipped with guidance.
 */
function resumeOne({ project, taskId, config, cwd, agentEnv }) {
  const run = readRun(project, taskId);
  if (!run) return { task_id: taskId, action: 'skip', reason: 'no run.json — nothing to resume' };

  const ws = run.worktree_status;
  // BLOCKED = after-gate paused / merge conflict / infra — human call, not
  // auto-resumable. Everything except DONE (and pre-acquire READY) is a
  // finish-queue target (F2). BLOCKED splits in two (measured in E2E):
  //   - after-gate paused (recover[] carries --resume-accept): a HUMAN decision,
  //     never auto-resumed;
  //   - infra failure (sync/spawn/parse error): retryable once the cause is
  //     fixed — refusing these strands the task with no CLI path forward.
  if (!RESUME_TARGET_STATUSES.has(ws)) {
    if (ws === WORKTREE_STATUS.BLOCKED && !isHumanDecisionBlocked(run)) {
      // fall through: retryable infra BLOCKED re-enters the resume path.
    } else if (ws === WORKTREE_STATUS.BLOCKED) {
      return {
        task_id: taskId, action: 'skip', reason: 'BLOCKED (after-gate paused) is not auto-resumable',
        guidance: 'Review the paused state, then run the gk `--resume-accept` (accept) or a recover[] rewind (reject) by hand — this is a human decision.',
        recover: run.recover ?? [],
      };
    } else {
      return { task_id: taskId, action: 'skip', reason: `worktree_status ${ws} is not a resume target (DONE/READY are excluded)` };
    }
  }

  const worktreeCwd = run.worktree && existsSync(run.worktree) ? run.worktree : null;
  if (!worktreeCwd) {
    updateRun(project, taskId, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: { code: 'worktree_missing', message: `worktree path missing: ${run.worktree ?? '(none)'}` },
    });
    return { task_id: taskId, action: 'blocked', reason: 'worktree path missing' };
  }

  // (a) dirty guard — keep NEEDS_FIX, let the human commit/discard first.
  let dirty;
  try { dirty = worktreeIsDirty(worktreeCwd); } catch (e) {
    updateRun(project, taskId, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: { code: 'status_failed', message: e.message },
    });
    return { task_id: taskId, action: 'blocked', reason: e.message };
  }
  if (dirty) {
    // Do not downgrade below NEEDS_FIX; gk would block a dirty finish anyway.
    updateRun(project, taskId, { worktree_status: WORKTREE_STATUS.NEEDS_FIX });
    return {
      task_id: taskId, action: 'skip', reason: 'worktree has uncommitted changes',
      guidance: 'Commit or discard changes in the worktree, then resume again.',
    };
  }

  // (b) base drift → gk sync (never raw git rebase).
  const sync = gkSync(worktreeCwd, agentEnv, run.base || config.base || null);
  if (!sync.ok) {
    updateRun(project, taskId, {
      worktree_status: WORKTREE_STATUS.BLOCKED,
      last_error: sync.error,
      recover: sync.remedies ?? [],
    });
    return { task_id: taskId, action: 'blocked', reason: sync.paused ? 'gk sync paused (conflict)' : `gk sync failed: ${sync.error?.message ?? sync.error?.code}`, recover: sync.remedies ?? [] };
  }

  // (c) re-enter the finish queue for this task.
  const finished = finishWorktrees({ project, taskIds: [taskId], config, cwd }).results[0];
  return { task_id: taskId, action: 'finished', ...finished };
}

/**
 * Resume resumable worktree tasks: base drift resolution then re-gate. Targets
 * every status except BLOCKED/DONE/READY (see RESUME_TARGET_STATUSES) so this is
 * the single happy-path finish-entry CLI (F2). If no taskIds given, resumes every
 * resumable task recorded for the project. Serial (each ends in the finish queue).
 *
 * @param {{project:string, taskIds?:string[], config?:object, cwd?:string}} o
 */
export function resumeWorktrees({ project, taskIds = null, config = WORKTREE_CONFIG_DEFAULTS, cwd = process.cwd() } = {}) {
  if (!project) throw new Error('resumeWorktrees: project is required');
  // Resolve MAIN repo root from a possibly-worktree cwd (F6/F7) — same helper as
  // finishWorktrees/gate-panel so the injected root env never diverges.
  const mainRepoRoot = resolveMainRepoRoot(cwd) || resolve(cwd);
  const agentEnv = buildAgentEnv(mainRepoRoot);

  let ids = taskIds;
  if (!ids || !ids.length) {
    // Default target set: every resumable task with a run.json — statuses in
    // RESUME_TARGET_STATUSES plus retryable-infra BLOCKED (an after-gate paused
    // BLOCKED stays a human decision and is excluded; see isHumanDecisionBlocked).
    ids = [];
    const dir = worktreesDir(project);
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        const r = readRun(project, entry);
        if (!r) continue;
        const retryableBlocked = r.worktree_status === WORKTREE_STATUS.BLOCKED && !isHumanDecisionBlocked(r);
        if (RESUME_TARGET_STATUSES.has(r.worktree_status) || retryableBlocked) {
          ids.push(r.task_id);
        }
      }
    }
  }

  const results = [];
  for (const taskId of ids) {
    try {
      results.push(resumeOne({ project, taskId, config, cwd, agentEnv }));
    } catch (e) {
      try {
        updateRun(project, taskId, {
          worktree_status: WORKTREE_STATUS.BLOCKED,
          last_error: { code: 'resume_exception', message: e.message },
        });
      } catch { /* run.json may not exist — the result row still surfaces it */ }
      results.push({ task_id: taskId, action: 'blocked', reason: e.message });
    }
  }
  return { project, results };
}

// ── review-integration (release-time main...develop batch review) ─────
//
// Feature review asks "may this feature merge into develop?". Batch review asks
// "does the accumulated develop break when the features sit together?" There is
// no gk verb for this — we build the patch with raw git and apply gate-panel
// policy under the reserved __integration__ id / release phase (plan
// "release 전 batch review").

export const INTEGRATION_TASK_ID = '__integration__';

// Resolve a ref's commit sha; null when unresolvable (missing branch, not a repo).
function gitHeadOf(cwd, ref) {
  const res = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd, encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').trim() || null;
}

// Sidecar recording WHAT the integration review judged (target head sha) so
// `worktrees status` can tell a pass from a stale pass after develop moved
// (plan §3B release guard, v1 = visibility).
export function integrationStatePath(project) {
  return join(worktreeRunDir(project, INTEGRATION_TASK_ID), 'integration-state.json');
}

export function reviewIntegration({ project, base = 'main', target = 'develop', cwd = process.cwd(), maxPatchBytes = null } = {}) {
  if (!project) throw new Error('reviewIntegration: project is required');
  const targetHead = gitHeadOf(cwd, target);
  const res = spawnSync('git', ['diff', '--binary', `${base}...${target}`], {
    cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw new Error(`git diff failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git diff ${base}...${target} exited ${res.status}: ${(res.stderr || '').trim()}`);
  const patch = res.stdout || '';
  const patchBytes = Buffer.byteLength(patch, 'utf8');

  const patchPath = join(worktreeRunDir(project, INTEGRATION_TASK_ID), 'patch-release.diff');
  writeFileAtomic(patchPath, patch);

  // Size guard: warn only (never block on size) — the cap is measured, not judged.
  let sizeWarning = null;
  if (maxPatchBytes != null && patchBytes > maxPatchBytes) {
    sizeWarning = `integration patch ${patchBytes}B exceeds configured cap ${maxPatchBytes}B — consider a subsystem-split review`;
  }

  const gate = runGatePanel({ project, taskId: INTEGRATION_TASK_ID, phase: 'release', patch: patchPath, cwd });

  writeJSON(integrationStatePath(project), {
    base, target, target_head: targetHead,
    patch_bytes: patchBytes,
    decision: gate.result.decision,
    exit_code: gate.exitCode,
    artifact_path: gate.artifactPath,
    evaluated_at: new Date().toISOString(),
  });

  return {
    project, base, target, target_head: targetHead,
    patch_path: patchPath,
    patch_bytes: patchBytes,
    empty: patchBytes === 0,
    size_warning: sizeWarning,
    gate: gate.result,
    exit_code: gate.exitCode,
    artifact_path: gate.artifactPath,
  };
}

/**
 * Release-gate visibility for gate_phase=release projects (plan §3B, v1):
 *   pending — no integration review has run yet
 *   pass / fail / error — last review's decision, still current
 *   stale   — the target branch moved since the last review (re-run required)
 * Never throws; unresolvable git state degrades to the recorded decision.
 */
export function releaseGateStatus({ project, cwd = process.cwd() } = {}) {
  const state = readJSON(integrationStatePath(project));
  if (!state) return { state: 'pending', reason: 'no integration review recorded — run x-build review-integration' };
  const currentHead = gitHeadOf(cwd, state.target);
  if (state.target_head && currentHead && state.target_head !== currentHead) {
    return {
      state: 'stale',
      reason: `${state.target} moved since the last review (${state.target_head.slice(0, 8)} → ${currentHead.slice(0, 8)}) — re-run x-build review-integration`,
      last: state,
    };
  }
  return { state: state.decision === 'pass' ? 'pass' : state.decision, reason: null, last: state };
}

// ── CLI: worktrees <plan|status|cleanup> ─────────────────────────────

export function cmdWorktrees(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'plan') return worktreesPlan(rest);
  if (sub === 'status') return worktreesStatus(rest);
  if (sub === 'resume') return worktreesResume(rest);
  if (sub === 'cleanup') return worktreesCleanup(rest);
  console.error('Usage: x-build worktrees <plan|status|resume|cleanup> [task-id...] [--json] [--project <name>]');
  exitFail(1);
}

function worktreesPlan(args) {
  const { opts } = parseOptions(args);
  const json = !!opts.json;
  const project = getExplicitProject() || resolveProject(null);
  const cwd = process.cwd();
  const config = applyLifecycleWorktreePolicy(loadWorktreeConfig(), project);

  // Run-level flag overrides on top of config.
  if (typeof opts.base === 'string') config.base = opts.base;
  if (typeof opts['branch-prefix'] === 'string') config.branch_prefix = opts['branch-prefix'];
  if (opts['max-parallel'] != null && opts['max-parallel'] !== true) config.max_parallel = Number(opts['max-parallel']);

  // Preflight (capability probe) unless suppressed. dry-run never depends on the
  // gk gate surface, but the probe drives the degraded-mode label.
  const preflight = opts['no-preflight'] ? null : runPreflight({ project, cwd });
  // Group review does not ask gk to run a per-task gate. A missing gk gate
  // capability therefore cannot degrade the worktree execution backend.
  const degraded = preflight ? (preflight.degraded && config.gate_phase !== 'release') : false;

  const taskData = readJSON(tasksPath(project));
  const ready = selectReadyTasks(taskData);
  const existingBranches = listExistingBranches(cwd);
  const worktreeBase = join(homedir(), '.gk', 'worktree', basename(cwd));
  const plan = planWorktrees({ project, tasks: ready, config, existingBranches, worktreeBase, degraded });
  plan.preflight = preflight;

  if (json) { console.log(JSON.stringify(plan, null, 2)); return; }

  console.log(`\n${C.bold}🌿 worktree plan — ${project}${C.reset} ${C.dim}(base: ${plan.base}, max-parallel: ${plan.max_parallel})${C.reset}`);
  if (plan.gate_deferred) {
    console.log(`${C.yellow}⚠ gate deferred to release: per-task merges run UNGATED; run \`x-build review-integration\` before releasing (worktree.gate_phase=release).${C.reset}`);
  }
  if (degraded) {
    console.log(`${C.yellow}⚠ degraded (manual-handoff): ${preflight?.gk_reason || 'gk gate unavailable'} — run the commands below by hand; xm will not drive gk.${C.reset}`);
  }
  if (!plan.tasks.length) {
    console.log(`  ${C.dim}no ready tasks to plan.${C.reset}\n`);
    return;
  }
  if (plan.parallel_batches.length) {
    console.log(`\n  ${C.bold}parallel batches${C.reset} (expected_files-safe):`);
    plan.parallel_batches.forEach((b, i) => console.log(`    batch ${i + 1}: ${b.join(', ')}`));
  }
  if (plan.sequential.length) {
    console.log(`\n  ${C.bold}sequential${C.reset} (unknown/overlapping files → one at a time): ${plan.sequential.join(', ')}`);
    if (plan.reason) console.log(`    ${C.dim}${plan.reason}${C.reset}`);
  }
  console.log(`\n  ${C.bold}per-task commands${C.reset}:`);
  for (const t of plan.tasks) {
    console.log(`\n    ${C.cyan}${t.task_id}${C.reset} → ${t.branch} ${C.dim}(${t.parallel_safe ? 'parallel' : 'sequential'})${C.reset}`);
    console.log(`      acquire: ${t.acquire}`);
    console.log(`      finish:  ${t.finish}`);
  }
  console.log(`\n  ${C.dim}dry-run only — no gk worktree was created.${C.reset}\n`);
}

function worktreesStatus(args) {
  const { opts } = parseOptions(args);
  const json = !!opts.json;
  const project = getExplicitProject() || resolveProject(null);
  const dir = worktreesDir(project);
  const tasks = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const rp = runJsonPath(project, entry);
      if (!existsSync(rp)) continue;
      const r = readJSON(rp);
      if (r) tasks.push({
        task_id: r.task_id, branch: r.branch, worktree: r.worktree,
        task_status: r.task_status, worktree_status: r.worktree_status,
        last_error: r.last_error,
      });
    }
  }
  // gate_phase=release → per-task merges were ungated; surface whether the
  // one-shot integration review is pending/stale/pass (plan §3B, v1 guard).
  const config = applyLifecycleWorktreePolicy(loadWorktreeConfig(), project);
  const releaseGate = config.gate_phase === 'release' ? releaseGateStatus({ project }) : null;

  if (json) { console.log(JSON.stringify({ project, worktree_tasks: tasks, release_gate: releaseGate }, null, 2)); return; }
  console.log(`\n${C.bold}🌿 worktree status — ${project}${C.reset}`);
  if (releaseGate) {
    const rgColor = releaseGate.state === 'pass' ? C.green : releaseGate.state === 'pending' || releaseGate.state === 'stale' ? C.yellow : C.red;
    console.log(`  release gate: ${rgColor}${releaseGate.state}${C.reset}${releaseGate.reason ? ` ${C.dim}— ${releaseGate.reason}${C.reset}` : ''}`);
  }
  if (!tasks.length) { console.log(`  ${C.dim}no worktree runs recorded.${C.reset}\n`); return; }
  for (const t of tasks) {
    console.log(`  ${C.cyan}${t.task_id}${C.reset} ${t.worktree_status} ${C.dim}(${t.task_status})${C.reset} ${t.branch || ''}`);
  }
  console.log('');
}

// worktrees resume [task-id...] — base drift resolution then re-gate for every
// resumable task (all statuses except BLOCKED/DONE/READY). With no ids, resumes
// every such task. This is the single finish-entry CLI for happy-path worktrees.
function worktreesResume(args) {
  const { opts, positional } = parseOptions(args);
  const json = !!opts.json;
  const project = getExplicitProject() || resolveProject(null);
  const projErr = validateIdSegment(project, 'project');
  if (projErr) { console.error(`worktrees resume: ${projErr}`); exitFail(2, `worktrees resume: ${projErr}`); }
  for (const id of positional) {
    const idErr = validateIdSegment(id, 'task id');
    if (idErr) { console.error(`worktrees resume: ${idErr}`); exitFail(2, `worktrees resume: ${idErr}`); }
  }
  const cwd = process.cwd();
  const config = applyLifecycleWorktreePolicy(loadWorktreeConfig(), project);
  if (typeof opts.base === 'string') config.base = opts.base;

  const taskIds = positional.length ? positional : null;
  const out = resumeWorktrees({ project, taskIds, config, cwd });

  if (json) { console.log(JSON.stringify(out, null, 2)); return; }

  console.log(`\n${C.bold}🌿 worktree resume — ${project}${C.reset}`);
  if (!out.results.length) { console.log(`  ${C.dim}no resumable worktree tasks (BLOCKED/DONE excluded).${C.reset}\n`); return; }
  for (const r of out.results) {
    if (r.action === 'finished') {
      const icon = r.worktree_status === WORKTREE_STATUS.DONE ? `${C.green}✓${C.reset}`
        : r.worktree_status === WORKTREE_STATUS.NEEDS_FIX ? `${C.yellow}↻${C.reset}`
        : `${C.red}✗${C.reset}`;
      console.log(`  ${icon} ${C.cyan}${r.task_id}${C.reset} ${r.worktree_status} ${C.dim}(${r.task_status}${r.retried ? ', retried' : ''})${C.reset}`);
    } else {
      console.log(`  ${C.dim}—${C.reset} ${C.cyan}${r.task_id}${C.reset} ${r.action}: ${r.reason}`);
      if (r.guidance) console.log(`      ${C.dim}${r.guidance}${C.reset}`);
      for (const rc of r.recover || []) console.log(`      ${C.dim}${rc.safety === 'destructive' ? '[destructive] ' : ''}${rc.command}${C.reset}`);
    }
  }
  console.log('');
}

// cleanup is deferred: merged-worktree GC is handled by gk `--cleanup` at finish
// time (finishWorktrees passes it per config). We do not silently no-op — point
// at the real gk command instead. Resume lives in `worktrees resume`.
function worktreesCleanup(args) {
  const { opts } = parseOptions(args);
  const msg = 'worktrees cleanup is handled at finish time via gk `--cleanup` (config.worktree.cleanup). To resume a stuck task use: x-build worktrees resume [task-id]. Manual gk: GK_AGENT=1 git-kit worktree finish --cleanup / --resume-accept.';
  if (opts.json) { console.log(JSON.stringify({ ok: false, stub: true, message: msg }, null, 2)); return; }
  console.log(msg);
}

// ── CLI: review-integration ──────────────────────────────────────────

export function cmdReviewIntegration(args) {
  const { opts } = parseOptions(args);
  const json = !!opts.json;
  const project = getExplicitProject() || resolveProject(null);
  const projErr = validateIdSegment(project, 'project');
  if (projErr) { console.error(`review-integration: ${projErr}`); exitFail(2, `review-integration: ${projErr}`); }
  const base = typeof opts.base === 'string' ? opts.base : 'main';
  const target = typeof opts.target === 'string' ? opts.target : 'develop';
  const config = loadWorktreeConfig();
  const maxPatchBytes = (opts['max-bytes'] != null && opts['max-bytes'] !== true)
    ? Number(opts['max-bytes'])
    : (config.review_integration_max_bytes ?? null);

  let out;
  try {
    out = reviewIntegration({ project, base, target, maxPatchBytes });
  } catch (e) {
    console.error(`❌ review-integration: ${e.message}`);
    exitFail(2);
    return;
  }

  if (out.size_warning) process.stderr.write(`⚠ ${out.size_warning}\n`);

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const icon = out.gate.decision === 'pass' ? `${C.green}✓ PASS${C.reset}`
      : out.gate.decision === 'fail' ? `${C.red}✗ BLOCK${C.reset}`
      : `${C.red}✗ ERROR${C.reset}`;
    console.log(`${icon} review-integration ${project} ${base}...${target} → exit ${out.exit_code} ${C.dim}(patch ${out.patch_bytes}B)${C.reset}`);
    console.log(`${C.dim}  artifact: ${out.artifact_path}${C.reset}`);
  }
  exitFail(out.exit_code);
}
