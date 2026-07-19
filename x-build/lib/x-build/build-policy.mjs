/**
 * Shared Execute policy for normal and worktree backends.
 *
 * Execution location is deliberately absent from this module. A task has one
 * review group and one set of local checks whether it runs in the main checkout
 * or in a linked worktree; only the backend/cwd differs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readJSON, writeJSON, loadConfig, loadSharedConfig, phaseDir, repoRoot,
} from './core.mjs';
import { runGatePanel } from './gate-panel.mjs';
import { getModelForRole } from './cost-engine.mjs';

export const DEFAULT_REVIEW_GROUP = 'build';
export const REVIEW_DEPTHS = ['checks-only', 'solo', 'panel'];
export const DEFAULT_BUILD_POLICY = {
  review_mode: 'manual',
  review_scope: 'group',
  // How heavy the group-boundary review is. 'solo' (default) hands the group
  // patch to ONE reviewer agent (leader-spawned, verdict recorded via
  // `review-group --verdict`); 'panel' keeps the cross-vendor adversarial
  // panel; 'checks-only' passes the group on group_checks alone. The panel
  // stays available per-invocation via `review-group --depth panel`.
  review_depth: 'solo',
  panel_rounds: 1,
  task_checks: ['test', 'lint'],
  group_checks: ['test', 'lint'],
};

export function loadBuildPolicy() {
  const shared = loadSharedConfig()?.build || {};
  const local = loadConfig()?.build || {};
  const merged = { ...DEFAULT_BUILD_POLICY, ...shared, ...local };
  if (!['manual', 'auto'].includes(merged.review_mode)) merged.review_mode = 'manual';
  if (!['group', 'task'].includes(merged.review_scope)) merged.review_scope = 'group';
  if (!REVIEW_DEPTHS.includes(merged.review_depth)) merged.review_depth = 'solo';
  if (![1, 2].includes(Number(merged.panel_rounds))) merged.panel_rounds = 1;
  else merged.panel_rounds = Number(merged.panel_rounds);
  if (!Array.isArray(merged.task_checks)) merged.task_checks = DEFAULT_BUILD_POLICY.task_checks;
  merged.task_checks = merged.task_checks.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  if (!Array.isArray(merged.group_checks)) merged.group_checks = DEFAULT_BUILD_POLICY.group_checks;
  merged.group_checks = merged.group_checks.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return merged;
}

export function resolveGroupChecks(cwd = repoRoot(), policy = loadBuildPolicy()) {
  return resolveTaskChecks(cwd, { ...policy, task_checks: policy.group_checks || [] });
}

/** Execute one group's full checks. Evidence is exact-snapshot and fail-closed. */
export function runGroupChecks(project, groupId, { cwd = repoRoot() } = {}) {
  const state = readReviewGroupState(project);
  const saved = state.groups[groupId] || {};
  const commands = resolveGroupChecks(cwd);
  const canonicalCwd = resolve(cwd);
  const fingerprintPolicy = { ...loadBuildPolicy(), task_checks: commands.map(({ name }) => name) };
  const fingerprint = taskCheckFingerprint(cwd, fingerprintPolicy);
  const descriptor = createHash('sha256').update(JSON.stringify(commands.map(({ name, command }) => ({ name, command })))).digest('hex');
  const existing = saved.group_quality;
  if (existing && existing.passed === true && existing.fingerprint === fingerprint && existing.command_hash === descriptor && existing.cwd === canonicalCwd) {
    return { ok: true, reused: true, evidence: existing };
  }
  const lock = join(phaseDir(project, '03-execute'), `.group-${groupId}.quality.lock`);
  try { mkdirSync(lock); } catch { return { ok: false, error: 'group_quality_in_progress', exitCode: 2 }; }
  try {
    const before = taskCheckFingerprint(cwd, fingerprintPolicy);
    const results = commands.map(({ name, command }) => {
      // The compatibility defaults (test/lint) are aliases: a project without
      // that optional script may skip it. Any other configured/missing command
      // is an explicit contract and fails closed.
      if (!command) return { name, command: null, passed: ['test', 'lint'].includes(name), skipped: true, ...( ['test', 'lint'].includes(name) ? {} : { error: 'configured_check_not_found' }) };
      const out = spawnSync(command, [], { cwd, shell: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      return { name, command, passed: !out.error && out.status === 0, skipped: false, exit_code: out.status, output: `${out.stdout || ''}${out.stderr || ''}`.trim().slice(-4000), ...(out.error ? { error: out.error.message } : {}) };
    });
    const after = taskCheckFingerprint(cwd, fingerprintPolicy);
    const evidence = { passed: before !== null && after === before && results.every((r) => r.passed), cwd: canonicalCwd, fingerprint: after, command_hash: descriptor, checked_at: new Date().toISOString(), results, ...(after !== before ? { error: 'workspace_changed_during_check' } : {}) };
    state.groups[groupId] = { ...saved, group_quality: evidence };
    writeJSON(statePath(project), state);
    return { ok: evidence.passed, reused: false, evidence, exitCode: evidence.passed ? 0 : 2 };
  } finally { try { rmdirSync(lock); } catch {} }
}

export function taskReviewGroup(task) {
  return typeof task?.review_group === 'string' && task.review_group.trim()
    ? task.review_group.trim()
    : DEFAULT_REVIEW_GROUP;
}

export function reviewGroupsForTasks(tasks = []) {
  const groups = [];
  const seen = new Set();
  for (const task of tasks) {
    const id = taskReviewGroup(task);
    if (!seen.has(id)) {
      seen.add(id);
      groups.push({ id, task_ids: [] });
    }
    groups.find((g) => g.id === id).task_ids.push(task.id);
  }
  return groups;
}

function packageManager(cwd) {
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** Resolve configured check names to commands that actually exist in cwd. */
export function resolveTaskChecks(cwd = repoRoot(), policy = loadBuildPolicy()) {
  const requested = policy.task_checks || [];
  const pkgPath = join(cwd, 'package.json');
  let scripts = {};
  if (existsSync(pkgPath)) {
    try { scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {}; } catch { scripts = {}; }
  }
  const pm = packageManager(cwd);
  const run = pm === 'npm' ? 'npm run' : `${pm} run`;
  const aliases = {
    test: scripts.test ? `${pm} test` : null,
    lint: scripts.lint ? `${run} lint` : null,
    typecheck: scripts.typecheck ? `${run} typecheck` : scripts['type-check'] ? `${run} type-check` : null,
    build: scripts.build ? `${run} build` : null,
  };
  if (!existsSync(pkgPath)) {
    if (existsSync(join(cwd, 'Cargo.toml'))) {
      aliases.test = 'cargo test'; aliases.lint = 'cargo clippy'; aliases.build = 'cargo build';
    } else if (existsSync(join(cwd, 'go.mod'))) {
      aliases.test = 'go test ./...'; aliases.lint = 'go vet ./...'; aliases.build = 'go build ./...';
    } else if (existsSync(join(cwd, 'pyproject.toml'))) {
      const uv = existsSync(join(cwd, 'uv.lock')) ? 'uv run ' : '';
      aliases.test = `${uv}pytest`; aliases.lint = `${uv}ruff check .`;
    }
  }
  return requested.map((name) => ({
    name,
    command: /\s/.test(name) ? name : aliases[name] || (scripts[name] ? `${run} ${name}` : null),
  }));
}

export function taskCheckContractHash(cwd = repoRoot(), policy = loadBuildPolicy()) {
  const contract = resolveTaskChecks(cwd, policy).map(({ name, command }) => ({ name, command }));
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

/** Bind check evidence to both configured commands and the current git worktree. */
export function taskCheckFingerprint(cwd = repoRoot(), policy = loadBuildPolicy()) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const others = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (head.status !== 0 || !head.stdout.trim() || diff.status !== 0 || others.status !== 0) return null;
  const hash = createHash('sha256');
  hash.update(taskCheckContractHash(cwd, policy));
  hash.update(head.stdout.trim());
  hash.update(diff.stdout || '');
  const files = (others.stdout || '').split('\0').filter(Boolean)
    .filter((file) => !file.startsWith('.xm/') && file !== 'TASK-CONTEXT.md')
    .sort();
  for (const file of files) {
    hash.update(`\0${file}\0`);
    // `git hash-object` streams the file instead of materializing an arbitrary
    // untracked file in the Node heap. The blob id still changes with content,
    // preserving the fingerprint contract for large files.
    const blob = spawnSync('git', ['hash-object', '--no-filters', '--', file], { cwd, encoding: 'utf8' });
    if (blob.status !== 0 || !blob.stdout.trim()) return null;
    hash.update(blob.stdout.trim());
  }
  return hash.digest('hex');
}

function statePath(project) {
  return join(phaseDir(project, '03-execute'), 'review-groups.json');
}

function gitHead(cwd = repoRoot(), ref = 'HEAD') {
  const out = spawnSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

function patchHash(patch) {
  return createHash('sha256').update(patch).digest('hex');
}

function gitPatch(base, head, cwd = repoRoot(), { includeWorking = false } = {}) {
  if (!base || !head) return { ok: false, patch: '', error: 'missing_git_baseline_or_target' };
  if (includeWorking) {
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
    if (untracked.status !== 0) return { ok: false, patch: '', error: 'git_untracked_scan_failed' };
    const files = (untracked.stdout || '').split('\0').filter(Boolean)
      .filter((file) => !file.startsWith('.xm/') && file !== 'TASK-CONTEXT.md');
    if (files.length) {
      return { ok: false, patch: '', error: `untracked_files_present:${files.slice(0, 5).join(',')}` };
    }
  } else if (base === head) {
    return { ok: true, patch: '', hash: patchHash(''), error: null };
  }
  // Normal execution reviews base→working-tree, including committed, staged,
  // and unstaged tracked edits. Worktree execution reviews the merged base ref.
  // Exact endpoints are intentional. A three-dot range would silently switch
  // to merge-base after a rebase/reset and could omit code dropped since the
  // recorded baseline.
  const range = includeWorking ? base : `${base}..${head}`;
  const out = spawnSync('git', ['diff', '--binary', range], { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  return out.status === 0
    ? { ok: true, patch: out.stdout, hash: patchHash(out.stdout), error: null }
    : { ok: false, patch: '', error: (out.stderr || '').trim() || `git diff exited ${out.status}` };
}

function currentGroupTarget(group, cwd) {
  const head = gitHead(cwd, group.ref || 'HEAD');
  const diff = gitPatch(group.baseline_sha, head, cwd, { includeWorking: (group.ref || 'HEAD') === 'HEAD' });
  return { head, diff };
}

export function readReviewGroupState(project) {
  return readJSON(statePath(project)) || { version: 1, groups: {} };
}

export function reviewGroupStatus(project, tasks = [], { cwd = repoRoot() } = {}) {
  const policy = loadBuildPolicy();
  const definitions = reviewGroupsForTasks(tasks);
  const state = readReviewGroupState(project);
  const groups = definitions.map((definition) => {
    const rows = definition.task_ids.map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
    const completed = rows.length > 0 && rows.every((t) => ['completed', 'cancelled'].includes(t.status));
    const saved = state.groups[definition.id] || {};
    const membershipSame = Array.isArray(saved.task_ids)
      && saved.task_ids.length === definition.task_ids.length
      && saved.task_ids.every((id, index) => id === definition.task_ids[index]);
    let status = saved.status || 'pending';
    if (saved.status === 'passed' && completed && membershipSame) status = 'passed';
    else if (completed) status = 'review_required';
    else if (rows.some((t) => ['running', 'completed'].includes(t.status))) status = 'running';
    else status = 'pending';
    return { ...definition, ...saved, status, completed };
  });
  // Between groups, approval is content-bound just like Plan approval. If code
  // changes after a pass but before the next group starts, reopen the last group
  // instead of silently attributing those edits to an unreviewed future group.
  const firstOpen = groups.findIndex((g) => g.status !== 'passed');
  if (policy.review_scope === 'group' && firstOpen > 0 && groups[firstOpen].status === 'pending') {
    const previous = groups[firstOpen - 1];
    const target = currentGroupTarget(previous, cwd);
    if (!target.head || !target.diff.ok || previous.target_sha !== target.head || previous.target_patch_hash !== target.diff.hash) {
      previous.status = 'review_required';
      previous.stale_reason = 'head_changed_after_review';
    }
  }
  if (policy.review_scope === 'group' && firstOpen === -1 && groups.length) {
    const finalGroup = groups.at(-1);
    const target = currentGroupTarget(finalGroup, cwd);
    if (!target.head || !target.diff.ok || finalGroup.target_sha !== target.head || finalGroup.target_patch_hash !== target.diff.hash) {
      finalGroup.status = 'review_required';
      finalGroup.stale_reason = !target.head || !target.diff.ok ? 'git_target_unavailable' : 'head_changed_after_review';
    }
  }
  const active = groups.find((g) => g.status !== 'passed') || null;
  const head = gitHead(cwd, active?.ref || groups.at(-1)?.ref || 'HEAD');
  return {
    review_mode: policy.review_mode,
    review_scope: policy.review_scope,
    groups,
    active_group: active?.id || null,
    review_required: policy.review_mode === 'auto' && policy.review_scope === 'group' && active?.status === 'review_required',
    review_available: policy.review_mode === 'manual' && policy.review_scope === 'group' && active?.status === 'review_required',
    review_command: active?.status === 'review_required' ? `review-group ${active.id}` : null,
    all_tasks_completed: tasks.length > 0 && tasks.every((t) => ['completed', 'cancelled'].includes(t.status)),
    // Optional panel review never weakens the required full group checks.
    // Manual mode may skip the panel, but Execute can advance only after every
    // completed group has a passing, exact-snapshot group_quality evidence.
    all_passed: policy.review_scope !== 'group'
      ? tasks.length > 0 && tasks.every((t) => ['completed', 'cancelled'].includes(t.status))
      : groups.length > 0 && groups.every((g) => g.group_quality?.passed === true),
    head,
  };
}

/** Record the immutable baseline immediately before a group's first dispatch. */
export function startReviewGroup(project, groupId, { cwd = repoRoot(), ref = 'HEAD' } = {}) {
  const state = readReviewGroupState(project);
  const previous = state.groups[groupId] || {};
  if (!previous.baseline_sha) {
    const baseline = gitHead(cwd, ref);
    if (!baseline) return { error: 'git_baseline_unavailable', ref };
    state.groups[groupId] = {
      ...previous,
      status: 'running',
      baseline_sha: baseline,
      ref,
      started_at: new Date().toISOString(),
    };
    writeJSON(statePath(project), state);
  }
  return state.groups[groupId];
}

/**
 * Run the group-boundary review at the effective depth after every task in a
 * group has completed. depth (explicit flag) > policy.review_depth:
 *   'panel'      — cross-vendor gate panel (the historical behavior)
 *   'solo'       — 2-step: persist a pending review spec (patch + reviewer
 *                  model) for the leader to run as ONE agent, verdict recorded
 *                  later via recordSoloReviewVerdict (fail-closed on git drift)
 *   'checks-only'— group_checks alone decide; no LLM review
 */
export function reviewBuildGroup(project, tasks, groupId = null, { cwd = repoRoot(), rounds = null, depth = null } = {}) {
  const policy = loadBuildPolicy();
  if (depth != null && !REVIEW_DEPTHS.includes(depth)) {
    return { ok: false, error: `invalid_review_depth: ${depth}`, exitCode: 2 };
  }
  const summary = reviewGroupStatus(project, tasks, { cwd });
  const group = groupId ? summary.groups.find((g) => g.id === groupId) : summary.groups.find((g) => g.status === 'review_required');
  if (!group) return { ok: false, error: 'review_group_not_found_or_not_ready', summary };
  if (!group.completed) return { ok: false, error: 'review_group_incomplete', group };

  const state = readReviewGroupState(project);
  const saved = state.groups[group.id] || {};
  const head = gitHead(cwd, saved.ref || 'HEAD');
  const includeWorking = (saved.ref || 'HEAD') === 'HEAD';
  const diff = gitPatch(saved.baseline_sha, head, cwd, { includeWorking });
  if (!diff.ok) return { ok: false, error: diff.error, group, exitCode: 2 };
  const patch = diff.patch;
  const effDepth = depth || policy.review_depth;

  if (patch.trim() && effDepth === 'checks-only') {
    const checks = runGroupChecks(project, group.id, { cwd });
    const st = readReviewGroupState(project); // runGroupChecks wrote group_quality
    st.groups[group.id] = {
      ...(st.groups[group.id] || {}),
      task_ids: group.task_ids,
      status: checks.ok ? 'passed' : 'failed',
      target_sha: head,
      target_patch_hash: diff.hash,
      reviewed_at: new Date().toISOString(),
      decision: checks.ok ? 'checks-only-pass' : 'checks-only-fail',
      depth: 'checks-only',
    };
    writeJSON(statePath(project), st);
    return { ok: checks.ok, depth: 'checks-only', group: st.groups[group.id], checks: checks.evidence ?? null, exitCode: checks.ok ? 0 : (checks.exitCode || 2) };
  }

  if (patch.trim() && effDepth === 'solo') {
    const safeId = `__group__-${group.id.replace(/[^A-Za-z0-9._-]/g, '-')}`;
    const patchPath = join(phaseDir(project, '03-execute'), `review-${safeId}.patch`);
    writeFileSync(patchPath, patch, 'utf8');
    const reviewerModel = getModelForRole('reviewer', 'medium', loadSharedConfig());
    state.groups[group.id] = {
      ...saved,
      task_ids: group.task_ids,
      status: 'solo_pending',
      depth: 'solo',
      solo: {
        patch: patchPath,
        model: reviewerModel,
        target_sha: head,
        patch_hash: diff.hash,
        requested_at: new Date().toISOString(),
      },
    };
    writeJSON(statePath(project), state);
    return {
      ok: true,
      pending: 'solo',
      depth: 'solo',
      solo: {
        group: group.id,
        task_ids: group.task_ids,
        patch: patchPath,
        model: reviewerModel,
        verdict_command: `x-build review-group ${group.id} --verdict pass|fail [--notes "..."]`,
      },
      exitCode: 0,
    };
  }

  let panel;
  if (!patch.trim()) {
    panel = { result: { ok: true, decision: 'pass', empty_patch: true }, exitCode: 0, artifactPath: null };
  } else {
    const safeId = `__group__-${group.id.replace(/[^A-Za-z0-9._-]/g, '-')}`;
    const patchPath = join(phaseDir(project, '03-execute'), `review-${safeId}.patch`);
    writeFileSync(patchPath, patch, 'utf8');
    panel = runGatePanel({
      project, taskId: safeId, phase: 'before', patch: patchPath, cwd,
      rounds: rounds == null ? policy.panel_rounds : rounds,
    });
  }
  const headAfterReview = gitHead(cwd, saved.ref || 'HEAD');
  const diffAfterReview = gitPatch(saved.baseline_sha, headAfterReview, cwd, { includeWorking });
  if (!headAfterReview || headAfterReview !== head || !diffAfterReview.ok || diffAfterReview.hash !== diff.hash) {
    panel = { result: { ok: false, decision: 'error', error: 'git_target_changed_during_review' }, exitCode: 2, artifactPath: panel.artifactPath };
  }
  state.groups[group.id] = {
    ...saved,
    task_ids: group.task_ids,
    status: panel.exitCode === 0 ? 'passed' : panel.result?.decision === 'fail' ? 'failed' : 'error',
    depth: 'panel',
    target_sha: head,
    target_patch_hash: diff.hash,
    reviewed_at: new Date().toISOString(),
    decision: panel.result?.decision || 'error',
    artifact: panel.artifactPath,
  };
  writeJSON(statePath(project), state);
  return { ok: panel.exitCode === 0, group: state.groups[group.id], panel: panel.result, exitCode: panel.exitCode };
}

/**
 * Record the leader-run solo review's verdict. Fail-closed like the panel
 * path: the git target must be byte-identical to what the pending spec was
 * issued against, otherwise the review is void (the reviewer looked at a
 * different diff than what would advance).
 */
export function recordSoloReviewVerdict(project, groupId, verdict, { cwd = repoRoot(), notes = null } = {}) {
  if (!['pass', 'fail'].includes(verdict)) return { ok: false, error: 'invalid_verdict', exitCode: 2 };
  const state = readReviewGroupState(project);
  const saved = state.groups[groupId];
  if (!saved || saved.status !== 'solo_pending' || !saved.solo) {
    return { ok: false, error: 'no_pending_solo_review', exitCode: 2 };
  }
  const head = gitHead(cwd, saved.ref || 'HEAD');
  const includeWorking = (saved.ref || 'HEAD') === 'HEAD';
  const diff = gitPatch(saved.baseline_sha, head, cwd, { includeWorking });
  if (!head || !diff.ok || head !== saved.solo.target_sha || diff.hash !== saved.solo.patch_hash) {
    state.groups[groupId] = { ...saved, status: 'error', decision: 'error', error: 'git_target_changed_during_review' };
    writeJSON(statePath(project), state);
    return { ok: false, error: 'git_target_changed_during_review', exitCode: 2 };
  }
  state.groups[groupId] = {
    ...saved,
    status: verdict === 'pass' ? 'passed' : 'failed',
    target_sha: head,
    target_patch_hash: diff.hash,
    reviewed_at: new Date().toISOString(),
    decision: verdict === 'pass' ? 'solo-pass' : 'solo-fail',
    reviewer_model: saved.solo.model,
    ...(notes ? { notes: String(notes).slice(0, 2000) } : {}),
  };
  writeJSON(statePath(project), state);
  return { ok: verdict === 'pass', group: state.groups[groupId], exitCode: verdict === 'pass' ? 0 : 2 };
}
