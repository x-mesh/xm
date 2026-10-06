import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, toSlug, writeJSON } from './core.mjs';
import { buildRoot, compileParallelBatches, normalizeExpectedFiles, validateIdSegment } from './worktree-shared.mjs';
import { runGatePanel } from './gate-panel.mjs';
import { artifactEntries, planArtifactsDir } from './plan-bridge.mjs';
import { normalizePlanEnvelope } from '../x-plan/normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function batchesRoot() { return join(dirname(buildRoot()), 'batches'); }
function manifestPath(id) { return join(batchesRoot(), id, 'manifest.json'); }
function now() { return new Date().toISOString(); }
function topicRoot(batchId, topicId) { return join(batchesRoot(), batchId, 'topics', topicId); }
function planSnapshotPath(batchId, topicId) { return join(topicRoot(batchId, topicId), 'plan.json'); }

function option(args, name) {
  const inline = args.find((arg) => arg.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length && !args[index + 1].startsWith('-') ? args[index + 1] : null;
}

function positionalArgs(args, valueOptions = []) {
  const values = new Set(valueOptions);
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (values.has(arg)) { index += 1; continue; }
    if (valueOptions.some((name) => arg.startsWith(name + '=')) || arg.startsWith('-')) continue;
    positional.push(arg);
  }
  return positional;
}

function jsonRequested(args) { return args.includes('--json'); }
function sha256(raw) { return createHash('sha256').update(raw).digest('hex'); }

function fail(action, errors, { json = false, code = 2 } = {}) {
  const output = { action, status: code === 1 ? 'error' : 'blocked', errors: Array.isArray(errors) ? errors : [errors] };
  if (json) console.log(JSON.stringify(output, null, 2));
  else for (const error of output.errors) console.error('❌ ' + error);
  process.exitCode = code;
  return null;
}

function loadBatch(id, action, json) {
  const path = manifestPath(id);
  if (!existsSync(path)) return fail(action, `batch not found: ${id}`, { json, code: 1 });
  const manifest = readJSON(path);
  if (!manifest) return fail(action, `batch manifest is unreadable: ${id}`, { json, code: 1 });
  return manifest;
}

function acquireOperationLock(id, action, json) {
  const path = join(batchesRoot(), id, 'operation.lock');
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, started_at: now() }), { flag: 'wx' });
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') return fail(action, `cannot create operation lock: ${error.message}`, { json, code: 1 });
      let owner = null;
      try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      let alive = true;
      if (Number.isInteger(owner?.pid)) {
        try { process.kill(owner.pid, 0); } catch (probe) { alive = probe.code !== 'ESRCH'; }
      }
      if (alive || attempt > 0) return fail(action, `batch operation is already running${owner?.pid ? ` (pid ${owner.pid})` : ''}`, { json });
      try { unlinkSync(path); } catch (removeError) { return fail(action, `cannot remove stale operation lock: ${removeError.message}`, { json, code: 1 }); }
    }
  }
  return null;
}

function releaseOperationLock(path) {
  if (!path) return;
  try { unlinkSync(path); } catch {}
}

async function loadPlanCore() {
  const candidates = [join(HERE, '..', 'x-plan', 'core.mjs'), join(HERE, '..', '..', '..', 'x-plan', 'lib', 'x-plan', 'core.mjs')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try { return await import(path); } catch {}
  }
  return null;
}

export function collectTopicExpectedFiles(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const complete = tasks.length > 0 && tasks.every((task) => normalizeExpectedFiles(task.expected_files).length > 0);
  const files = complete ? [...new Set(tasks.flatMap((task) => normalizeExpectedFiles(task.expected_files)))].sort() : [];
  return { expected_files: files, expected_files_complete: complete };
}

function verifyPlanSources(manifest) {
  const plans = new Map();
  const errors = [];
  for (const topic of manifest.topics) {
    let raw;
    try { raw = readFileSync(topic.plan.source, 'utf8'); } catch (error) { errors.push(`${topic.id}: cannot read plan: ${error.message}`); continue; }
    const digest = sha256(raw);
    if (digest !== topic.plan.sha256) { errors.push(`${topic.id}: plan source changed after registration`); continue; }
    plans.set(topic.id, { raw, sha256: digest });
  }
  return { plans, errors };
}

function graphFrontiers(topics) {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const unknown = [];
  for (const topic of topics) {
    for (const dependency of topic.depends_on || []) if (!byId.has(dependency)) unknown.push(`${topic.id}: unknown dependency ${dependency}`);
  }
  if (unknown.length) return { errors: unknown };

  const remaining = new Set(byId.keys());
  const completed = new Set();
  const frontiers = [];
  while (remaining.size) {
    const ready = topics.filter((topic) => remaining.has(topic.id) && (topic.depends_on || []).every((id) => completed.has(id)));
    if (!ready.length) return { errors: [`dependency cycle: ${[...remaining].join(', ')}`] };
    frontiers.push(ready);
    for (const topic of ready) { remaining.delete(topic.id); completed.add(topic.id); }
  }
  return { frontiers };
}

export function compileBatchSchedule(topics, { maxParallel = 4 } = {}) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) return { errors: ['max_parallel must be a positive integer'] };
  const graph = graphFrontiers(topics);
  if (graph.errors) return graph;

  const waves = [];
  const sequentialTopics = [];
  const conflictEdges = [];
  for (const frontier of graph.frontiers) {
    const batch = compileParallelBatches(frontier, maxParallel);
    conflictEdges.push(...batch.conflict_edges);
    for (const ids of batch.parallel_batches) {
      waves.push({ index: waves.length + 1, mode: ids.length > 1 ? 'parallel' : 'sequential', topics: ids });
    }
    for (const id of batch.sequential) {
      sequentialTopics.push(id);
      waves.push({ index: waves.length + 1, mode: 'sequential', topics: [id] });
    }
  }
  return { max_parallel: maxParallel, waves, sequential_topics: sequentialTopics, conflict_edges: conflictEdges };
}

function parseDependencies(args) {
  const value = option(args, '--depends-on');
  return value ? [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))] : [];
}

function emit(value, json, message) {
  console.log(json ? JSON.stringify(value, null, 2) : message);
  return value;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.tmp';
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

function parseArgvEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === 'string')) throw new Error(`${name} must be a non-empty JSON string array`);
  return value;
}

function parseAgentEnvelope(result) {
  for (const raw of [result.stdout, result.stderr]) {
    const value = String(raw || '').trim();
    if (!value) continue;
    try { return JSON.parse(value); } catch {}
    const first = value.indexOf('{');
    const last = value.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(value.slice(first, last + 1)); } catch {}
    }
  }
  return null;
}

function resolveBase(ref, cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd, encoding: 'utf8' });
  const sha = String(result.stdout || '').trim();
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(sha)) {
    return { error: `cannot resolve base ${ref}: ${String(result.stderr || result.error?.message || '').trim() || 'unknown revision'}` };
  }
  return { ref, sha };
}

function acquireBatchWorktree(branch, baseSha, cwd = process.cwd(), { noInit = false } = {}) {
  let command;
  try { command = parseArgvEnv('X_BUILD_GK_ARGV') || ['git-kit']; }
  catch (error) { return { ok: false, error: { code: 'invalid_gk_argv', message: error.message }, recover: [] }; }
  const args = [...command.slice(1), 'worktree', 'acquire', branch, '--from', baseSha, ...(noInit ? ['--no-init'] : []), '--json'];
  const result = spawnSync(command[0], args, {
    cwd, encoding: 'utf8', env: { ...process.env, GK_AGENT: '1' },
  });
  if (result.error) return { ok: false, error: { code: 'acquire_spawn_failed', message: result.error.message }, recover: [] };
  const envelope = parseAgentEnvelope(result);
  if (!envelope) {
    return { ok: false, error: { code: 'acquire_unparseable', message: 'git-kit returned no agent envelope', stdout: String(result.stdout || '').slice(-500), stderr: String(result.stderr || '').slice(-500) }, recover: [] };
  }
  const path = envelope?.result?.path;
  if (envelope.state === 'ok' && path) {
    const resolved = resolve(path);
    return { ok: true, path: existsSync(resolved) ? realpathSync(resolved) : resolved, envelope };
  }
  const error = envelope?.error || { code: envelope.state === 'ok' ? 'acquire_no_path' : envelope.state || 'acquire_failed', message: envelope.state === 'ok' ? 'git-kit returned no worktree path' : 'worktree acquire failed' };
  return { ok: false, error, recover: error.remedies || envelope?.result?.remedies || [] };
}

function childEnv(worktree) {
  const root = join(worktree, '.xm');
  const env = { ...process.env, X_BUILD_ROOT: join(root, 'build'), X_PANEL_ROOT: root, XM_ROOT: root };
  delete env.XKIT_SERVER;
  return env;
}

function runXBuild(worktree, args) {
  const result = spawnSync(process.execPath, [resolve(process.argv[1]), ...args], { cwd: worktree, env: childEnv(worktree), encoding: 'utf8' });
  return {
    ok: !result.error && result.status === 0, exit_code: result.status,
    stdout: String(result.stdout || '').slice(-1000), stderr: String(result.stderr || result.error?.message || '').slice(-1000),
  };
}

function runXBuildJson(worktree, args) {
  const result = spawnSync(process.execPath, [resolve(process.argv[1]), ...args], {
    cwd: worktree, env: childEnv(worktree), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  let value = null;
  try { value = JSON.parse(String(result.stdout || '').trim()); } catch {}
  return {
    ok: !result.error && result.status === 0 && value !== null, value, exit_code: result.status,
    stdout: String(result.stdout || '').slice(-1000), stderr: String(result.stderr || result.error?.message || '').slice(-1000),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) { return sha256(JSON.stringify(stable(value))); }

function gitValue(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function gitOk(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function fingerprintWithContract(cwd, contractHash) {
  const head = gitValue(cwd, ['rev-parse', 'HEAD']);
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const others = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (!head || diff.status !== 0 || others.status !== 0 || !contractHash) return null;
  const hash = createHash('sha256');
  hash.update(contractHash);
  hash.update(head);
  hash.update(diff.stdout || '');
  const files = String(others.stdout || '').split('\0').filter(Boolean)
    .filter((file) => !file.startsWith('.xm/') && file !== 'TASK-CONTEXT.md').sort();
  for (const file of files) {
    const blob = spawnSync('git', ['hash-object', '--no-filters', '--', file], { cwd, encoding: 'utf8' });
    if (blob.status !== 0 || !String(blob.stdout || '').trim()) return null;
    hash.update(`\0${file}\0`);
    hash.update(String(blob.stdout).trim());
  }
  return hash.digest('hex');
}

function taskStatePayload(tasks) {
  return [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((task) => ({
    id: task.id, source_plan_id: task.source_plan_id || null, status: task.status, depends_on: task.depends_on || [],
    expected_files: task.expected_files || [], done_criteria: task.done_criteria || [],
    review_group: task.review_group || null, interface_contract: task.interface_contract || null,
  }));
}

function taskEvidencePayload(evidence) {
  return {
    task_id: evidence.task_id, state: evidence.state, passed: evidence.passed, contract_hash: evidence.contract_hash,
    worktree_fingerprint: evidence.worktree_fingerprint,
    results: (evidence.results || []).map((result) => ({
      name: result.name, command: result.command, passed: result.passed, skipped: result.skipped, exit_code: result.exit_code,
    })),
  };
}

function verificationPath(batchId, topicId) { return join(topicRoot(batchId, topicId), 'verification.json'); }
function publicationPath(batchId, topicId) { return join(topicRoot(batchId, topicId), 'publication.json'); }
function publicationBodyPath(batchId, topicId) { return join(topicRoot(batchId, topicId), 'pull-request.md'); }
function sealPath(batchId) { return join(batchesRoot(), batchId, 'seal.json'); }
function integrationRoot(batchId) { return join(batchesRoot(), batchId, 'integration'); }
function integrationReceiptPath(batchId) { return join(integrationRoot(batchId), 'receipt.json'); }
function mergeRoot(batchId) { return join(batchesRoot(), batchId, 'merge'); }
function mergeReceiptPath(batchId) { return join(mergeRoot(batchId), 'receipt.json'); }

function semanticPlanHash(path) {
  try { return digest(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
}

function semanticPlanTextHash(text) {
  try { return digest(JSON.parse(text)); } catch { return null; }
}

function normalizedPlanTextHash(text) {
  try { return digest(normalizePlanEnvelope(JSON.parse(text))); } catch { return null; }
}

function verificationBindingPayload(receipt) {
  return { plan: receipt.plan, runtime: receipt.runtime, git: receipt.git, execution: receipt.execution, task_checks: receipt.task_checks };
}

function projectFor(batchId, topicId) { return toSlug(`batch-${batchId}-${topicId}`); }
function branchFor(batchId, topicId) { return `xm/${projectFor(batchId, topicId)}`; }

function handoffFor(batchId, topic) {
  const runtime = topic.runtime || {};
  const root = runtime.worktree ? join(runtime.worktree, '.xm') : null;
  const approvalRequired = topic.status !== 'prepared';
  return {
    id: topic.id, status: topic.status, cwd: runtime.worktree || null, branch: runtime.branch || null,
    base_ref: runtime.base_ref || null, base_sha: runtime.base_sha || null, project: runtime.project || null,
    plan_snapshot: runtime.plan_snapshot || null,
    env: root ? { X_BUILD_ROOT: join(root, 'build'), X_PANEL_ROOT: root, XM_ROOT: root } : null,
    approval_required: approvalRequired,
    approval_command: approvalRequired ? `xm batch approve ${batchId} ${topic.id}` : null,
    approval_cwd: resolve(batchesRoot(), '..', '..'),
    approval_env: { X_BUILD_ROOT: buildRoot() },
    command: runtime.project ? `xm build run --project ${runtime.project} --json` : null,
    recover: runtime.recover || [], last_error: runtime.last_error || null,
  };
}

function refreshBatchStatus(manifest) {
  const counts = Object.fromEntries(['pending', 'preparing', 'blocked', 'awaiting_approval', 'prepared', 'verified', 'published'].map((status) => [status, manifest.topics.filter((topic) => topic.status === status).length]));
  if (counts.blocked && manifest.topics.length > counts.blocked) manifest.status = 'partially_prepared';
  else if (counts.blocked) manifest.status = 'blocked';
  else if (counts.awaiting_approval) manifest.status = 'awaiting_approval';
  else if (counts.published === manifest.topics.length) manifest.status = 'published';
  else if (counts.published) manifest.status = 'partially_published';
  else if (counts.verified === manifest.topics.length) manifest.status = 'verified';
  else if (counts.verified) manifest.status = 'partially_verified';
  else if (counts.prepared && counts.pending) manifest.status = 'partially_prepared';
  else if (counts.prepared) manifest.status = 'prepared';
  else manifest.status = manifest.schedule ? 'planned' : 'collecting';
  manifest.updated_at = now();
}

function currentWave(manifest) {
  const finished = new Set(['verified', 'published', 'completed', 'merged']);
  for (const wave of manifest.schedule?.waves || []) {
    const topics = wave.topics.map((id) => manifest.topics.find((topic) => topic.id === id)).filter(Boolean);
    if (!topics.length || topics.every((topic) => finished.has(topic.status))) continue;
    return { ...wave, topic_rows: topics };
  }
  return null;
}

function receiptBinding(topic, receipt, evidence = null) {
  const runtime = topic.runtime || {};
  if (!receipt || receipt.schema_version !== 1 || receipt.topic !== topic.id
    || receipt.runtime?.project !== runtime.project || receipt.runtime?.worktree !== runtime.worktree) {
    return { valid: false, reason: 'receipt identity changed' };
  }
  let snapshot;
  try { snapshot = readFileSync(runtime.plan_snapshot, 'utf8'); } catch { return { valid: false, reason: 'plan snapshot is missing' }; }
  const snapshotSemantic = semanticPlanTextHash(snapshot);
  const normalizedPlan = topic.plan.normalized_sha256 || normalizedPlanTextHash(snapshot);
  const tasks = readJSON(join(runtime.build_root, 'projects', runtime.project, 'phases', '02-plan', 'tasks.json'))?.tasks;
  const importedPlan = join(runtime.build_root, 'projects', runtime.project, 'phases', '02-plan', 'imported-plan.json');
  const head = gitValue(runtime.worktree, ['rev-parse', 'HEAD']);
  const branch = gitValue(runtime.worktree, ['branch', '--show-current']);
  const taskState = Array.isArray(tasks) ? digest(taskStatePayload(tasks)) : null;
  const fingerprint = fingerprintWithContract(runtime.worktree, receipt.git?.contract_hash);
  const evidenceMatches = evidence == null || (evidence.length === receipt.task_checks?.length
    && evidence.every((item) => item.passed === true && item.state === 'passed'
      && item.contract_hash === receipt.git?.contract_hash
      && item.worktree_fingerprint === receipt.git?.worktree_fingerprint));
  const valid = receipt.plan?.source_sha256 === topic.plan.sha256
    && receipt.binding_sha256 === digest(verificationBindingPayload(receipt))
    && receipt.plan?.snapshot_sha256 === sha256(snapshot)
    && receipt.plan?.normalized_sha256 === normalizedPlan
    && receipt.plan?.snapshot_semantic_sha256 === snapshotSemantic
    && receipt.plan?.imported_semantic_sha256 === semanticPlanHash(importedPlan)
    && receipt.runtime?.branch === runtime.branch
    && receipt.runtime?.base_sha === runtime.base_sha
    && receipt.git?.head_sha === head
    && receipt.git?.branch === branch
    && receipt.git?.worktree_fingerprint === fingerprint
    && receipt.execution?.task_state_sha256 === taskState
    && evidenceMatches;
  return { valid, reason: valid ? null : 'verified topic changed after collection' };
}

function validateVerifiedReceipts(manifest, { persist = true, recheck = true } = {}) {
  const errors = [];
  for (const topic of manifest.topics.filter((row) => row.status === 'verified')) {
    const path = verificationPath(manifest.id, topic.id);
    const receipt = readJSON(path);
    let evidence = null;
    if (recheck && Array.isArray(receipt?.execution?.task_ids)) {
      evidence = receipt.execution.task_ids.map((id) => runXBuildJson(topic.runtime.worktree, ['task-check', id, '--project', topic.runtime.project, '--json']));
      evidence = evidence.every((item) => item.ok) ? evidence.map((item) => item.value) : [];
    }
    const binding = receiptBinding(topic, receipt, evidence);
    if (binding.valid) continue;
    if (persist) {
      topic.status = 'prepared';
      topic.runtime = {
        ...topic.runtime, stage: 'verification_stale', verification_receipt: path,
        last_error: { code: 'verification_receipt_stale', message: binding.reason },
      };
    }
    errors.push(`${topic.id}: ${binding.reason}`);
  }
  if (persist && errors.length) { refreshBatchStatus(manifest); writeJSON(manifestPath(manifest.id), manifest); }
  return errors;
}

function blockTopic(manifest, topic, stage, error, recover = []) {
  topic.status = 'blocked';
  topic.runtime = { ...topic.runtime, stage, last_error: error, recover };
  refreshBatchStatus(manifest);
  writeJSON(manifestPath(manifest.id), manifest);
}

function prepareTopic(manifest, topic, plan, base) {
  const branch = topic.runtime?.branch || branchFor(manifest.id, topic.id);
  const project = topic.runtime?.project || projectFor(manifest.id, topic.id);
  topic.status = 'preparing';
  topic.runtime = {
    ...topic.runtime, attempts: Number(topic.runtime?.attempts || 0) + 1, stage: 'acquiring',
    branch, project, base_ref: base.ref, base_sha: base.sha, last_error: null, recover: [],
  };
  refreshBatchStatus(manifest);
  writeJSON(manifestPath(manifest.id), manifest);

  let worktree = topic.runtime.worktree;
  if (!worktree || !existsSync(worktree)) {
    const acquired = acquireBatchWorktree(branch, base.sha);
    if (!acquired.ok) { blockTopic(manifest, topic, 'acquire_failed', acquired.error, acquired.recover); return handoffFor(manifest.id, topic); }
    worktree = acquired.path;
    topic.runtime = { ...topic.runtime, worktree, stage: 'acquired' };
    // git-kit's worktree init can install dependencies and leave files such as a
    // fresh lockfile. Record them so publish does not count them as topic work.
    const bootstrapUntracked = untrackedWork(worktree);
    if (!bootstrapUntracked) {
      blockTopic(manifest, topic, 'bootstrap_inspect_failed', { code: 'bootstrap_inspect_failed', message: 'cannot list untracked files after worktree acquire' });
      return handoffFor(manifest.id, topic);
    }
    topic.runtime.bootstrap_untracked = bootstrapUntracked;
    writeJSON(manifestPath(manifest.id), manifest);
  }

  const snapshot = planSnapshotPath(manifest.id, topic.id);
  atomicWrite(snapshot, plan.raw);
  topic.runtime = { ...topic.runtime, worktree, plan_snapshot: snapshot, plan_sha256: plan.sha256, build_root: join(worktree, '.xm', 'build'), stage: 'snapshotted' };
  writeJSON(manifestPath(manifest.id), manifest);

  const projectManifest = join(topic.runtime.build_root, 'projects', project, 'manifest.json');
  if (!existsSync(projectManifest)) {
    const initialized = runXBuild(worktree, ['init', project]);
    if (!initialized.ok) { blockTopic(manifest, topic, 'init_failed', { ...initialized, code: 'x_build_init_failed' }); return handoffFor(manifest.id, topic); }
    topic.runtime.stage = 'initialized';
    writeJSON(manifestPath(manifest.id), manifest);
  }

  const imported = runXBuild(worktree, ['import-plan', snapshot, '--replace', '--project', project, '--json']);
  if (!imported.ok) { blockTopic(manifest, topic, 'import_failed', { ...imported, code: 'x_build_import_failed' }); return handoffFor(manifest.id, topic); }
  topic.runtime.stage = 'imported';
  writeJSON(manifestPath(manifest.id), manifest);

  const checked = runXBuild(worktree, ['plan-check', '--project', project]);
  const checkPath = join(topic.runtime.build_root, 'projects', project, 'phases', '02-plan', 'plan-check.json');
  const receipt = readJSON(checkPath);
  if (!checked.ok || receipt?.passed !== true) { blockTopic(manifest, topic, 'plan_check_failed', { ...checked, code: 'x_build_plan_check_failed' }); return handoffFor(manifest.id, topic); }

  topic.status = 'awaiting_approval';
  topic.runtime = { ...topic.runtime, stage: 'checked', plan_check: checkPath, prepared_at: now(), last_error: null, recover: [] };
  refreshBatchStatus(manifest);
  writeJSON(manifestPath(manifest.id), manifest);
  return handoffFor(manifest.id, topic);
}

function requestedBase(args) {
  if (args.includes('--base') && option(args, '--base') == null) return { error: '--base requires a value' };
  const value = option(args, '--base');
  return { value: value || null };
}

function runtimeLimit(args, fallback = 4) {
  if (args.includes('--max-parallel') && option(args, '--max-parallel') == null) return { error: '--max-parallel requires a value' };
  const raw = option(args, '--max-parallel');
  const value = raw == null ? fallback : Number(raw);
  return Number.isInteger(value) && value > 0 ? { value } : { error: 'max_parallel must be a positive integer' };
}

function runBatchPreparation(args, action, dryRun = false) {
  const json = jsonRequested(args);
  const [batchId] = positionalArgs(args, ['--base', '--max-parallel']);
  const idError = validateIdSegment(batchId, 'batch id');
  if (idError) return fail(action, idError, { json });
  const baseOption = requestedBase(args);
  if (baseOption.error) return fail(action, baseOption.error, { json });
  const limit = runtimeLimit(args);
  if (limit.error) return fail(action, limit.error, { json });

  const lock = dryRun ? null : acquireOperationLock(batchId, action, json);
  if (!dryRun && !lock) return null;
  try {
    const manifest = loadBatch(batchId, action, json);
    if (!manifest) return null;
    if (!manifest.schedule) return fail(action, 'batch must be planned before run', { json });
    const verified = verifyPlanSources(manifest);
    if (verified.errors.length) return fail(action, verified.errors, { json });
    const staleReceipts = validateVerifiedReceipts(manifest, { persist: !dryRun, recheck: !dryRun });
    if (staleReceipts.length) return fail(action, staleReceipts, { json });

    let base = manifest.execution ? { ref: manifest.execution.base_ref, sha: manifest.execution.base_sha } : null;
    if (base && baseOption.value && baseOption.value !== base.ref) return fail(action, `batch already uses base ${base.ref}`, { json });
    if (!base) {
      base = resolveBase(baseOption.value || 'develop');
      if (base.error) return fail(action, base.error, { json });
    }
    const wave = currentWave(manifest);
    if (!wave) return fail(action, 'batch has no runnable wave', { json });
    const retryable = new Set(['pending', 'preparing', 'blocked']);
    const selected = wave.topic_rows.filter((topic) => retryable.has(topic.status)).slice(0, limit.value);
    const predicted = selected.map((topic) => ({ id: topic.id, branch: topic.runtime?.branch || branchFor(batchId, topic.id), base_ref: base.ref, base_sha: base.sha }));
    if (dryRun) return emit({ action, status: 'dry-run', batch: batchId, wave: wave.index, base, topics: predicted }, json, `Would prepare ${predicted.length} topic(s) for ${batchId}`);

    if (!manifest.execution) manifest.execution = { wave: wave.index, base_ref: base.ref, base_sha: base.sha, started_at: now() };
    else manifest.execution.wave = wave.index;
    writeJSON(manifestPath(batchId), manifest);
    const handoffs = selected.map((topic) => prepareTopic(manifest, topic, verified.plans.get(topic.id), base));
    const currentHandoffs = wave.topic_rows.filter((topic) => ['awaiting_approval', 'prepared', 'blocked'].includes(topic.status)).map((topic) => handoffFor(batchId, topic));
    const blocked = currentHandoffs.filter((handoff) => handoff.status === 'blocked');
    refreshBatchStatus(manifest);
    writeJSON(manifestPath(batchId), manifest);
    const output = {
      action, status: blocked.length ? 'partial' : manifest.status, batch: batchId, wave: wave.index, base, topics: currentHandoffs,
      attempted: handoffs.map((handoff) => handoff.id),
      prepared_now: handoffs.filter((handoff) => ['awaiting_approval', 'prepared'].includes(handoff.status)).map((handoff) => handoff.id),
      remaining: wave.topic_rows.filter((topic) => topic.status === 'pending').map((topic) => topic.id),
    };
    if (blocked.length) process.exitCode = 2;
    return emit(output, json, `${batchId}: ${output.status}`);
  } finally { releaseOperationLock(lock); }
}

function cmdRun(args) { return runBatchPreparation(args, 'batch.run', args.includes('--dry-run')); }
function cmdResume(args) { return runBatchPreparation(args, 'batch.resume', false); }

function cmdApprove(args) {
  const action = 'batch.approve';
  const json = jsonRequested(args);
  const positional = positionalArgs(args);
  const [batchId, ...requestedTopics] = positional;
  const idError = validateIdSegment(batchId, 'batch id') || requestedTopics.map((id) => validateIdSegment(id, 'topic id')).find(Boolean);
  if (idError) return fail(action, idError, { json });
  const lock = acquireOperationLock(batchId, action, json);
  if (!lock) return null;
  try {
    const manifest = loadBatch(batchId, action, json);
    if (!manifest) return null;
    const verified = verifyPlanSources(manifest);
    if (verified.errors.length) return fail(action, verified.errors, { json });
    const ids = requestedTopics.length ? requestedTopics : manifest.topics.filter((topic) => topic.status === 'awaiting_approval').map((topic) => topic.id);
    const targets = ids.map((id) => manifest.topics.find((topic) => topic.id === id));
    const invalid = ids.filter((id, index) => !targets[index] || !['awaiting_approval', 'prepared'].includes(targets[index].status));
    if (invalid.length) return fail(action, invalid.map((id) => `${id}: topic is not awaiting approval`), { json });
    if (!targets.length) return fail(action, 'no topics are awaiting approval', { json });

    const handoffs = [];
    const blocked = [];
    for (const topic of targets) {
      if (topic.status === 'prepared') { handoffs.push(handoffFor(batchId, topic)); continue; }
      const approved = runXBuild(topic.runtime.worktree, ['gate', 'pass', '--project', topic.runtime.project]);
      if (!approved.ok) {
        topic.runtime = { ...topic.runtime, last_error: { ...approved, code: 'x_build_approval_failed' } };
        blocked.push(topic.id);
      } else {
        topic.status = 'prepared';
        topic.runtime = { ...topic.runtime, stage: 'approved', approved_at: now(), last_error: null };
      }
      refreshBatchStatus(manifest);
      writeJSON(manifestPath(batchId), manifest);
      handoffs.push(handoffFor(batchId, topic));
    }
    const output = { action, status: blocked.length ? 'partial' : manifest.status, batch: batchId, topics: handoffs, blocked };
    if (blocked.length) process.exitCode = 2;
    return emit(output, json, `${batchId}: approved ${handoffs.length - blocked.length} topic(s)`);
  } finally { releaseOperationLock(lock); }
}

function collectFailure(topic, code, message, details = null) {
  topic.runtime = { ...topic.runtime, last_error: { code, message, ...(details ? { details } : {}) } };
  return { id: topic.id, status: topic.status, ok: false, error: topic.runtime.last_error };
}

function collectTopic(manifest, topic, wave) {
  const runtime = topic.runtime || {};
  for (const field of ['worktree', 'project', 'branch', 'base_sha', 'plan_snapshot', 'build_root']) {
    if (!runtime[field]) return collectFailure(topic, 'collect_runtime_incomplete', `missing runtime.${field}`);
  }
  if (!existsSync(runtime.worktree) || !existsSync(runtime.plan_snapshot)) {
    return collectFailure(topic, 'collect_artifact_missing', 'worktree or plan snapshot is missing');
  }

  if (topic.status === 'verified') {
    const receipt = readJSON(verificationPath(manifest.id, topic.id));
    const checks = Array.isArray(receipt?.execution?.task_ids)
      ? receipt.execution.task_ids.map((id) => runXBuildJson(runtime.worktree, ['task-check', id, '--project', runtime.project, '--json']))
      : [];
    const evidence = checks.length > 0 && checks.every((item) => item.ok) ? checks.map((item) => item.value) : [];
    const binding = receiptBinding(topic, receipt, evidence);
    if (binding.valid) return { id: topic.id, status: 'verified', ok: true, reused: true, receipt: verificationPath(manifest.id, topic.id) };
    topic.status = 'prepared';
    return collectFailure(topic, 'verification_receipt_stale', binding.reason);
  }

  const initialStatus = runXBuildJson(runtime.worktree, ['run-status', '--project', runtime.project, '--json']);
  if (!initialStatus.ok) return collectFailure(topic, 'run_status_failed', 'cannot read x-build run status', initialStatus);
  if (initialStatus.value.all_done !== true || initialStatus.value.blocked_tasks?.length || initialStatus.value.stale_running?.length) {
    return collectFailure(topic, 'topic_not_complete', 'x-build tasks are not complete', initialStatus.value);
  }

  const tasksPath = join(runtime.build_root, 'projects', runtime.project, 'phases', '02-plan', 'tasks.json');
  const tasks = readJSON(tasksPath)?.tasks;
  if (!Array.isArray(tasks) || !tasks.length || tasks.some((task) => task.status !== 'completed')) {
    return collectFailure(topic, 'task_state_incomplete', 'every topic task must be completed');
  }

  const evidence = [];
  for (const task of [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const checked = runXBuildJson(runtime.worktree, ['task-check', task.id, '--project', runtime.project, '--json']);
    if (!checked.ok || checked.value?.passed !== true || checked.value?.state !== 'passed') {
      return collectFailure(topic, 'task_check_failed', `${task.id}: task check did not pass`, checked);
    }
    if (resolve(checked.value.cwd || '.') !== resolve(runtime.worktree) || !checked.value.contract_hash || !checked.value.worktree_fingerprint) {
      return collectFailure(topic, 'task_check_unbound', `${task.id}: task check evidence is not bound to this worktree`);
    }
    evidence.push(checked.value);
  }

  let finalStatus = runXBuildJson(runtime.worktree, ['run-status', '--project', runtime.project, '--json']);
  const group = String(finalStatus.value?.next_action || '').match(/^group-check\s+(\S+)$/)?.[1];
  if (finalStatus.ok && group) {
    const checkedGroup = runXBuildJson(runtime.worktree, ['group-check', group, '--project', runtime.project, '--json']);
    if (!checkedGroup.ok || checkedGroup.value?.ok !== true) return collectFailure(topic, 'group_check_failed', `${group}: group check did not pass`, checkedGroup);
    finalStatus = runXBuildJson(runtime.worktree, ['run-status', '--project', runtime.project, '--json']);
  }
  if (!finalStatus.ok || finalStatus.value?.all_done !== true || finalStatus.value?.next_action !== 'phase next') {
    return collectFailure(topic, 'topic_verification_incomplete', 'x-build verification is not ready to leave Execute', finalStatus);
  }

  const contracts = new Set(evidence.map((item) => item.contract_hash));
  const fingerprints = new Set(evidence.map((item) => item.worktree_fingerprint));
  if (contracts.size !== 1 || fingerprints.size !== 1) return collectFailure(topic, 'task_check_disagreement', 'task checks do not describe one workspace snapshot');
  const contractHash = evidence[0].contract_hash;
  const fingerprint = fingerprintWithContract(runtime.worktree, contractHash);
  if (!fingerprint || fingerprint !== evidence[0].worktree_fingerprint) return collectFailure(topic, 'workspace_changed_after_check', 'worktree changed after task checks');

  const head = gitValue(runtime.worktree, ['rev-parse', 'HEAD']);
  const branch = gitValue(runtime.worktree, ['branch', '--show-current']);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', runtime.base_sha, 'HEAD'], { cwd: runtime.worktree });
  if (!head || branch !== runtime.branch || ancestor.status !== 0) return collectFailure(topic, 'git_binding_failed', 'worktree branch or base ancestry changed');
  const outside = filesOutsideScope(topic);
  if (!outside) return collectFailure(topic, 'scope_check_failed', 'cannot list files changed since the base');
  if (outside.length) return collectFailure(topic, 'scope_drift', `committed files outside the plan scope: ${outside.join(', ')}`, { files: outside });
  let snapshot;
  try { snapshot = readFileSync(runtime.plan_snapshot, 'utf8'); } catch (error) { return collectFailure(topic, 'plan_snapshot_missing', error.message); }
  const importedPlan = join(runtime.build_root, 'projects', runtime.project, 'phases', '02-plan', 'imported-plan.json');
  const snapshotSemantic = semanticPlanTextHash(snapshot);
  const importedSemantic = semanticPlanHash(importedPlan);
  if (!snapshotSemantic) return collectFailure(topic, 'plan_snapshot_invalid', 'plan snapshot is not valid JSON');
  const normalizedPlan = topic.plan.normalized_sha256 || normalizedPlanTextHash(snapshot);
  if (!normalizedPlan || importedSemantic !== normalizedPlan) {
    return collectFailure(topic, 'imported_plan_drift', 'imported plan differs from the registered normalized plan');
  }
  const currentTasks = readJSON(tasksPath)?.tasks || [];
  const receipt = {
    schema_version: 1, batch: manifest.id, topic: topic.id, wave: wave.index, verified_at: now(),
    plan: { source_sha256: topic.plan.sha256, normalized_sha256: normalizedPlan, snapshot_sha256: sha256(snapshot), snapshot_semantic_sha256: snapshotSemantic, imported_semantic_sha256: importedSemantic },
    runtime: { project: runtime.project, worktree: runtime.worktree, branch: runtime.branch, base_sha: runtime.base_sha },
    git: { head_sha: head, branch, contract_hash: contractHash, worktree_fingerprint: fingerprint },
    execution: { all_done: true, task_ids: currentTasks.map((task) => task.id).sort(), task_state_sha256: digest(taskStatePayload(currentTasks)) },
    task_checks: evidence.map((item) => {
      const payload = taskEvidencePayload(item);
      return { ...payload, evidence_sha256: digest(payload) };
    }),
  };
  receipt.binding_sha256 = digest(verificationBindingPayload(receipt));
  const path = verificationPath(manifest.id, topic.id);
  const previous = readJSON(path);
  if (previous?.binding_sha256 && previous.binding_sha256 !== receipt.binding_sha256) {
    atomicWrite(join(topicRoot(manifest.id, topic.id), 'verification-history', previous.binding_sha256 + '.json'), JSON.stringify(previous, null, 2) + '\n');
  }
  atomicWrite(path, JSON.stringify(receipt, null, 2) + '\n');
  topic.status = 'verified';
  topic.runtime = { ...runtime, stage: 'verified', verified_at: receipt.verified_at, verification_receipt: path, last_error: null };
  return { id: topic.id, status: 'verified', ok: true, reused: false, receipt: path, binding_sha256: receipt.binding_sha256 };
}

function cmdCollect(args) {
  const action = 'batch.collect';
  const json = jsonRequested(args);
  const [batchId, ...requested] = positionalArgs(args);
  const idError = validateIdSegment(batchId, 'batch id') || requested.map((id) => validateIdSegment(id, 'topic id')).find(Boolean);
  if (idError) return fail(action, idError, { json });
  const lock = acquireOperationLock(batchId, action, json);
  if (!lock) return null;
  try {
    const manifest = loadBatch(batchId, action, json);
    if (!manifest) return null;
    const verifiedPlans = verifyPlanSources(manifest);
    if (verifiedPlans.errors.length) return fail(action, verifiedPlans.errors, { json });
    const wave = manifest.schedule?.waves?.find((candidate) => candidate.index === manifest.execution?.wave);
    if (!wave) return fail(action, 'batch has no active execution wave', { json });
    const allowed = new Set(wave.topics);
    const ids = requested.length ? requested : wave.topics.filter((id) => ['prepared', 'verified'].includes(manifest.topics.find((topic) => topic.id === id)?.status));
    const invalid = ids.filter((id) => !allowed.has(id) || !['prepared', 'verified'].includes(manifest.topics.find((topic) => topic.id === id)?.status));
    if (invalid.length) return fail(action, invalid.map((id) => `${id}: topic is not collectable in wave ${wave.index}`), { json });
    if (!ids.length) return fail(action, 'no prepared topics are available to collect', { json });
    const results = ids.map((id) => collectTopic(manifest, manifest.topics.find((topic) => topic.id === id), wave));
    refreshBatchStatus(manifest);
    writeJSON(manifestPath(batchId), manifest);
    const failed = results.filter((result) => !result.ok);
    const output = { action, status: failed.length ? (failed.length === results.length ? 'blocked' : 'partial') : manifest.status, batch: batchId, wave: wave.index, topics: results };
    if (failed.length) process.exitCode = 2;
    return emit(output, json, `${batchId}: collected ${results.length - failed.length}/${results.length} topic(s)`);
  } finally { releaseOperationLock(lock); }
}

function prTitle(manifest, topic) {
  const value = `[${manifest.id}/${topic.id}] ${topic.goal}`;
  return value.length <= 69 ? value : value.slice(0, 68).trimEnd() + '…';
}

function prBody(manifest, topic, receipt) {
  return [
    '## Summary', '', topic.goal, '',
    '## Batch', '',
    `- Batch: ${manifest.id}`,
    `- Topic: ${topic.id}`,
    `- Verification: ${receipt.binding_sha256}`,
    `- Verified head: ${receipt.git.head_sha}`,
    `- Base: ${topic.runtime.base_ref} (${topic.runtime.base_sha})`,
    '',
  ].join('\n');
}

function publishCommand(name, fallback) {
  try { return parseArgvEnv(name) || fallback; }
  catch (error) { return { error: error.message }; }
}

function untrackedWork(cwd) {
  const result = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').split('\0').filter(Boolean)
    .filter((file) => !file.startsWith('.xm/') && file !== 'TASK-CONTEXT.md');
}

function filesOutsideScope(topic) {
  if (!topic.expected_files_complete) return [];
  const { worktree, base_sha: baseSha } = topic.runtime || {};
  const changed = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', baseSha, 'HEAD'], { cwd: worktree, encoding: 'utf8' });
  if (changed.status !== 0) return null;
  const allowed = new Set(normalizeExpectedFiles(topic.expected_files));
  return String(changed.stdout || '').split('\0').filter(Boolean).filter((file) => !allowed.has(file));
}

function cleanPublishWorktree(topic) {
  const cwd = topic.runtime.worktree;
  const tracked = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd, encoding: 'utf8' });
  const untracked = untrackedWork(cwd);
  if (tracked.status !== 0 || !untracked) return { ok: false, reason: 'cannot inspect worktree status' };
  const bootstrap = new Set(topic.runtime.bootstrap_untracked || []);
  const extra = untracked.filter((file) => !bootstrap.has(file));
  if (String(tracked.stdout || '').trim() || extra.length) return { ok: false, reason: 'worktree has uncommitted changes' };
  return { ok: true };
}

function publicationBinding(receipt) {
  if (!receipt || receipt.schema_version !== 1 || !receipt.binding_sha256) return false;
  const payload = { batch: receipt.batch, topic: receipt.topic, verification: receipt.verification, git: receipt.git, pr: receipt.pr };
  return receipt.binding_sha256 === digest(payload);
}

function publicationMatchesTopic(manifest, topic, publication, verification) {
  return publicationBinding(publication)
    && publication.batch === manifest.id
    && publication.topic === topic.id
    && publication.verification?.receipt === verificationPath(manifest.id, topic.id)
    && publication.verification?.binding_sha256 === verification.binding_sha256
    && publication.verification?.head_sha === verification.git.head_sha
    && publication.verification?.base_ref === topic.runtime.base_ref
    && publication.verification?.base_sha === topic.runtime.base_sha
    && publication.git?.remote === topic.publication?.remote
    && publication.git?.branch === topic.runtime.branch
    && publication.pr?.number === topic.publication?.pr_number
    && publication.pr?.url === topic.publication?.pr_url
    && publication.pr?.head_ref_oid === topic.publication?.head_sha
    && topic.publication?.receipt === publicationPath(manifest.id, topic.id)
    && topic.publication?.binding_sha256 === publication.binding_sha256;
}

export function orderSealRows(order, rows) {
  const byTopic = new Map(rows.map((row) => [row.topic.id, row]));
  return order.map((id) => byTopic.get(id)).filter(Boolean);
}

function publishPreflight(manifest, requested, options) {
  const errors = [];
  const ids = requested.length ? requested : manifest.topics.filter((topic) => ['verified', 'published'].includes(topic.status)).map((topic) => topic.id);
  const topics = ids.map((id) => manifest.topics.find((topic) => topic.id === id));
  for (let index = 0; index < ids.length; index += 1) {
    const topic = topics[index];
    if (!topic) { errors.push(`${ids[index]}: unknown topic`); continue; }
    if (!['verified', 'published'].includes(topic.status)) { errors.push(`${topic.id}: topic is not verified`); continue; }
    if (topic.depends_on?.length) { errors.push(`${topic.id}: dependent topics require stacked PR support`); continue; }
    const outside = filesOutsideScope(topic);
    if (!outside) { errors.push(`${topic.id}: cannot list files changed since the base`); continue; }
    if (outside.length) { errors.push(`${topic.id}: committed files outside the plan scope: ${outside.join(', ')}`); continue; }
    const receipt = readJSON(verificationPath(manifest.id, topic.id));
    const binding = receiptBinding(topic, receipt);
    if (!binding.valid) { errors.push(`${topic.id}: ${binding.reason}`); continue; }
    const head = gitValue(topic.runtime.worktree, ['rev-parse', 'HEAD']);
    const branch = gitValue(topic.runtime.worktree, ['branch', '--show-current']);
    if (head !== receipt.git.head_sha || branch !== topic.runtime.branch) { errors.push(`${topic.id}: verified branch head changed`); continue; }
    if (head === topic.runtime.base_sha) { errors.push(`${topic.id}: no changes to publish`); continue; }
    if (spawnSync('git', ['merge-base', '--is-ancestor', topic.runtime.base_sha, 'HEAD'], { cwd: topic.runtime.worktree }).status !== 0) {
      errors.push(`${topic.id}: verified base is not an ancestor of HEAD`); continue;
    }
    const clean = cleanPublishWorktree(topic);
    if (!clean.ok) { errors.push(`${topic.id}: ${clean.reason}`); continue; }
    if (options.base && options.base !== topic.runtime.base_ref) { errors.push(`${topic.id}: publish base must remain ${topic.runtime.base_ref}`); continue; }
  }
  if (!ids.length) errors.push('no verified topics are available to publish');
  if (new Set(ids).size !== ids.length) errors.push('duplicate topic ids are not allowed');
  return { errors, topics: errors.length ? [] : topics };
}

function publishPreview(manifest, topics, options, commands) {
  return topics.map((topic) => {
    const receipt = readJSON(verificationPath(manifest.id, topic.id));
    const title = prTitle(manifest, topic);
    const body = prBody(manifest, topic, receipt);
    const bodyPath = publicationBodyPath(manifest.id, topic.id);
    return {
      id: topic.id, remote: options.remote, base: topic.runtime.base_ref, head: topic.runtime.branch, title, body,
      body_file: bodyPath,
      push_argv: [...commands.gk, 'push', options.remote, topic.runtime.branch, '--from', topic.runtime.branch, '--yes', '--json'],
      create_argv: [...commands.gh, 'pr', 'create', '--base', topic.runtime.base_ref, '--head', topic.runtime.branch, '--title', title, '--body-file', bodyPath],
    };
  });
}

function runPublishCommand(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return { ok: !result.error && result.status === 0, exit_code: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || result.error?.message || '') };
}

function verifyPrView(viewed, expected, receipt) {
  const value = viewed.value;
  const valid = viewed.ok && Number.isInteger(value?.number) && typeof value?.url === 'string'
    && value.state === 'OPEN' && value.baseRefName === expected.base && value.headRefName === expected.head
    && value.headRefOid === receipt.git.head_sha && value.title === expected.title && value.body === expected.body;
  return { valid, value, reason: valid ? null : 'GitHub PR does not match the verified publication' };
}

// gh 2.46 rejects `pr view --json baseRefOid` as an unknown field, so the base OID comes from the REST pull.
function withBaseRefOid(command, viewed, cwd) {
  if (!viewed.ok || !Number.isInteger(viewed.value?.number)) return viewed;
  const result = runPublishCommand(command, ['api', `repos/{owner}/{repo}/pulls/${viewed.value.number}`], cwd);
  let pull = null;
  try { pull = JSON.parse(result.stdout.trim()); } catch {}
  if (!result.ok || typeof pull?.base?.sha !== 'string') {
    return { ...result, ok: false, value: null, stderr: result.stderr.trim() || `GitHub API returned no base SHA for PR ${viewed.value.number}` };
  }
  return { ...viewed, value: { ...viewed.value, baseRefOid: pull.base.sha } };
}

function ghView(command, target, cwd) {
  const result = runPublishCommand(command, ['pr', 'view', target, '--json', 'number,url,state,baseRefName,headRefName,headRefOid,title,body'], cwd);
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch {}
  return withBaseRefOid(command, { ...result, value }, cwd);
}

function prViewFailed(topic, viewed) {
  return { id: topic.id, ok: false, error: { code: 'pr_view_failed', message: viewed.stderr.trim() || 'gh pr view failed' } };
}

function ghStderr(result) {
  const stderr = result.stderr.trim();
  return stderr ? `: ${stderr}` : '';
}

function savePublication(manifest, topic, expected, verification, value, remote) {
  const publishedAt = now();
  const receipt = {
    schema_version: 1, batch: manifest.id, topic: topic.id, published_at: publishedAt,
    verification: { receipt: verificationPath(manifest.id, topic.id), binding_sha256: verification.binding_sha256, head_sha: verification.git.head_sha, base_ref: topic.runtime.base_ref, base_sha: topic.runtime.base_sha },
    git: { remote, branch: topic.runtime.branch, push_state: 'ok' },
    pr: {
      number: value.number, url: value.url, state: value.state, base_ref_name: value.baseRefName, base_ref_oid: value.baseRefOid || null,
      head_ref_name: value.headRefName, head_ref_oid: value.headRefOid, title: value.title, body_sha256: sha256(value.body),
    },
  };
  receipt.binding_sha256 = digest({ batch: receipt.batch, topic: receipt.topic, verification: receipt.verification, git: receipt.git, pr: receipt.pr });
  const path = publicationPath(manifest.id, topic.id);
  atomicWrite(path, JSON.stringify(receipt, null, 2) + '\n');
  topic.status = 'published';
  topic.publication = { receipt: path, binding_sha256: receipt.binding_sha256, published_at: publishedAt, remote, base_ref: topic.runtime.base_ref, head_sha: verification.git.head_sha, pr_number: value.number, pr_url: value.url };
  topic.runtime = { ...topic.runtime, stage: 'published', last_error: null };
  refreshBatchStatus(manifest);
  writeJSON(manifestPath(manifest.id), manifest);
  return receipt;
}

function publishTopic(manifest, topic, expected, commands) {
  const verification = readJSON(verificationPath(manifest.id, topic.id));
  const prior = readJSON(publicationPath(manifest.id, topic.id));
  if (prior) {
    if (!publicationBinding(prior) || prior.verification?.binding_sha256 !== verification.binding_sha256) {
      return { id: topic.id, ok: false, error: { code: 'publication_receipt_stale', message: 'saved publication is not bound to current verification' } };
    }
    const viewed = ghView(commands.gh, prior.pr.number, topic.runtime.worktree);
    if (!viewed.ok) return prViewFailed(topic, viewed);
    const checked = verifyPrView(viewed, expected, verification);
    if (!checked.valid) return { id: topic.id, ok: false, error: { code: 'pr_verification_failed', message: checked.reason } };
    if (topic.status !== 'published') savePublication(manifest, topic, expected, verification, checked.value, expected.remote);
    return { id: topic.id, ok: true, reused: true, pr_number: checked.value.number, pr_url: checked.value.url };
  }

  const bodyPath = publicationBodyPath(manifest.id, topic.id);
  atomicWrite(bodyPath, expected.body);
  const pushed = runPublishCommand(commands.gk, ['push', expected.remote, expected.head, '--from', expected.head, '--yes', '--json'], topic.runtime.worktree, { GK_AGENT: '1' });
  let pushEnvelope = null;
  try { pushEnvelope = JSON.parse(pushed.stdout.trim()); } catch {}
  if (!pushed.ok || pushEnvelope?.state !== 'ok') return { id: topic.id, ok: false, error: { code: 'push_failed', message: pushed.stderr.trim() || pushEnvelope?.error?.message || 'git-kit push failed' } };

  let viewed = ghView(commands.gh, expected.head, topic.runtime.worktree);
  if (!viewed.ok) {
    if (!viewed.stderr.includes('no pull requests found for branch')) return prViewFailed(topic, viewed);
    const created = runPublishCommand(commands.gh, ['pr', 'create', '--base', expected.base, '--head', expected.head, '--title', expected.title, '--body-file', bodyPath], topic.runtime.worktree);
    if (!created.ok || !created.stdout.trim()) return { id: topic.id, ok: false, error: { code: 'pr_create_failed', message: created.stderr.trim() || 'gh pr create failed' } };
    topic.runtime = { ...topic.runtime, publish_attempt: { pr_url: created.stdout.trim(), created_at: now() } };
    writeJSON(manifestPath(manifest.id), manifest);
    viewed = ghView(commands.gh, created.stdout.trim(), topic.runtime.worktree);
    if (!viewed.ok) return prViewFailed(topic, viewed);
  }
  const checked = verifyPrView(viewed, expected, verification);
  if (!checked.valid) return { id: topic.id, ok: false, error: { code: 'pr_verification_failed', message: checked.reason } };
  const receipt = savePublication(manifest, topic, expected, verification, checked.value, expected.remote);
  return { id: topic.id, ok: true, reused: false, pr_number: checked.value.number, pr_url: checked.value.url, receipt: publicationPath(manifest.id, topic.id), binding_sha256: receipt.binding_sha256 };
}

function cmdPublish(args) {
  const action = 'batch.publish';
  const json = jsonRequested(args);
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  if (dryRun && yes) return fail(action, '--dry-run and --yes cannot be combined', { json });
  if (args.includes('--base') && option(args, '--base') == null) return fail(action, '--base requires a value', { json });
  if (args.includes('--remote') && option(args, '--remote') == null) return fail(action, '--remote requires a value', { json });
  const [batchId, ...requested] = positionalArgs(args, ['--base', '--remote']);
  const idError = validateIdSegment(batchId, 'batch id') || requested.map((id) => validateIdSegment(id, 'topic id')).find(Boolean);
  if (idError) return fail(action, idError, { json });
  const options = { base: option(args, '--base'), remote: option(args, '--remote') || 'origin' };
  const gk = publishCommand('X_BUILD_GK_ARGV', ['git-kit']);
  const gh = publishCommand('X_BUILD_GH_ARGV', ['gh']);
  if (gk.error || gh.error) return fail(action, gk.error || gh.error, { json });
  const commands = { gk, gh };

  const previewOnly = () => {
    const manifest = loadBatch(batchId, action, json);
    if (!manifest) return null;
    const plans = verifyPlanSources(manifest);
    if (plans.errors.length) return fail(action, plans.errors, { json });
    const preflight = publishPreflight(manifest, requested, options);
    if (preflight.errors.length) return fail(action, preflight.errors, { json });
    const preview = publishPreview(manifest, preflight.topics, options, commands);
    if (!yes) {
      const output = { action, status: dryRun ? 'dry-run' : 'awaiting_confirmation', batch: batchId, topics: preview };
      if (!dryRun) process.exitCode = 2;
      return emit(output, json, `${batchId}: ${output.status}`);
    }
    return { manifest, preflight, preview };
  };

  if (!yes) return previewOnly();
  const lock = acquireOperationLock(batchId, action, json);
  if (!lock) return null;
  try {
    const prepared = previewOnly();
    if (!prepared?.manifest) return prepared;
    const results = prepared.preview.map((expected) => {
      const topic = prepared.manifest.topics.find((row) => row.id === expected.id);
      const result = publishTopic(prepared.manifest, topic, expected, commands);
      if (!result.ok) {
        topic.runtime = { ...topic.runtime, stage: 'publish_failed', last_error: result.error };
        refreshBatchStatus(prepared.manifest);
        writeJSON(manifestPath(batchId), prepared.manifest);
      }
      return result;
    });
    const failed = results.filter((result) => !result.ok);
    const output = { action, status: failed.length ? (failed.length === results.length ? 'blocked' : 'partial') : prepared.manifest.status, batch: batchId, topics: results };
    if (failed.length) process.exitCode = 2;
    return emit(output, json, `${batchId}: published ${results.length - failed.length}/${results.length} topic(s)`);
  } finally { releaseOperationLock(lock); }
}

function sealBindingPayload(receipt) {
  return { schema_version: receipt.schema_version, batch: receipt.batch, base: receipt.base, merge_order: receipt.merge_order, prs: receipt.prs };
}

function invalidateSeal(manifest, reasons) {
  if (!existsSync(sealPath(manifest.id))) return;
  manifest.status = 'published';
  manifest.seal = {
    ...(manifest.seal || {}), valid: false, invalidated_at: now(),
    invalidation_reasons: Array.isArray(reasons) ? reasons : [reasons],
  };
  manifest.updated_at = now();
  writeJSON(manifestPath(manifest.id), manifest);
}

function validateSealSet(manifest, baseOverride) {
  const errors = [];
  if (!manifest.topics.length) errors.push('batch has no topics');
  const order = (manifest.schedule?.waves || []).flatMap((wave) => wave.topics || []);
  const ids = manifest.topics.map((topic) => topic.id);
  if (order.length !== ids.length || new Set(order).size !== order.length || ids.some((id) => !order.includes(id))) {
    errors.push('schedule must contain every topic exactly once');
  }
  const rows = [];
  for (const topic of manifest.topics) {
    if (topic.status !== 'published') { errors.push(`${topic.id}: topic is not published`); continue; }
    if (topic.depends_on?.length) { errors.push(`${topic.id}: dependent topics require stacked PR support`); continue; }
    const verification = readJSON(verificationPath(manifest.id, topic.id));
    const verified = receiptBinding(topic, verification);
    if (!verified.valid) { errors.push(`${topic.id}: ${verified.reason}`); continue; }
    const publication = readJSON(publicationPath(manifest.id, topic.id));
    if (!publicationMatchesTopic(manifest, topic, publication, verification)) { errors.push(`${topic.id}: publication binding is invalid`); continue; }
    rows.push({ topic, verification, publication, expected: {
      base: topic.runtime.base_ref, head: topic.runtime.branch, title: prTitle(manifest, topic), body: prBody(manifest, topic, verification), remote: publication.git.remote,
    } });
  }
  const remotes = new Set(rows.map((row) => row.publication.git.remote));
  const bases = new Set(rows.map((row) => row.topic.runtime.base_ref));
  if (remotes.size > 1) errors.push('published topics use different remotes');
  if (bases.size > 1) errors.push('published topics use different base branches');
  const base = rows[0]?.topic.runtime.base_ref || null;
  if (baseOverride && baseOverride !== base) errors.push(`seal base must remain ${base}`);
  const numbers = rows.map((row) => row.publication.pr.number);
  const urls = rows.map((row) => row.publication.pr.url);
  const heads = rows.map((row) => row.publication.pr.head_ref_name);
  if (new Set(numbers).size !== numbers.length || new Set(urls).size !== urls.length || new Set(heads).size !== heads.length) errors.push('published PR identities must be unique');
  const orderedRows = orderSealRows(order, rows);
  return { errors, order, rows: orderedRows, remote: rows[0]?.publication.git.remote || null, base };
}

function cmdSeal(args) {
  const action = 'batch.seal';
  const json = jsonRequested(args);
  if (args.includes('--base') && option(args, '--base') == null) return fail(action, '--base requires a value', { json });
  const positional = positionalArgs(args, ['--base']);
  if (positional.length !== 1) return fail(action, 'Usage: xm batch seal <id> [--base BRANCH] [--json]', { json });
  const [batchId] = positional;
  const idError = validateIdSegment(batchId, 'batch id');
  if (idError) return fail(action, idError, { json });
  const gh = publishCommand('X_BUILD_GH_ARGV', ['gh']);
  if (gh.error) return fail(action, gh.error, { json });
  const lock = acquireOperationLock(batchId, action, json);
  if (!lock) return null;
  try {
    const manifest = loadBatch(batchId, action, json);
    if (!manifest) return null;
    const plans = verifyPlanSources(manifest);
    if (plans.errors.length) { invalidateSeal(manifest, plans.errors); return fail(action, plans.errors, { json }); }
    const set = validateSealSet(manifest, option(args, '--base'));
    if (set.errors.length) { invalidateSeal(manifest, set.errors); return fail(action, set.errors, { json }); }

    const viewed = [];
    for (const row of set.rows) {
      const result = ghView(gh, row.publication.pr.number, row.topic.runtime.worktree);
      if (!result.ok || !result.value) return fail(action, `${row.topic.id}: cannot read GitHub PR${ghStderr(result)}`, { json, code: 1 });
      const checked = verifyPrView(result, row.expected, row.verification);
      if (!checked.valid || result.value.number !== row.publication.pr.number || result.value.url !== row.publication.pr.url) {
        const reason = `${row.topic.id}: ${checked.reason || 'GitHub PR identity changed'}`;
        invalidateSeal(manifest, reason);
        return fail(action, reason, { json });
      }
      viewed.push({ row, value: result.value });
    }
    const baseOids = new Set(viewed.map(({ value }) => value.baseRefOid));
    if (baseOids.size !== 1 || !viewed[0]?.value.baseRefOid) {
      const reason = 'published PRs do not share one current base OID';
      invalidateSeal(manifest, reason);
      return fail(action, reason, { json });
    }
    const baseOid = viewed[0].value.baseRefOid;
    const remoteRef = `refs/remotes/${set.remote}/${set.base}`;
    const localBase = gitValue(viewed[0].row.topic.runtime.worktree, ['rev-parse', '--verify', `${remoteRef}^{commit}`]);
    if (!localBase || localBase !== baseOid) return fail(action, `local ${remoteRef} is missing or stale; fetch ${set.remote} ${set.base}`, { json });
    for (const { row } of viewed) {
      if (spawnSync('git', ['merge-base', '--is-ancestor', row.topic.runtime.base_sha, baseOid], { cwd: row.topic.runtime.worktree }).status !== 0) {
        const reason = `${row.topic.id}: base history was rewritten after verification`;
        invalidateSeal(manifest, reason);
        return fail(action, reason, { json });
      }
    }

    const candidate = {
      schema_version: 1, batch: batchId, sealed_at: now(),
      base: { remote: set.remote, ref: set.base, oid: baseOid, remote_tracking_ref: remoteRef },
      merge_order: set.order,
      prs: viewed.map(({ row, value }, index) => ({
        order: index + 1, topic: row.topic.id, plan_sha256: row.topic.plan.sha256,
        verification_binding_sha256: row.verification.binding_sha256, publication_binding_sha256: row.publication.binding_sha256,
        number: value.number, url: value.url, base_ref_name: value.baseRefName, base_ref_oid: value.baseRefOid,
        head_ref_name: value.headRefName, head_ref_oid: value.headRefOid, title: value.title, body_sha256: sha256(value.body),
      })),
    };
    candidate.binding_sha256 = digest(sealBindingPayload(candidate));
    const path = sealPath(batchId);
    const previous = readJSON(path);
    const reusable = previous?.binding_sha256 === candidate.binding_sha256
      && previous.binding_sha256 === digest(sealBindingPayload(previous));
    if (!reusable) {
      if (previous?.binding_sha256) atomicWrite(join(batchesRoot(), batchId, 'seal-history', previous.binding_sha256 + '.json'), JSON.stringify(previous, null, 2) + '\n');
      atomicWrite(path, JSON.stringify(candidate, null, 2) + '\n');
    }
    const sealed = reusable ? previous : candidate;
    manifest.status = 'sealed';
    manifest.seal = { receipt: path, binding_sha256: sealed.binding_sha256, sealed_at: sealed.sealed_at, base_ref: set.base, base_sha: baseOid, merge_order: set.order, valid: true };
    manifest.updated_at = now();
    writeJSON(manifestPath(batchId), manifest);
    return emit({ action, status: 'sealed', batch: batchId, reused: reusable, receipt: path, binding_sha256: sealed.binding_sha256, base: sealed.base, merge_order: sealed.merge_order, prs: sealed.prs }, json, `${batchId}: sealed ${sealed.prs.length} PR(s)`);
  } finally { releaseOperationLock(lock); }
}

function sealReceiptValid(manifest, seal) {
  const validStates = new Set(['sealed', 'integration_failed', 'integration_paused', 'integration_verified', 'merge_partial', 'merge_pending', 'merge_blocked', 'merged']);
  if (!seal || seal.schema_version !== 1 || seal.batch !== manifest.id
    || seal.binding_sha256 !== digest(sealBindingPayload(seal))
    || !validStates.has(manifest.status) || manifest.seal?.valid !== true
    || manifest.seal?.receipt !== sealPath(manifest.id)
    || manifest.seal?.binding_sha256 !== seal.binding_sha256) return false;
  if (!Array.isArray(seal.merge_order) || !Array.isArray(seal.prs) || seal.merge_order.length !== seal.prs.length) return false;
  return seal.prs.every((pr, index) => pr.order === index + 1 && pr.topic === seal.merge_order[index] && typeof pr.head_ref_oid === 'string');
}

function integrationBranch(manifest, seal) {
  return `xm/${toSlug(`batch-${manifest.id}-integration-${seal.binding_sha256.slice(0, 12)}`)}`;
}

function validationChecks(manifest, seal) {
  const rows = new Map();
  for (const topicId of seal.merge_order) {
    const topic = manifest.topics.find((row) => row.id === topicId);
    let plan;
    try { plan = normalizePlanEnvelope(JSON.parse(readFileSync(topic.plan.source, 'utf8'))); } catch { continue; }
    for (const command of plan.validation.commands || []) {
      const row = rows.get(command) || { command, topics: [], plan_sha256s: [] };
      row.topics.push(topicId);
      row.plan_sha256s.push(topic.plan.sha256);
      rows.set(command, row);
    }
  }
  return [...rows.values()];
}

function mergeExactHead(worktree, oid) {
  const command = publishCommand('X_BUILD_GK_ARGV', ['git-kit']);
  if (command.error) return { ok: false, error: { code: 'invalid_gk_argv', message: command.error }, recover: [] };
  const beforeHead = gitValue(worktree, ['rev-parse', 'HEAD']);
  const result = runPublishCommand(command, ['merge', oid, '--no-ai', '--no-ff', '--json'], worktree, { GK_AGENT: '1' });
  const afterHead = gitValue(worktree, ['rev-parse', 'HEAD']);
  const envelope = parseAgentEnvelope(result);
  const validEnvelope = envelope?.schema === 1 && ['ok', 'paused', 'blocked', 'error'].includes(envelope.state)
    && envelope.ok === (envelope.state === 'ok');
  if (!validEnvelope) {
    const recover = [
      { command: 'git-kit --version', safety: 'safe' },
      { command: 'GK_AGENT=1 git-kit context --include=diff,precheck', cwd: worktree, safety: 'safe' },
    ];
    return {
      ok: false, envelope: null, recover,
      error: {
        code: 'integration_merge_protocol_incompatible',
        message: 'git-kit merge returned no valid agent envelope; the Git outcome is unverified',
        exit_code: result.exit_code, before_head_oid: beforeHead, after_head_oid: afterHead,
        head_changed: beforeHead !== afterHead, producer_argv: command,
        stdout_tail: result.stdout.slice(-500), stderr_tail: result.stderr.slice(-500),
        next_action: 'Repair or update git-kit to emit merge agent envelopes, inspect the recorded worktree, then rerun xm batch verify. Do not reset an advanced HEAD or treat process exit 0 as merge approval.',
        remedies: recover,
      },
    };
  }
  if (result.ok && envelope.state === 'ok') return { ok: true, envelope };
  return {
    ok: false, envelope,
    error: envelope.error || { code: 'integration_merge_failed', message: result.stderr.trim() || 'git-kit merge failed', exit_code: result.exit_code },
    recover: envelope.result?.remedies || envelope.error?.remedies || [],
  };
}

function runIntegrationCheck(row, cwd) {
  const started = now();
  const result = spawnSync(row.command, [], { cwd, shell: true, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    ...row, started_at: started, completed_at: now(), passed: !result.error && result.status === 0, exit_code: result.status,
    timed_out: result.error?.code === 'ETIMEDOUT', output_sha256: sha256(output), output_tail: output.slice(-4000),
  };
}

function integrationBindingPayload(receipt) {
  return { seal: receipt.seal, base: receipt.base, prs: receipt.prs, integration: receipt.integration, merges: receipt.merges, checks: receipt.checks, review: receipt.review, status: receipt.status };
}

function integrationReceiptReusable(receipt, seal, worktree) {
  if (!receipt || receipt.status !== 'passed' || receipt.seal?.binding_sha256 !== seal.binding_sha256
    || receipt.binding_sha256 !== digest(integrationBindingPayload(receipt)) || !existsSync(worktree)) return false;
  return gitValue(worktree, ['rev-parse', 'HEAD']) === receipt.integration?.head_oid
    && gitValue(worktree, ['rev-parse', 'HEAD^{tree}']) === receipt.integration?.tree_oid
    && cleanPublishWorktree({ runtime: { worktree } }).ok;
}

function integrationResumePoint(worktree, seal, previous) {
  const current = gitValue(worktree, ['rev-parse', 'HEAD']);
  if (!current) return { ok: false, reason: 'integration HEAD is unavailable' };
  if (current === seal.base.oid || current === previous?.integration?.head_oid) return { ok: true, current };
  const failed = [...(previous?.merges || [])].reverse().find((row) => !row.ok);
  if (!failed?.before_head_oid || !failed.head_ref_oid) return { ok: false, reason: 'integration worktree HEAD is not a known resume point' };
  const parents = gitValue(worktree, ['show', '-s', '--format=%P', current])?.split(/\s+/).filter(Boolean) || [];
  const continued = parents.includes(failed.before_head_oid) && parents.includes(failed.head_ref_oid);
  return continued && cleanPublishWorktree({ runtime: { worktree } }).ok
    ? { ok: true, current, continued_topic: failed.topic }
    : { ok: false, reason: 'integration worktree HEAD is not the recorded conflict resolution' };
}

function saveIntegrationFailure(manifest, seal, branch, worktree, merges, checks, status, error, recover = []) {
  const receipt = {
    schema_version: 1, batch: manifest.id, verified_at: now(), seal: { receipt: sealPath(manifest.id), binding_sha256: seal.binding_sha256 },
    base: seal.base, prs: seal.prs.map((pr) => ({ topic: pr.topic, number: pr.number, head_ref_oid: pr.head_ref_oid, publication_binding_sha256: pr.publication_binding_sha256 })),
    integration: { branch, worktree: worktree || null, head_oid: worktree && existsSync(worktree) ? gitValue(worktree, ['rev-parse', 'HEAD']) : null, tree_oid: worktree && existsSync(worktree) ? gitValue(worktree, ['rev-parse', 'HEAD^{tree}']) : null },
    merges, checks, review: null, status, error, recover,
  };
  receipt.binding_sha256 = digest(integrationBindingPayload(receipt));
  atomicWrite(integrationReceiptPath(manifest.id), JSON.stringify(receipt, null, 2) + '\n');
  manifest.integration = { receipt: integrationReceiptPath(manifest.id), seal_binding_sha256: seal.binding_sha256, status, branch, worktree: worktree || null, recover, last_error: error };
  manifest.status = status === 'paused' ? 'integration_paused' : 'integration_failed';
  manifest.updated_at = now();
  writeJSON(manifestPath(manifest.id), manifest);
  return receipt;
}

function cmdVerify(args) {
  const action = 'batch.verify';
  const json = jsonRequested(args);
  const dryRun = args.includes('--dry-run');
  const positional = positionalArgs(args);
  if (positional.length !== 1) return fail(action, 'Usage: xm batch verify <id> [--dry-run] [--json]', { json });
  const [batchId] = positional;
  const idError = validateIdSegment(batchId, 'batch id');
  if (idError) return fail(action, idError, { json });

  const inspect = () => {
    const manifest = loadBatch(batchId, action, json);
    if (!manifest) return null;
    const seal = readJSON(sealPath(batchId));
    if (!sealReceiptValid(manifest, seal)) return fail(action, 'seal receipt is missing, stale, or invalid', { json });
    const plans = verifyPlanSources(manifest);
    if (plans.errors.length) return fail(action, plans.errors, { json });
    for (const pr of seal.prs) {
      const topic = manifest.topics.find((row) => row.id === pr.topic);
      const verification = readJSON(verificationPath(batchId, topic.id));
      const publication = readJSON(publicationPath(batchId, topic.id));
      if (!receiptBinding(topic, verification).valid || !publicationMatchesTopic(manifest, topic, publication, verification)
        || pr.verification_binding_sha256 !== verification.binding_sha256 || pr.publication_binding_sha256 !== publication.binding_sha256) {
        return fail(action, `${topic.id}: sealed receipt chain is stale`, { json });
      }
      if (!gitOk(topic.runtime.worktree, ['cat-file', '-e', `${pr.head_ref_oid}^{commit}`])) return fail(action, `${topic.id}: sealed head object is unavailable`, { json });
    }
    return { manifest, seal, branch: integrationBranch(manifest, seal), checks: validationChecks(manifest, seal) };
  };

  if (dryRun) {
    const state = inspect();
    if (!state?.manifest) return state;
    return emit({ action, status: 'dry-run', batch: batchId, branch: state.branch, base: state.seal.base, prs: state.seal.prs.map((pr) => ({ topic: pr.topic, head_ref_oid: pr.head_ref_oid })), checks: state.checks, review: { phase: 'release', task: '__integration__' } }, json, `${batchId}: integration verify dry-run`);
  }

  const lock = acquireOperationLock(batchId, action, json);
  if (!lock) return null;
  try {
    const state = inspect();
    if (!state?.manifest) return state;
    const previous = readJSON(integrationReceiptPath(batchId));
    const previousWorktree = previous?.integration?.worktree;
    if (integrationReceiptReusable(previous, state.seal, previousWorktree)) {
      state.manifest.status = 'integration_verified';
      state.manifest.integration = { receipt: integrationReceiptPath(batchId), seal_binding_sha256: state.seal.binding_sha256, binding_sha256: previous.binding_sha256, status: 'passed', branch: previous.integration.branch, worktree: previousWorktree, head_oid: previous.integration.head_oid, tree_oid: previous.integration.tree_oid, verified_at: previous.verified_at };
      writeJSON(manifestPath(batchId), state.manifest);
      return emit({ action, status: 'integration_verified', batch: batchId, reused: true, receipt: integrationReceiptPath(batchId), result: previous.integration }, json, `${batchId}: reused integration verification`);
    }

    let worktree = previous?.seal?.binding_sha256 === state.seal.binding_sha256 ? previousWorktree : null;
    if (!worktree || !existsSync(worktree)) {
      const acquired = acquireBatchWorktree(state.branch, state.seal.base.oid, process.cwd(), { noInit: true });
      if (!acquired.ok) {
        const receipt = saveIntegrationFailure(state.manifest, state.seal, state.branch, null, [], [], 'failed', acquired.error, acquired.recover);
        process.exitCode = 2;
        return emit({ action, status: 'integration_failed', batch: batchId, receipt: integrationReceiptPath(batchId), error: acquired.error, recover: acquired.recover, binding_sha256: receipt.binding_sha256 }, json, `${batchId}: integration acquire failed`);
      }
      worktree = acquired.path;
    }
    const resume = integrationResumePoint(worktree, state.seal, previous);
    if (!resume.ok) return fail(action, resume.reason, { json });

    const preflight = mergeExactHead(worktree, resume.current);
    if (!preflight.ok) {
      const paused = preflight.envelope?.state === 'paused';
      const receipt = saveIntegrationFailure(state.manifest, state.seal, state.branch, worktree,
        previous?.seal?.binding_sha256 === state.seal.binding_sha256 ? previous.merges || [] : [],
        [], paused ? 'paused' : 'failed', preflight.error, preflight.recover);
      process.exitCode = paused ? 3 : 2;
      return emit({ action, status: paused ? 'integration_paused' : 'integration_failed', batch: batchId,
        receipt: integrationReceiptPath(batchId), error: preflight.error, recover: preflight.recover,
        binding_sha256: receipt.binding_sha256 }, json, `${batchId}: integration merge contract check failed`);
    }

    const merges = [];
    const alreadyMerged = previous?.seal?.binding_sha256 === state.seal.binding_sha256 ? new Set((previous.merges || []).filter((row) => row.ok).map((row) => row.topic)) : new Set();
    if (resume.continued_topic) alreadyMerged.add(resume.continued_topic);
    for (const pr of state.seal.prs) {
      if (alreadyMerged.has(pr.topic)) {
        const saved = previous?.merges?.find((row) => row.topic === pr.topic);
        merges.push(saved?.ok ? saved : { ...saved, ok: true, resumed: true, result_head_oid: resume.current, result_tree_oid: gitValue(worktree, ['rev-parse', 'HEAD^{tree}']) });
        continue;
      }
      const beforeHead = gitValue(worktree, ['rev-parse', 'HEAD']);
      const merged = mergeExactHead(worktree, pr.head_ref_oid);
      const row = { topic: pr.topic, head_ref_oid: pr.head_ref_oid, strategy: 'merge_commit_no_ff', before_head_oid: beforeHead, ok: merged.ok, result_head_oid: gitValue(worktree, ['rev-parse', 'HEAD']), result_tree_oid: gitValue(worktree, ['rev-parse', 'HEAD^{tree}']) };
      merges.push(row);
      if (!merged.ok) {
        const paused = merged.envelope?.state === 'paused';
        const receipt = saveIntegrationFailure(state.manifest, state.seal, state.branch, worktree, merges, [], paused ? 'paused' : 'failed', merged.error, merged.recover);
        process.exitCode = paused ? 3 : 2;
        return emit({ action, status: paused ? 'integration_paused' : 'integration_failed', batch: batchId, receipt: integrationReceiptPath(batchId), error: merged.error, recover: merged.recover, binding_sha256: receipt.binding_sha256 }, json, `${batchId}: integration merge failed`);
      }
    }
    const cleanAfterMerge = cleanPublishWorktree({ runtime: { worktree } });
    if (!cleanAfterMerge.ok) {
      const error = { code: 'integration_worktree_dirty', message: cleanAfterMerge.reason };
      saveIntegrationFailure(state.manifest, state.seal, state.branch, worktree, merges, [], 'failed', error);
      process.exitCode = 2;
      return emit({ action, status: 'integration_failed', batch: batchId, error }, json, `${batchId}: integration worktree is dirty`);
    }

    const checks = [];
    for (const row of state.checks) {
      const result = runIntegrationCheck(row, worktree);
      checks.push(result);
      if (!result.passed) {
        const error = { code: 'integration_check_failed', message: `integration command failed: ${row.command}` };
        const receipt = saveIntegrationFailure(state.manifest, state.seal, state.branch, worktree, merges, checks, 'failed', error);
        process.exitCode = 2;
        return emit({ action, status: 'integration_failed', batch: batchId, receipt: integrationReceiptPath(batchId), error, binding_sha256: receipt.binding_sha256 }, json, `${batchId}: integration checks failed`);
      }
    }
    const cleanAfterChecks = cleanPublishWorktree({ runtime: { worktree } });
    if (!cleanAfterChecks.ok) {
      const error = { code: 'integration_checks_changed_worktree', message: cleanAfterChecks.reason };
      saveIntegrationFailure(state.manifest, state.seal, state.branch, worktree, merges, checks, 'failed', error);
      process.exitCode = 2;
      return emit({ action, status: 'integration_failed', batch: batchId, error }, json, `${batchId}: integration checks changed the worktree`);
    }

    const diffCommand = publishCommand('X_BUILD_GK_ARGV', ['git-kit']);
    const diffResult = runPublishCommand(diffCommand, ['diff', '--raw-patch', '--json', state.seal.base.oid, 'HEAD'], worktree, { GK_AGENT: '1' });
    let diffEnvelope = null;
    try { diffEnvelope = JSON.parse(diffResult.stdout.trim()); } catch {}
    if (!diffResult.ok || diffEnvelope?.state !== 'ok' || typeof diffEnvelope?.result?.patch !== 'string') {
      const error = { code: 'integration_diff_failed', message: 'cannot create integration patch' };
      saveIntegrationFailure(state.manifest, state.seal, state.branch, worktree, merges, checks, 'failed', error);
      process.exitCode = 2;
      return emit({ action, status: 'integration_failed', batch: batchId, error }, json, `${batchId}: integration diff failed`);
    }
    const patchPath = join(integrationRoot(batchId), 'integration.diff');
    atomicWrite(patchPath, diffEnvelope.result.patch);
    const project = projectFor(batchId, 'integration');
    const syntheticTasks = join(buildRoot(), 'projects', project, 'phases', '02-plan', 'tasks.json');
    writeJSON(syntheticTasks, { tasks: [{ id: '__integration__', size: 'medium', gate_policy: null }] });
    const gate = runGatePanel({ project, taskId: '__integration__', phase: 'release', patch: patchPath, cwd: worktree });
    if (gate.exitCode !== 0) {
      const error = { code: gate.exitCode === 1 ? 'integration_review_failed' : 'integration_review_error', message: `integration review ${gate.result.decision}` };
      const receipt = saveIntegrationFailure(state.manifest, state.seal, state.branch, worktree, merges, checks, 'failed', error);
      receipt.review = { decision: gate.result.decision, artifact: gate.artifactPath, patch_sha256: sha256(diffEnvelope.result.patch) };
      receipt.binding_sha256 = digest(integrationBindingPayload(receipt));
      atomicWrite(integrationReceiptPath(batchId), JSON.stringify(receipt, null, 2) + '\n');
      process.exitCode = 2;
      return emit({ action, status: 'integration_failed', batch: batchId, error, receipt: integrationReceiptPath(batchId) }, json, `${batchId}: integration review failed`);
    }

    const integration = { branch: state.branch, worktree, head_oid: gitValue(worktree, ['rev-parse', 'HEAD']), tree_oid: gitValue(worktree, ['rev-parse', 'HEAD^{tree}']) };
    const receipt = {
      schema_version: 1, batch: batchId, verified_at: now(), seal: { receipt: sealPath(batchId), binding_sha256: state.seal.binding_sha256 },
      base: state.seal.base, prs: state.seal.prs.map((pr) => ({ topic: pr.topic, number: pr.number, head_ref_oid: pr.head_ref_oid, publication_binding_sha256: pr.publication_binding_sha256 })),
      integration, merges, checks, review: { decision: gate.result.decision, artifact: gate.artifactPath, patch_sha256: sha256(diffEnvelope.result.patch) }, status: 'passed', error: null, recover: [],
    };
    receipt.binding_sha256 = digest(integrationBindingPayload(receipt));
    atomicWrite(integrationReceiptPath(batchId), JSON.stringify(receipt, null, 2) + '\n');
    state.manifest.status = 'integration_verified';
    state.manifest.integration = { receipt: integrationReceiptPath(batchId), seal_binding_sha256: state.seal.binding_sha256, binding_sha256: receipt.binding_sha256, status: 'passed', ...integration, verified_at: receipt.verified_at };
    state.manifest.updated_at = now();
    writeJSON(manifestPath(batchId), state.manifest);
    return emit({ action, status: 'integration_verified', batch: batchId, reused: false, receipt: integrationReceiptPath(batchId), binding_sha256: receipt.binding_sha256, result: integration, checks, review: receipt.review }, json, `${batchId}: integration verified`);
  } finally { releaseOperationLock(lock); }
}

function mergeBindingPayload(receipt) {
  return { seal: receipt.seal, integration: receipt.integration, strategy: receipt.strategy, base_start: receipt.base_start, rows: receipt.rows, status: receipt.status, final: receipt.final || null };
}

function ghBase(command, base, cwd) {
  const result = runPublishCommand(command, ['api', `repos/{owner}/{repo}/commits/${encodeURIComponent(base)}`], cwd);
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch {}
  const valid = result.ok && typeof value?.sha === 'string' && typeof value?.commit?.tree?.sha === 'string';
  return { ...result, value, valid };
}

function ghMergeView(command, number, cwd) {
  const result = runPublishCommand(command, ['pr', 'view', String(number), '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,autoMergeRequest,mergeCommit,mergedAt'], cwd);
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch {}
  return withBaseRefOid(command, { ...result, value }, cwd);
}

function mergeReceiptValid(receipt, seal, integration) {
  if (!receipt || receipt.schema_version !== 1 || receipt.seal?.binding_sha256 !== seal.binding_sha256
    || receipt.integration?.binding_sha256 !== integration.binding_sha256
    || receipt.strategy !== 'merge_commit_no_ff' || digest(receipt.base_start) !== digest(seal.base)
    || receipt.binding_sha256 !== digest(mergeBindingPayload(receipt)) || !Array.isArray(receipt.rows)) return false;
  if (receipt.rows.length > seal.prs.length) return false;
  return receipt.rows.every((row, index) => {
    const expectedBefore = index === 0 ? seal.base.oid : receipt.rows[index - 1].after_base_oid;
    const statusValid = row.status === 'merged' || (row.status === 'pending' && index === receipt.rows.length - 1);
    return row.order === index + 1 && row.topic === seal.prs[index].topic
      && row.number === seal.prs[index].number && row.sealed_head_oid === seal.prs[index].head_ref_oid
      && row.before_base_oid === expectedBefore && row.expected_tree_oid === integration.merges[index]?.result_tree_oid
      && statusValid;
  });
}

function saveMergeReceipt(manifest, seal, integration, baseStart, rows, status, final = null, error = null) {
  const receipt = {
    schema_version: 1, batch: manifest.id, updated_at: now(),
    seal: { receipt: sealPath(manifest.id), binding_sha256: seal.binding_sha256 },
    integration: { receipt: integrationReceiptPath(manifest.id), binding_sha256: integration.binding_sha256, tree_oid: integration.integration.tree_oid },
    strategy: 'merge_commit_no_ff', base_start: baseStart, rows, status, final, error,
  };
  receipt.binding_sha256 = digest(mergeBindingPayload(receipt));
  atomicWrite(mergeReceiptPath(manifest.id), JSON.stringify(receipt, null, 2) + '\n');
  manifest.status = status === 'merged' ? 'merged' : status === 'pending' ? 'merge_pending' : rows.some((row) => row.status === 'merged') ? 'merge_partial' : 'merge_blocked';
  manifest.merge = { receipt: mergeReceiptPath(manifest.id), seal_binding_sha256: seal.binding_sha256, integration_binding_sha256: integration.binding_sha256, binding_sha256: receipt.binding_sha256, status, updated_at: receipt.updated_at, error };
  if (status === 'merged') for (const topic of manifest.topics) topic.status = 'merged';
  manifest.updated_at = receipt.updated_at;
  writeJSON(manifestPath(manifest.id), manifest);
  return receipt;
}

function currentMergePrValid(value, sealed, expectedBase) {
  return value?.number === sealed.number && value?.url === sealed.url && value?.baseRefName === sealed.base_ref_name
    && value?.headRefName === sealed.head_ref_name && value?.headRefOid === sealed.head_ref_oid
    && value?.isDraft === false && (value.state === 'MERGED' || value?.baseRefOid === expectedBase);
}

function mergeDryRunPlan(manifest, seal, integration) {
  return seal.prs.map((pr, index) => ({
    order: index + 1, topic: pr.topic, number: pr.number, sealed_head_oid: pr.head_ref_oid, expected_tree_oid: integration.merges[index]?.result_tree_oid,
    argv: ['gh', 'pr', 'merge', String(pr.number), '--merge', '--match-head-commit', pr.head_ref_oid],
  }));
}

function cmdMerge(args) {
  const action = 'batch.merge';
  const json = jsonRequested(args);
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  if (dryRun && yes) return fail(action, '--dry-run and --yes cannot be combined', { json });
  const positional = positionalArgs(args);
  if (positional.length !== 1) return fail(action, 'Usage: xm batch merge <id> [--dry-run|--yes] [--json]', { json });
  const [batchId] = positional;
  const idError = validateIdSegment(batchId, 'batch id');
  if (idError) return fail(action, idError, { json });
  const gh = publishCommand('X_BUILD_GH_ARGV', ['gh']);
  if (gh.error) return fail(action, gh.error, { json });

  const inspect = () => {
    const manifest = loadBatch(batchId, action, json);
    if (!manifest) return null;
    const seal = readJSON(sealPath(batchId));
    const integration = readJSON(integrationReceiptPath(batchId));
    const integrationPrsMatch = integration?.prs?.length === seal?.prs?.length
      && integration.prs.every((pr, index) => pr.topic === seal.prs[index]?.topic
        && pr.number === seal.prs[index]?.number && pr.head_ref_oid === seal.prs[index]?.head_ref_oid
        && pr.publication_binding_sha256 === seal.prs[index]?.publication_binding_sha256);
    const integrationMergesMatch = integration?.merges?.length === seal?.prs?.length
      && integration.merges.every((row, index) => {
        const expectedBefore = index === 0 ? seal.base.oid : integration.merges[index - 1]?.result_head_oid;
        return row.ok && row.strategy === 'merge_commit_no_ff' && row.topic === seal.prs[index]?.topic
          && row.head_ref_oid === seal.prs[index]?.head_ref_oid && row.before_head_oid === expectedBefore
          && typeof row.result_head_oid === 'string' && typeof row.result_tree_oid === 'string';
      });
    if (!sealReceiptValid(manifest, seal) || integration?.status !== 'passed'
      || integration.binding_sha256 !== digest(integrationBindingPayload(integration))
      || integration.seal?.binding_sha256 !== seal.binding_sha256
      || digest(integration.base) !== digest(seal.base) || !integrationPrsMatch || !integrationMergesMatch
      || manifest.integration?.receipt !== integrationReceiptPath(batchId)
      || manifest.integration?.seal_binding_sha256 !== seal.binding_sha256
      || manifest.integration?.binding_sha256 !== integration.binding_sha256 || manifest.integration?.status !== 'passed'
      || manifest.integration?.head_oid !== integration.integration?.head_oid || manifest.integration?.tree_oid !== integration.integration?.tree_oid
      || integration.integration?.head_oid !== integration.merges?.at(-1)?.result_head_oid
      || integration.integration?.tree_oid !== integration.merges?.at(-1)?.result_tree_oid) {
      return fail(action, 'integration receipt is missing, stale, or incompatible with merge strategy', { json });
    }
    const plans = verifyPlanSources(manifest);
    if (plans.errors.length) return fail(action, plans.errors, { json });
    for (const pr of seal.prs) {
      const topic = manifest.topics.find((row) => row.id === pr.topic);
      const verification = readJSON(verificationPath(batchId, topic.id));
      const publication = readJSON(publicationPath(batchId, topic.id));
      if (!receiptBinding(topic, verification).valid || !publicationMatchesTopic(manifest, topic, publication, verification)
        || pr.verification_binding_sha256 !== verification.binding_sha256 || pr.publication_binding_sha256 !== publication.binding_sha256) {
        return fail(action, `${topic.id}: merge receipt chain is stale`, { json });
      }
    }
    return { manifest, seal, integration, plan: mergeDryRunPlan(manifest, seal, integration) };
  };

  if (!yes) {
    const state = inspect();
    if (!state?.manifest) return state;
    const output = { action, status: dryRun ? 'dry-run' : 'awaiting_confirmation', batch: batchId, base: state.seal.base, integration_tree_oid: state.integration.integration.tree_oid, topics: state.plan };
    if (!dryRun) process.exitCode = 2;
    return emit(output, json, `${batchId}: ${output.status}`);
  }

  const lock = acquireOperationLock(batchId, action, json);
  if (!lock) return null;
  try {
    const state = inspect();
    if (!state?.manifest) return state;
    const cwd = state.manifest.topics[0].runtime.worktree;
    const previous = readJSON(mergeReceiptPath(batchId));
    if (previous && !mergeReceiptValid(previous, state.seal, state.integration)) return fail(action, 'merge receipt is stale or invalid', { json });
    const rows = [...(previous?.rows || []).filter((row) => row.status === 'merged')];
    const pending = previous?.rows?.find((row) => row.status === 'pending');
    let expectedBase = rows.at(-1)?.after_base_oid || state.seal.base.oid;
    let remoteBase = ghBase(gh, state.seal.base.ref, cwd);
    if (!remoteBase.valid) return fail(action, 'cannot read current GitHub base commit', { json, code: 1 });
    if (remoteBase.value.sha !== expectedBase && !pending) return fail(action, `remote base moved: expected ${expectedBase}, got ${remoteBase.value.sha}`, { json });

    if (previous?.status === 'merged' && remoteBase.value.sha === previous.final?.commit_oid
      && remoteBase.value.commit.tree.sha === previous.final?.tree_oid && previous.final.tree_oid === state.integration.integration.tree_oid) {
      return emit({ action, status: 'merged', batch: batchId, reused: true, receipt: mergeReceiptPath(batchId), final: previous.final }, json, `${batchId}: merge already complete`);
    }
    if (pending) {
      const sealed = state.seal.prs[rows.length];
      if (!sealed || pending.order !== rows.length + 1 || pending.number !== sealed.number || pending.sealed_head_oid !== sealed.head_ref_oid) {
        return fail(action, 'pending merge row does not match the sealed PR order', { json });
      }
      const viewed = ghMergeView(gh, sealed.number, cwd);
      if (!viewed.ok || !viewed.value) return fail(action, `${sealed.topic}: cannot read GitHub PR${ghStderr(viewed)}`, { json, code: 1 });
      if (!currentMergePrValid(viewed.value, sealed, expectedBase)) return fail(action, `${sealed.topic}: pending PR state changed`, { json });
      if (viewed.value.state !== 'MERGED' || !viewed.value.mergedAt || !viewed.value.mergeCommit?.oid) {
        return emit({ action, status: 'merge_pending', batch: batchId, reused: true, receipt: mergeReceiptPath(batchId), row: pending }, json, `${batchId}: merge still pending`);
      }
      remoteBase = ghBase(gh, state.seal.base.ref, cwd);
      const expectedTree = state.integration.merges[rows.length].result_tree_oid;
      if (!remoteBase.valid || remoteBase.value.sha !== viewed.value.mergeCommit.oid || remoteBase.value.commit.tree.sha !== expectedTree) {
        return fail(action, `${sealed.topic}: pending merge completed with an unexpected tree`, { json });
      }
      rows.push({ ...pending, after_base_oid: remoteBase.value.sha, actual_tree_oid: remoteBase.value.commit.tree.sha, status: 'merged', resumed_at: now() });
      expectedBase = remoteBase.value.sha;
      saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'partial');
    }

    for (let index = rows.length; index < state.seal.prs.length; index += 1) {
      const sealed = state.seal.prs[index];
      const expectedTree = state.integration.merges[index].result_tree_oid;
      let viewed = ghMergeView(gh, sealed.number, cwd);
      if (!viewed.ok || !viewed.value || !currentMergePrValid(viewed.value, sealed, expectedBase)) {
        const error = !viewed.ok || !viewed.value
          ? { code: 'pr_view_failed', message: `${sealed.topic}: cannot read GitHub PR${ghStderr(viewed)}` }
          : { code: 'pr_merge_precondition_failed', message: `${sealed.topic}: current PR does not match sealed state` };
        saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'blocked', null, error);
        process.exitCode = 2;
        return emit({ action, status: 'merge_blocked', batch: batchId, error, rows }, json, `${batchId}: merge precondition failed`);
      }
      if (viewed.value.state === 'MERGED') {
        remoteBase = ghBase(gh, state.seal.base.ref, cwd);
      } else {
        if (viewed.value.state !== 'OPEN' || viewed.value.mergeable !== 'MERGEABLE' || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(viewed.value.mergeStateStatus)) {
          const error = { code: 'pr_not_mergeable', message: `${sealed.topic}: PR is not immediately mergeable` };
          saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'blocked', null, error);
          process.exitCode = 2;
          return emit({ action, status: 'merge_blocked', batch: batchId, error, rows }, json, `${batchId}: PR not mergeable`);
        }
        const merged = runPublishCommand(gh, ['pr', 'merge', String(sealed.number), '--merge', '--match-head-commit', sealed.head_ref_oid], cwd);
        viewed = ghMergeView(gh, sealed.number, cwd);
        if (!viewed.ok || !viewed.value) {
          const error = { code: 'pr_merge_status_unknown', message: `${sealed.topic}: merge result cannot be confirmed${ghStderr(viewed)}` };
          saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'blocked', null, error);
          process.exitCode = 2;
          return emit({ action, status: 'merge_blocked', batch: batchId, error, rows }, json, `${batchId}: merge status unknown`);
        }
        if (viewed.value.state !== 'MERGED' || !viewed.value.mergedAt || !viewed.value.mergeCommit?.oid) {
          if (!merged.ok) {
            const error = { code: 'pr_merge_failed', message: `${sealed.topic}: gh pr merge failed and the PR remains open` };
            saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'blocked', null, error);
            process.exitCode = 2;
            return emit({ action, status: 'merge_blocked', batch: batchId, error, rows }, json, `${batchId}: merge failed`);
          }
          const row = { order: index + 1, topic: sealed.topic, number: sealed.number, sealed_head_oid: sealed.head_ref_oid, before_base_oid: expectedBase, expected_tree_oid: expectedTree, status: 'pending', merge_exit_code: merged.exit_code };
          const receipt = saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, [...rows, row], 'pending');
          process.exitCode = 2;
          return emit({ action, status: 'merge_pending', batch: batchId, receipt: mergeReceiptPath(batchId), row, binding_sha256: receipt.binding_sha256 }, json, `${batchId}: merge pending`);
        }
        remoteBase = ghBase(gh, state.seal.base.ref, cwd);
      }
      if (!remoteBase.valid || remoteBase.value.sha !== viewed.value.mergeCommit?.oid || remoteBase.value.commit.tree.sha !== expectedTree) {
        const error = { code: 'merged_tree_mismatch', message: `${sealed.topic}: merged base does not match verified integration tree` };
        saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'blocked', null, error);
        process.exitCode = 2;
        return emit({ action, status: rows.length ? 'merge_partial' : 'merge_blocked', batch: batchId, error, rows }, json, `${batchId}: merged tree mismatch`);
      }
      const row = { order: index + 1, topic: sealed.topic, number: sealed.number, sealed_head_oid: sealed.head_ref_oid, before_base_oid: expectedBase, after_base_oid: remoteBase.value.sha, expected_tree_oid: expectedTree, actual_tree_oid: remoteBase.value.commit.tree.sha, status: 'merged' };
      rows.push(row);
      expectedBase = row.after_base_oid;
      saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'partial');
    }
    remoteBase = ghBase(gh, state.seal.base.ref, cwd);
    if (!remoteBase.valid || remoteBase.value.sha !== expectedBase || remoteBase.value.commit.tree.sha !== state.integration.integration.tree_oid) {
      const error = { code: 'final_tree_mismatch', message: 'final base tree does not match verified integration tree' };
      saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'blocked', null, error);
      process.exitCode = 2;
      return emit({ action, status: 'merge_partial', batch: batchId, error, rows }, json, `${batchId}: final tree mismatch`);
    }
    const final = { commit_oid: remoteBase.value.sha, tree_oid: remoteBase.value.commit.tree.sha, merged_at: now() };
    const receipt = saveMergeReceipt(state.manifest, state.seal, state.integration, state.seal.base, rows, 'merged', final);
    return emit({ action, status: 'merged', batch: batchId, reused: false, receipt: mergeReceiptPath(batchId), binding_sha256: receipt.binding_sha256, rows, final }, json, `${batchId}: merged ${rows.length} PR(s)`);
  } finally { releaseOperationLock(lock); }
}

function cmdInit(args) {
  const action = 'batch.init';
  const json = jsonRequested(args);
  const [id] = positionalArgs(args);
  const idError = validateIdSegment(id, 'batch id');
  if (idError) return fail(action, idError, { json });
  const path = manifestPath(id);
  if (existsSync(path)) return fail(action, `batch already exists: ${id}`, { json });
  const createdAt = now();
  const manifest = { schema_version: 1, id, status: 'collecting', created_at: createdAt, updated_at: createdAt, topics: [], schedule: null };
  writeJSON(path, manifest);
  return emit({ action, status: 'created', batch: id, manifest: path }, json, `✅ Created batch ${id}`);
}

async function cmdAdd(args) {
  const action = 'batch.add';
  const json = jsonRequested(args);
  const positional = positionalArgs(args, ['--plan', '--depends-on']);
  const [batchId, topicId] = positional;
  const idError = validateIdSegment(batchId, 'batch id') || validateIdSegment(topicId, 'topic id');
  if (idError) return fail(action, idError, { json });
  const manifest = loadBatch(batchId, action, json);
  if (!manifest) return null;
  if (manifest.topics.some((topic) => topic.id === topicId)) return fail(action, `topic already exists: ${topicId}`, { json });

  const dependencies = parseDependencies(args);
  const dependencyError = dependencies.map((id) => validateIdSegment(id, 'dependency id')).find(Boolean);
  if (dependencyError) return fail(action, dependencyError, { json });
  if (dependencies.includes(topicId)) return fail(action, `topic cannot depend on itself: ${topicId}`, { json });

  const planOption = option(args, '--plan');
  if (!planOption) return fail(action, '--plan is required', { json });
  const source = resolve(planOption);
  let raw;
  try { raw = readFileSync(source, 'utf8'); } catch (error) { return fail(action, `cannot read plan: ${error.message}`, { json, code: 1 }); }
  const core = await loadPlanCore();
  if (!core?.parsePlanEnvelope) return fail(action, 'x-plan validator is unavailable', { json, code: 1 });
  const checked = core.parsePlanEnvelope(raw);
  if (!checked.valid) return fail(action, checked.errors.map((error) => `${error.path}: ${error.message}`), { json });
  const plan = checked.value;
  if (!plan.executable || plan.status !== 'complete') return fail(action, 'plan must be complete and executable', { json });

  const scope = collectTopicExpectedFiles(plan);
  const addedAt = now();
  manifest.topics.push({
    id: topicId, status: 'pending', goal: plan.goal, depends_on: dependencies,
    ...scope, plan: { source, sha256: createHash('sha256').update(raw).digest('hex'), normalized_sha256: digest(plan) }, added_at: addedAt,
  });
  manifest.status = 'collecting';
  manifest.schedule = null;
  manifest.updated_at = addedAt;
  writeJSON(manifestPath(batchId), manifest);
  return emit({ action, status: 'added', batch: batchId, topic: topicId, expected_files_complete: scope.expected_files_complete }, json, `✅ Added topic ${topicId} to ${batchId}`);
}

function cmdPlan(args) {
  const action = 'batch.plan';
  const json = jsonRequested(args);
  const [batchId] = positionalArgs(args, ['--max-parallel']);
  const idError = validateIdSegment(batchId, 'batch id');
  if (idError) return fail(action, idError, { json });
  const manifest = loadBatch(batchId, action, json);
  if (!manifest) return null;
  if (!manifest.topics.length) return fail(action, 'batch has no topics', { json });
  const rawMax = option(args, '--max-parallel');
  const maxParallel = rawMax == null ? 4 : Number(rawMax);
  const schedule = compileBatchSchedule(manifest.topics, { maxParallel });
  if (schedule.errors) return fail(action, schedule.errors, { json });
  schedule.planned_at = now();
  manifest.status = 'planned';
  manifest.schedule = schedule;
  manifest.updated_at = schedule.planned_at;
  writeJSON(manifestPath(batchId), manifest);
  return emit({ action, status: 'planned', batch: batchId, schedule }, json, `✅ Planned ${schedule.waves.length} wave(s) for ${batchId}`);
}

function cmdStatus(args) {
  const action = 'batch.status';
  const json = jsonRequested(args);
  const [batchId] = positionalArgs(args);
  const idError = validateIdSegment(batchId, 'batch id');
  if (idError) return fail(action, idError, { json });
  const manifest = loadBatch(batchId, action, json);
  if (!manifest) return null;
  const topicStatuses = {};
  for (const topic of manifest.topics) topicStatuses[topic.status] = (topicStatuses[topic.status] || 0) + 1;
  const output = {
    action, status: manifest.status, batch: batchId, topic_count: manifest.topics.length, topic_statuses: topicStatuses, topics: manifest.topics, schedule: manifest.schedule,
    execution: manifest.execution || null, seal: manifest.seal || null, integration: manifest.integration || null, merge: manifest.merge || null,
  };
  return emit(output, json, `${batchId}: ${manifest.status} (${manifest.topics.length} topics)`);
}

function storedBatches() {
  const root = batchesRoot();
  if (!existsSync(root)) return [];
  const rows = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith('.') || !existsSync(manifestPath(name))) continue;
    const manifest = readJSON(manifestPath(name));
    rows.push({ name, path: manifestPath(name), manifest: Array.isArray(manifest?.topics) ? manifest : null });
  }
  return rows;
}

function cmdList(args) {
  const action = 'batch.list';
  const json = jsonRequested(args);
  const batches = storedBatches().map(({ name, path, manifest }) => {
    if (!manifest) return { id: name, status: 'unreadable', active: false, manifest: path, error: 'manifest is unreadable' };
    const topicStatuses = {};
    for (const topic of manifest.topics) topicStatuses[topic.status] = (topicStatuses[topic.status] || 0) + 1;
    return {
      id: manifest.id || name, status: manifest.status, active: manifest.status !== 'merged',
      topic_count: manifest.topics.length, topic_statuses: topicStatuses, updated_at: manifest.updated_at || null, manifest: path,
    };
  }).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const lines = batches.map((row) => `${row.id}  ${row.status}${row.topic_count == null ? '' : `  ${row.topic_count} topic(s)`}${row.updated_at ? `  ${row.updated_at}` : ''}`);
  return emit({ action, status: 'ok', batches }, json, lines.length ? lines.join('\n') : 'No batches.');
}

async function cmdCandidates(args) {
  const action = 'batch.candidates';
  const json = jsonRequested(args);
  const core = await loadPlanCore();
  if (!core?.parsePlanEnvelope) return fail(action, 'x-plan validator is unavailable', { json, code: 1 });

  const registeredPaths = new Set();
  const registeredDigests = new Set();
  const warnings = [];
  for (const { name, manifest } of storedBatches()) {
    if (!manifest) { warnings.push(`${name}: manifest is unreadable; plans it registered may be listed`); continue; }
    for (const topic of manifest.topics) {
      if (topic.plan?.source) registeredPaths.add(resolve(topic.plan.source));
      if (topic.plan?.sha256) registeredDigests.add(topic.plan.sha256);
    }
  }

  const candidates = [];
  const excluded = { missing_envelope: 0, invalid: 0, incomplete: 0, not_executable: 0, registered: 0 };
  for (const [name, path] of artifactEntries()) {
    if (!existsSync(path)) { excluded.missing_envelope += 1; continue; }
    const raw = readFileSync(path, 'utf8');
    const checked = core.parsePlanEnvelope(raw);
    if (!checked.valid) { excluded.invalid += 1; continue; }
    const plan = checked.value;
    if (plan.status !== 'complete') { excluded.incomplete += 1; continue; }
    if (plan.executable !== true) { excluded.not_executable += 1; continue; }
    const source = resolve(path);
    const planSha = sha256(raw);
    if (registeredPaths.has(source) || registeredDigests.has(planSha)) { excluded.registered += 1; continue; }
    candidates.push({
      name, path: source, goal: plan.goal, created_at: plan.provenance?.created_at || null,
      task_count: plan.tasks.length, ...collectTopicExpectedFiles(plan), sha256: planSha,
    });
  }
  candidates.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.name.localeCompare(a.name));

  const skipped = Object.entries(excluded).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count}`);
  const lines = candidates.map((row, index) => `${index + 1}. ${row.goal}  (${row.task_count} task(s), ${row.created_at || 'date unknown'})\n   ${row.path}`);
  if (!lines.length) lines.push(`No executable plans under ${planArtifactsDir()}.`);
  if (skipped.length) lines.push(`Excluded: ${skipped.join(', ')}`);
  for (const warning of warnings) lines.push(`⚠ ${warning}`);
  return emit({ action, status: 'ok', plan_root: planArtifactsDir(), candidates, excluded, warnings }, json, lines.join('\n'));
}

export async function cmdBatch(args = []) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'init') return cmdInit(rest);
  if (subcommand === 'add') return cmdAdd(rest);
  if (subcommand === 'plan') return cmdPlan(rest);
  if (subcommand === 'status') return cmdStatus(rest);
  if (subcommand === 'list') return cmdList(rest);
  if (subcommand === 'candidates') return cmdCandidates(rest);
  if (subcommand === 'run') return cmdRun(rest);
  if (subcommand === 'resume') return cmdResume(rest);
  if (subcommand === 'approve') return cmdApprove(rest);
  if (subcommand === 'collect') return cmdCollect(rest);
  if (subcommand === 'publish') return cmdPublish(rest);
  if (subcommand === 'seal') return cmdSeal(rest);
  if (subcommand === 'verify') return cmdVerify(rest);
  if (subcommand === 'merge') return cmdMerge(rest);
  return fail('batch', 'Usage: xm batch <init|add|plan|run|resume|approve|collect|publish|seal|verify|merge|status|list|candidates> ...', { json: jsonRequested(args) });
}
