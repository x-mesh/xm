import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export function readState(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}
export function gitValue(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
export function reviewRoot(options = {}) {
  const cwd = gitValue(resolve(options.cwd || process.cwd()), ['rev-parse', '--show-toplevel']);
  const root = resolve(options.xmRoot || options.env?.XM_REVIEW_ROOT || process.env.XM_REVIEW_ROOT || join(cwd, '.xm'));
  if (realpathSync(dirname(root)) !== realpathSync(cwd) || root.split('/').at(-1) !== '.xm') throw new Error('review state must stay inside this worktree at .xm');
  for (const path of [root, join(root, 'review')]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('review state cannot use a symlink');
  return { cwd, root: join(root, 'review') };
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// A review fan-out runs for minutes, so Ctrl-C and crashes are routine: without
// reclaim the leftover directory blocks even the commands that exist to recover.
function acquireLock(lock) {
  try { mkdirSync(lock); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let owner = null;
  try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch {}
  // An ownerless lock is either a process between mkdir and owner write, or an
  // orphan from a version that never wrote owner.json; only the latter ages out.
  if (owner ? processAlive(owner.pid) : Date.now() - lstatSync(lock).mtimeMs < 5000) {
    throw new Error('worktree review is locked; recover the owning process before removing lifecycle.lock');
  }
  rmSync(lock, { recursive: true, force: true });
  try { mkdirSync(lock); } catch { throw new Error('worktree review is locked; recover the owning process before removing lifecycle.lock'); }
}
export async function withReviewLock(options, action) {
  const location = reviewRoot(options);
  mkdirSync(location.root, { recursive: true });
  const lock = join(location.root, 'lifecycle.lock');
  acquireLock(lock);
  atomicJson(join(lock, 'owner.json'), { pid: process.pid, cwd: location.cwd, started_at: new Date().toISOString() });
  try { return await action(location); } finally { rmSync(lock, { recursive: true }); }
}
// budget.json is the only record of what a task has spent, and .xm is gitignored,
// so a deleted file used to reset every counter in silence. Terminal receipts carry
// the task each run was charged to; if any survive, the missing state is a loss to
// repair, not a fresh worktree.
//
// Every lifecycle command loads the budget, close and associate included, so this
// refusal has no in-tool recovery: restoring the file is the only way out. That is
// deliberate — a recovery command here would be the reset it exists to prevent.
//
// Scope, precisely: this catches a deleted budget.json when a completed run's
// receipt survives. It is not a general integrity check, and three resets still
// pass it, all because budget.json is trusted as its own source of truth:
//   - a file rewritten to {"schema":1,"tasks":{},"aliases":{},"active":null}
//     never reaches this branch and mints fresh budgets from the schema check;
//   - a hand-emptied approvals[] restores the exception allowance, since only
//     Array.isArray() is verified below;
//   - a reset that leaves an in-flight run behind is invisible, because a run
//     with no terminal.json, or a corrupt one, is dropped by the catch above.
// Closing these means reconstructing usage from the receipts rather than reading
// it from budget.json. Until then, treat this as a guard against an accidental
// delete, not against a determined one.
export function orphanedReceipts(root) {
  const runs = join(root, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    try { return readState(join(runs, entry.name, 'terminal.json')).task_budget_id || null; } catch { return null; }
  }).filter(Boolean);
}
function withLegacyTasksView(state) {
  // x-build consumers from schema v1 read `.tasks`. Keep that in-memory view
  // non-enumerable so budget.json remains the exact schema-v2 authority.
  Object.defineProperty(state, 'tasks', { configurable: true, enumerable: false, get: () => state.operations });
  return state;
}
export function loadBudget(root) {
  const path = join(root, 'budget.json');
  if (!existsSync(path)) {
    const orphans = orphanedReceipts(root);
    if (orphans.length) throw new Error(`review budget state is missing while ${orphans.length} terminal receipt(s) still claim a task budget; restore ${path} — close and associate are refused in this state too, by design`);
    return withLegacyTasksView({ schema: 2, operations: {}, aliases: {}, current_operation: null, active: null, operation_transitions: [] });
  }
  let state = readState(path);
  const migrated = state.schema === 1;
  if (migrated) state = migrateBudget(root, state);
  validateBudget(state);
  // Migration is a transaction: derive and validate the complete schema-v2
  // candidate before replacing the only durable budget authority.
  if (migrated) atomicJson(path, state);
  return withLegacyTasksView(state);
}

function validateBudget(state) {
  if (state.schema !== 2 || !state.operations || !state.aliases
    || (state.current_operation !== null && typeof state.current_operation !== 'string')
    || (state.active !== null && typeof state.active !== 'string') || !Array.isArray(state.operation_transitions)) throw new Error('invalid review budget state');
  for (const [key, operation] of Object.entries(state.operations)) {
    if (key !== `operation:${operation.operation_id}` || !operation.id || !operation.operation_id
      || !Array.isArray(operation.approvals) || !Array.isArray(operation.fix_approvals)
      || ['full', 'fix', 'delta'].some(kind => operation.limits?.[kind] !== 1 || !Number.isSafeInteger(operation.used?.[kind]) || operation.used[kind] < 0)) throw new Error('invalid review budget counters');
  }
  for (const target of Object.values(state.aliases)) if (!state.operations[target]) throw new Error('invalid review budget alias');
  if (state.current_operation && !state.operations[state.current_operation]) throw new Error('invalid current review operation');
}

function migrateBudget(root, legacy) {
  if (!legacy.tasks || !legacy.aliases || (legacy.active !== null && typeof legacy.active !== 'string')) throw new Error('invalid review budget state');
  const operations = {}, keys = new Map();
  for (const [oldKey, task] of Object.entries(legacy.tasks)) {
    const operationId = task.operation_id || task.id;
    const key = `operation:${operationId}`;
    if (!operationId || operations[key]) throw new Error('invalid legacy review budget operation');
    operations[key] = { ...task, operation_id: operationId };
    keys.set(oldKey, key);
  }
  const aliases = Object.fromEntries(Object.entries(legacy.aliases).map(([alias, target]) => {
    const key = keys.get(target);
    if (!key) throw new Error('invalid legacy review budget alias');
    return [alias, key];
  }));
  let current = null;
  if (legacy.active) {
    let manifest;
    try { manifest = readState(join(root, 'runs', legacy.active, 'run.json')); }
    catch { throw new Error('active legacy review manifest is missing or invalid'); }
    const matches = Object.keys(operations).filter(key => operations[key].id === manifest.task_budget_id);
    if (matches.length !== 1) throw new Error('active legacy review does not map to exactly one operation');
    current = matches[0];
  }
  if (!current && operations[`operation:${legacy.current_operation}`]) current = `operation:${legacy.current_operation}`;
  if (!current && Object.keys(operations).length === 1) current = Object.keys(operations)[0];
  return {
    schema: 2, operations, aliases, current_operation: current, active: legacy.active, operation_transitions: legacy.operation_transitions || [],
    ...(legacy.associations === undefined ? {} : { associations: legacy.associations }),
  };
}

function newOperation(state, operationId = randomUUID()) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error('operation id must be 1-128 safe identifier characters');
  const key = `operation:${operationId}`;
  if (state.operations[key]) throw new Error(`review operation already exists: ${operationId}`);
  state.operations[key] = { id: randomUUID(), operation_id: operationId, limits: { full: 1, fix: 1, delta: 1 }, used: { full: 0, fix: 0, delta: 0 }, approvals: [], fix_approvals: [] };
  return key;
}

export function taskBudget(root, cwd, options, state) {
  const branch = gitValue(cwd, ['branch', '--show-current']);
  if (!branch && !options.taskId && !options.operationId) throw new Error('Detached HEAD requires --operation-id or --task-id');
  const local = options.taskId ? `task:${options.taskId}` : `branch:${branch}`;
  const pr = options.pr ? `pr:${options.repo}#${options.pr}` : null;
  if (options.pr) {
    if (!/^\d+$/.test(String(options.pr)) || !options.repo) throw new Error('--pr requires a number and --repo owner/name');
  }
  const aliases = [local, pr].filter(Boolean);
  const bound = [...new Set(aliases.map(alias => state.aliases[alias]).filter(Boolean))];
  if (bound.length > 1) throw new Error('ambiguous review operation association');
  let key = bound[0] || null;
  if (options.newOperation) {
    if (!options.operationId?.trim() || !options.approvedBy?.trim() || !options.reason?.trim()) throw new Error('--new-operation requires --operation-id ID --approved-by USER --reason TEXT');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.operationId.trim())) throw new Error('operation id must be 1-128 safe identifier characters');
    const transferred = aliases.find(alias => state.aliases[alias]);
    if (transferred) throw new Error(`alias ${transferred} already belongs to another review operation; --new-operation cannot transfer aliases`);
    const from = state.current_operation;
    key = newOperation(state, options.operationId.trim());
    state.operation_transitions.push({ from, to: key, approved_by: options.approvedBy, reason: options.reason, at: new Date().toISOString() });
  } else if (options.operationId) {
    const explicit = `operation:${options.operationId}`;
    if (!state.operations[explicit]) {
      if (Object.keys(state.operations).length) throw new Error('unknown operation id; starting an independent operation requires --new-operation --approved-by USER --reason TEXT');
      key = newOperation(state, options.operationId);
    } else {
      if (key && key !== explicit && (options.taskId || options.pr)) throw new Error('operation id conflicts with an existing task/PR alias');
      key = explicit;
    }
  } else if (!key) {
    const known = Object.keys(state.operations);
    if (known.length === 0) key = newOperation(state, options.taskId || undefined);
    else if (known.length === 1) key = known[0];
    else throw new Error('unknown task alias is ambiguous across multiple review operations; pass an existing --operation-id');
  }
  if (!state.operations[key]) throw new Error('review operation is missing');
  if (!options.newOperation && state.current_operation && state.current_operation !== key) {
    if (!options.operationId && !bound.length) throw new Error('switching review operations requires an explicit existing --operation-id');
  }
  for (const alias of aliases) state.aliases[alias] = key;
  state.current_operation = key;
  return state.operations[key];
}
// One exception per task, not one per kind: an unbounded --exception is the same
// unbounded loop the budget exists to stop, only with a rubber stamp attached.
export const EXCEPTION_LIMIT = 1;
export function consume(task, kind, options = {}) {
  const exceptional = options.exception === kind;
  if (task.used[kind] >= task.limits[kind] || exceptional) {
    if (!exceptional || !options.approvedBy?.trim() || !options.reason?.trim()) throw new Error(`${kind} budget exhausted; a one-time --exception ${kind} --approved-by USER --reason TEXT is required`);
    if (task.approvals.length >= EXCEPTION_LIMIT) throw new Error(`this task already spent its ${EXCEPTION_LIMIT} budget exception; stop and hand the review back to a human owner`);
    task.approvals.push({ id: randomUUID(), kind, approved_by: options.approvedBy, reason: options.reason, at: new Date().toISOString() });
  }
  task.used[kind] += 1;
}
export function terminalReceipt(root, id) {
  const dir = join(root, 'runs', id);
  const receipt = readState(join(dir, 'terminal.json'));
  const manifest = readState(join(dir, 'run.json'));
  if (receipt.run_id !== id || receipt.target_hash !== manifest.target_hash || receipt.manifest_hash !== digest(readFileSync(join(dir, 'run.json')))
    || !['success', 'incomplete', 'cancelled'].includes(receipt.outcome)
    || receipt.validation_hash !== digest(readFileSync(join(dir, 'validation.json')))) throw new Error('invalid terminal validation receipt');
  if (receipt.outcome === 'success' && (!manifest.target?.file || digest(readFileSync(join(dir, manifest.target.file))) !== receipt.target_hash)) throw new Error('invalid terminal target bytes');
  const validation = readState(join(dir, 'validation.json'));
  if (receipt.outcome === 'success' && (!validation.ok || receipt.result_hash !== digest(readFileSync(join(dir, 'result.json'))))) throw new Error('invalid successful terminal receipt');
  if (receipt.schema !== 2) {
    if (manifest.operation_id) throw new Error('new review terminal receipt cannot be downgraded to legacy');
    return { ...receipt, action: conservativeLegacyAction(manifest, receipt), integrity: 'legacy-derived' };
  }
  const partialPath = join(dir, 'partial-result.json');
  const partialHash = existsSync(partialPath) ? digest(readFileSync(partialPath)) : null;
  if (receipt.partial_result_hash !== partialHash) throw new Error('invalid terminal partial-result receipt');
  const action = terminalAction(manifest, receipt.outcome, validation, receipt.outcome === 'success' ? readState(join(dir, 'result.json')) : null, partialHash ? readState(partialPath) : null);
  if (digest(JSON.stringify(action)) !== receipt.action_hash || JSON.stringify(action) !== JSON.stringify(receipt.action)) throw new Error('invalid terminal action receipt');
  return { ...receipt, integrity: 'verified' };
}

function conservativeLegacyAction(manifest, receipt) {
  return { schema: 'xm.review.terminal-action.v1', decision: 'stop', reason_code: receipt.outcome === 'cancelled' ? 'review_cancelled' : receipt.outcome === 'incomplete' ? 'review_incomplete' : 'review_complete_findings', auto_review_allowed: false, auto_fix_allowed: false, continuation: 'human_decision', operation_id: manifest.operation_id || manifest.task_budget_id || null, run_id: manifest.id, verdict: null, coverage_complete: false };
}

export function terminalAction(manifest, outcome, validation, result, partialResult) {
  const verdict = outcome === 'success' && result?.verdict === 'LGTM' ? 'LGTM' : null;
  const findings = result?.findings?.length || partialResult?.findings?.length || 0;
  const reasonCode = outcome === 'cancelled' ? 'review_cancelled' : outcome === 'incomplete' ? 'review_incomplete' : verdict === 'LGTM' ? 'review_complete_lgtm' : 'review_complete_findings';
  const continuation = outcome !== 'success' ? 'human_decision' : verdict === 'LGTM' && findings === 0 ? 'none' : 'human_triage';
  return { schema: 'xm.review.terminal-action.v1', decision: 'stop', reason_code: reasonCode, auto_review_allowed: false, auto_fix_allowed: false, continuation, operation_id: manifest.operation_id || manifest.task_budget_id || null, run_id: manifest.id, verdict, coverage_complete: outcome === 'success' && validation?.ok === true };
}

export function automationAfterTerminal(action, callbacks = {}) {
  if (!action || action.decision !== 'stop' || action.auto_review_allowed !== false || action.auto_fix_allowed !== false) throw new Error('unverified terminal action');
  return { review_calls: 0, fix_calls: 0, continuation: action.continuation, callbacks_invoked: 0 };
}
export function finishRun(root, manifest, outcome, reason) {
  const dir = join(root, 'runs', manifest.id);
  if (!existsSync(join(dir, 'validation.json'))) atomicJson(join(dir, 'validation.json'), { ok: false, reason });
  const validation = readState(join(dir, 'validation.json'));
  const result = outcome === 'success' ? readState(join(dir, 'result.json')) : null;
  const partialPath = join(dir, 'partial-result.json');
  const partial = existsSync(partialPath) ? readState(partialPath) : null;
  const action = terminalAction(manifest, outcome, validation, result, partial);
  atomicJson(join(dir, 'terminal.json'), {
    schema: 2,
    run_id: manifest.id, task_budget_id: manifest.task_budget_id, outcome, reason, at: new Date().toISOString(), target_hash: manifest.target_hash,
    manifest_hash: digest(readFileSync(join(dir, 'run.json'))), validation_hash: digest(readFileSync(join(dir, 'validation.json'))),
    result_hash: outcome === 'success' ? digest(readFileSync(join(dir, 'result.json'))) : null,
    partial_result_hash: partial ? digest(readFileSync(partialPath)) : null, action, action_hash: digest(JSON.stringify(action)),
  });
  atomicJson(join(dir, 'status.json'), { ...(existsSync(join(dir, 'status.json')) ? readState(join(dir, 'status.json')) : {}), state: outcome === 'success' ? 'completed' : outcome, updated_at: new Date().toISOString(), reason });
  const state = loadBudget(root);
  const task = Object.values(state.operations).find(value => value.id === manifest.task_budget_id);
  if (!task || state.active !== manifest.id) throw new Error('run does not own the active worktree budget');
  if (outcome === 'success') task.baseline = manifest.id;
  state.active = null;
  atomicJson(join(root, 'budget.json'), state);
}
export async function authorizeReviewFix(review, approval, options = {}) {
  return withReviewLock(options, ({ root }) => {
    const state = loadBudget(root);
    if (!review.task_budget_id) throw new Error('legacy review requires explicit lifecycle association');
    if (state.active) throw new Error('unfinished review must be recovered or closed before fixes');
    if (terminalReceipt(root, review.run_id).outcome !== 'success') throw new Error('fix requires a successful review receipt');
    if (digest(JSON.stringify(review)) !== digest(JSON.stringify(readState(join(root, 'runs', review.run_id, 'result.json'))))) throw new Error('review result does not match terminal receipt');
    const task = Object.values(state.operations).find(value => value.id === review.task_budget_id);
    if (!task || task.baseline !== review.run_id) throw new Error('review is not the current task baseline');
    if (task.fix_approvals.includes(approval)) return;
    if (task.used.delta > 0 && (options.exception !== 'fix' || !options.approvedBy?.trim() || !options.reason?.trim())) throw new Error('delta review completed; stop and report before additional fixes');
    consume(task, 'fix', options);
    task.fix_approvals.push(approval);
    atomicJson(join(root, 'budget.json'), state);
  });
}

export async function recordReviewFix(review, lifecycle, gate, options = {}) {
  return withReviewLock(options, ({ root }) => {
    const state = loadBudget(root);
    const task = Object.values(state.operations).find(value => value.id === review.task_budget_id);
    if (!task || task.baseline !== review.run_id || state.active) throw new Error('review-fix evidence does not belong to the current task baseline');
    task.fix_evidence = { run_id: review.run_id, lifecycle, gate, triage: readState(join(root, 'triage.json')) };
    atomicJson(join(root, 'budget.json'), state);
  });
}
