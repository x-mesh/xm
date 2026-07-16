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
  spawnSync, resolve, join, dirname, basename, readdirSync,
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

// LOCKSTEP: this evaluation core (DEFAULT_POLICY / blocksFor / evaluateVerdict /
// resolvePolicyForPhase) mirrors x-panel/lib/x-panel/gate.mjs — keep both in sync.
//
// Default calibration (docs/worktree-gate-optimization-plan.md §3A): the per-task
// gate blocks critical/high only — a confirmed medium costs a full expensive panel
// round-trip while being release-fixable. The `release` phase overlay re-adds
// medium so it is DEFERRED to the pre-release integration review, never dropped:
// non-blocking confirmed findings surface as `advisory_findings`.
const DEFAULT_POLICY = {
  block_confirmed: ['critical', 'high'],
  block_unreviewed: ['critical', 'high'],
  block_contested: ['critical'],
  allow_low: true,
  release: { block_confirmed: ['critical', 'high', 'medium'] },
};

const POLICY_BUCKETS = ['block_confirmed', 'block_unreviewed', 'block_contested'];
const KNOWN_SEVERITIES = ['critical', 'high', 'medium', 'low'];

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
 * Per-key shallow override — a present key fully replaces the lower layer. Phase
 * overlay keys (before/after/release) ride along as single keys: a layer's overlay
 * replaces the lower layer's overlay wholesale (predictable, matches every other
 * per-key semantic here). When `phase` is given the matching overlay is applied on
 * top of the flat base and the result is returned FLAT (overlay keys stripped).
 */
export function mergePolicy({ config, task, phase = null } = {}) {
  const configPolicy = config?.worktree?.gate_policy || {};
  const taskPolicy = task?.gate_policy || {};
  const merged = { ...DEFAULT_POLICY, ...configPolicy, ...taskPolicy };
  if (phase === null) return merged;
  return resolvePolicyForPhase(merged, phase);
}

/**
 * Resolve the flat effective policy for a gate phase (mirrors x-panel/gate.mjs).
 * Overlay keys are stripped so downstream consumers always see a flat policy.
 */
export function resolvePolicyForPhase(policy, phase = null) {
  const flat = {
    block_confirmed: policy.block_confirmed,
    block_unreviewed: policy.block_unreviewed,
    block_contested: policy.block_contested,
    allow_low: policy.allow_low,
  };
  const overlay = phase != null && policy[phase] && typeof policy[phase] === 'object' && !Array.isArray(policy[phase])
    ? policy[phase] : {};
  return { ...flat, ...overlay };
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
 * Evaluate a panel verdict record against a FLAT policy (resolve phase overlays
 * first). `advisory` carries confirmed non-low findings the policy chose NOT to
 * block (e.g. medium under the relaxed per-task default) — a relaxed gate never
 * silently drops findings; they surface in the artifact and queue for the
 * release-phase review / later queue.
 * @returns {{ decision: 'pass'|'fail', blocking: object[], advisory: object[] }}
 */
export function evaluateVerdict(verdict, policy) {
  const allowLow = policy.allow_low !== false;
  const blocking = [];
  for (const b of blocksFor(verdict.confirmed, policy.block_confirmed, allowLow)) blocking.push({ ...b, kind: 'confirmed' });
  for (const b of blocksFor(verdict.unreviewed, policy.block_unreviewed, allowLow)) blocking.push({ ...b, kind: 'unreviewed' });
  for (const b of blocksFor(verdict.contested, policy.block_contested, allowLow)) blocking.push({ ...b, kind: 'contested' });

  const confirmedBlockSet = new Set((Array.isArray(policy.block_confirmed) ? policy.block_confirmed : []).map(s => String(s).toLowerCase()));
  const advisory = [];
  for (const f of verdict.confirmed || []) {
    const sev = String(f.severity || '').toLowerCase();
    if (sev === 'low' || !KNOWN_SEVERITIES.includes(sev)) continue; // low stays governed by allow_low; unknown severities never advise
    if (confirmedBlockSet.has(sev)) continue;                       // already blocking
    advisory.push({ severity: f.severity, file: f.file ?? null, line: f.line ?? null, claim: f.claim ?? null, kind: 'confirmed' });
  }

  return { decision: blocking.length ? 'fail' : 'pass', blocking, advisory };
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

// ── pre-gate (plan §3F) ──────────────────────────────────────────────
//
// A cheap convergence check that runs BEFORE the expensive cross-vendor panel.
// Contract: exit 0 → proceed to panel; exit 1 → fail-fast, the panel never runs
// (stdout may carry {findings:[{severity,file,line,claim}]} JSON, adopted as
// blocking with kind 'pre_gate'); exit ≥2 / spawn failure / timeout → warn LOUD
// and PROCEED — the pre-gate is an optimization, not a correctness gate, so its
// infra failure must never block a valid merge (but is never silenced either, L6).

/**
 * Whitespace-tokenize a pre-gate command template (no shell — same rule as gk's
 * --gate). `{patch}` tokens are substituted with the patch path; a template
 * without `{patch}` gets the patch path appended as the last argument.
 */
export function preGateArgv(template, patch) {
  const tokens = String(template).split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const hasPatch = tokens.includes('{patch}');
  const argv = tokens.map(t => (t === '{patch}' ? patch : t));
  if (!hasPatch) argv.push(patch);
  return argv;
}

function runPreGate({ template, patch, cwd, panelRoot, buildRoot }) {
  const argv = preGateArgv(template, patch);
  if (!argv) return { block: false, record: null };
  const started = Date.now();
  const timeoutMs = Number(process.env.X_BUILD_PRE_GATE_TIMEOUT_MS) || 300000;
  const env = { ...process.env, X_PANEL_ROOT: panelRoot, XM_ROOT: panelRoot, X_BUILD_ROOT: buildRoot };
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  const record = {
    cmd: template,
    exit_code: res.status ?? null,
    status: 'pass',
    duration_ms: Date.now() - started,
  };

  if (res.error || res.signal || (res.status !== 0 && res.status !== 1)) {
    // Infra failure — loud warn, record, PROCEED to the panel.
    const why = res.error ? `spawn failed: ${res.error.message}`
      : res.signal ? `killed by signal ${res.signal} (likely timeout)`
      : `exited ${res.status}`;
    record.status = 'error';
    record.error = why;
    record.output_tail = ((res.stderr || '') + (res.stdout || '')).trim().slice(-500) || null;
    process.stderr.write(`${C.red}✗ gate-panel: pre-gate ${why} — proceeding to the panel (pre-gate is advisory infra)${C.reset}\n`);
    return { block: false, record };
  }

  if (res.status === 0) return { block: false, record };

  // exit 1 → fail-fast. Adopt structured findings when stdout is a
  // {findings:[...]} JSON; otherwise keep the raw tail for the human.
  record.status = 'fail';
  let findings = [];
  try {
    const parsed = JSON.parse((res.stdout || '').toString());
    if (parsed && Array.isArray(parsed.findings)) {
      findings = parsed.findings.map(f => ({
        severity: f.severity ?? null, file: f.file ?? null, line: f.line ?? null,
        claim: f.claim ?? null, kind: 'pre_gate',
      }));
    }
  } catch { /* non-JSON output — tail below is the evidence */ }
  if (!findings.length) record.output_tail = ((res.stdout || '') + (res.stderr || '')).trim().slice(-800) || null;
  return { block: true, record, findings };
}

// ── round tracking + artifact history (plan §3E) ─────────────────────

// Preserve the artifact that is about to be overwritten as
// panel-<phase>.attempt-<k>.json (k = max existing + 1). Every prior gate
// decision stays auditable across rounds — pass, fail, and pre-gate alike.
function preserveArtifact(artifactPath) {
  if (!existsSync(artifactPath)) return;
  try {
    const dir = dirname(artifactPath);
    const stem = basename(artifactPath, '.json'); // panel-<phase>
    const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.attempt-(\\d+)\\.json$`);
    let max = 0;
    for (const f of readdirSync(dir)) {
      const m = f.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    renameSync(artifactPath, join(dir, `${stem}.attempt-${max + 1}.json`));
  } catch (e) {
    // Loud but non-blocking (L6): losing history must not fail the gate run.
    process.stderr.write(`${C.red}✗ gate-panel: failed to preserve prior artifact ${artifactPath}: ${e.message}${C.reset}\n`);
  }
}

// Round = consecutive PANEL-fail merge attempts for this task+phase. Only a fail
// produced by an actual panel run (panel_run non-null) increments — a pre-gate
// fail-fast keeps the count (cheap failures must not trigger the medium demotion
// early), and a prior pass (base-drift re-gate) resets to 1.
export function nextRound(prev) {
  if (!prev || prev.decision !== 'fail') return 1;
  const prevRound = Number(prev.round) || 1;
  return prev.panel_run ? prevRound + 1 : prevRound;
}

// Round cap (plan §3E): past `gate_max_rounds` consecutive panel-fail rounds,
// 'medium' demotes from every block list to advisory — the gate stops looping on
// medium-only findings. critical/high NEVER demote, at any round. Default 2 comes
// from one measured dogfooding case (term-mesh: rounds were medium-only from
// round 3) — configurable, revisit when more data lands.
export function applyRoundCap(policy, round, maxRounds) {
  const max = Number(maxRounds);
  if (!Number.isFinite(max) || max <= 0 || round <= max) return { policy, demotions: [] };
  const demotions = [];
  const next = { ...policy };
  for (const bucket of POLICY_BUCKETS) {
    const list = Array.isArray(next[bucket]) ? next[bucket] : [];
    if (list.some(s => String(s).toLowerCase() === 'medium')) {
      next[bucket] = list.filter(s => String(s).toLowerCase() !== 'medium');
      demotions.push({ severity: 'medium', bucket, reason: 'round_cap', round, max_rounds: max });
    }
  }
  return { policy: next, demotions };
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
  // task metadata, then resolve the phase overlay to a FLAT effective policy.
  // loadWorktreeConfig applies the full resolution priority so a gate_policy in
  // EITHER .xm/config.json or .xm/build/config.json is honored.
  const wtConfig = loadWorktreeConfig({ buildRootDir: buildRoot });
  const tasksJson = readJSON(join(buildRoot, 'projects', project, 'phases', '02-plan', 'tasks.json'));
  const task = tasksJson?.tasks?.find(t => t.id === taskId) || null;
  let policy = mergePolicy({ config: { worktree: wtConfig }, task, phase });
  const policyOverridden = !!(task?.gate_policy) || worktreeGatePolicyConfigured(buildRoot);

  // Round tracking (§3E): consecutive panel-fail attempts for this task+phase.
  // The previous artifact is preserved as panel-<phase>.attempt-<k>.json so the
  // decision history stays auditable.
  const prev = readJSON(artifactPath);
  const round = nextRound(prev);
  preserveArtifact(artifactPath);

  // Round cap: past gate_max_rounds panel-fail rounds, medium demotes to advisory.
  const capped = applyRoundCap(policy, round, wtConfig.gate_max_rounds);
  policy = capped.policy;
  const demotions = capped.demotions;
  if (demotions.length) {
    process.stderr.write(`${C.yellow}⚠ gate-panel: round ${round} exceeds gate_max_rounds=${wtConfig.gate_max_rounds} — medium demoted to advisory for this run (critical/high still block)${C.reset}\n`);
  }

  const common = {
    task_id: taskId,
    phase,
    source: 'build:worktree',
    policy,
    policy_overridden: policyOverridden,
    round,
    demotions,
  };

  // Pre-gate (§3F): cheap convergence check — a fail here blocks WITHOUT
  // spending the expensive panel; an infra error warns loudly and proceeds.
  let preGateRecord = null;
  if (typeof wtConfig.pre_gate === 'string' && wtConfig.pre_gate.trim()) {
    const pg = runPreGate({ template: wtConfig.pre_gate, patch, cwd, panelRoot, buildRoot });
    preGateRecord = pg.record;
    if (pg.block) {
      const result = {
        ok: false,
        decision: 'fail',
        exit_code: 1,
        ...common,
        panel_run: null,
        pre_gate: preGateRecord,
        blocking_findings: pg.findings || [],
        advisory_findings: [],
        attempts: 0,
      };
      writeArtifact(artifactPath, result);
      return { result, exitCode: 1, artifactPath };
    }
  }

  const panel = runPanel({ patch, taskId, phase, cwd, panelRoot, buildRoot });

  if (!panel.ok) {
    const result = {
      ok: false,
      decision: 'error',
      exit_code: 2,
      ...common,
      panel_run: null,
      pre_gate: preGateRecord,
      blocking_findings: [],
      advisory_findings: [],
      attempts: panel.attempts,
      error: panel.error,
    };
    writeArtifact(artifactPath, result);
    return { result, exitCode: 2, artifactPath };
  }

  const verdict = panel.verdict;
  const { decision, blocking, advisory } = evaluateVerdict(verdict, policy);
  const exitCode = decision === 'fail' ? 1 : 0;
  const result = {
    ok: exitCode === 0,
    decision,
    exit_code: exitCode,
    ...common,
    panel_run: verdict.run || null,
    pre_gate: preGateRecord,
    blocking_findings: blocking,
    advisory_findings: advisory,
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
    const roundNote = result.round > 1 ? ` ${C.dim}(round ${result.round})${C.reset}` : '';
    console.log(`${icon} gate-panel ${project}/${taskId} [${phase}]${roundNote} → exit ${exitCode}`);
    if (result.decision === 'fail') {
      if (result.pre_gate?.status === 'fail') {
        console.log(`  ${C.yellow}pre-gate blocked (exit 1) — the panel did not run${C.reset}`);
        if (result.pre_gate.output_tail) console.log(`  ${C.dim}${result.pre_gate.output_tail}${C.reset}`);
      }
      for (const b of result.blocking_findings) {
        console.log(`  ${C.yellow}${b.severity}${C.reset} (${b.kind}) ${b.file ?? '?'}:${b.line ?? '?'} — ${b.claim ?? ''}`);
      }
    } else if (result.decision === 'error') {
      console.log(`  ${C.red}${result.error}${C.reset}`);
    }
    for (const d of result.demotions || []) {
      console.log(`  ${C.yellow}⚠ ${d.severity} demoted from ${d.bucket} (round cap ${d.max_rounds})${C.reset}`);
    }
    for (const a of result.advisory_findings || []) {
      console.log(`  ${C.dim}◦ advisory [${a.severity}] ${a.file ?? '?'}:${a.line ?? '?'} — ${a.claim ?? ''}${C.reset}`);
    }
    if ((result.advisory_findings || []).length) {
      console.log(`  ${C.dim}capture advisory items: xm build later add "<claim>" --reason gate-advisory --source gate-panel:${taskId}${C.reset}`);
    }
    console.log(`${C.dim}  artifact: ${artifactPath}${C.reset}`);
  }

  exitFail(exitCode);
}
