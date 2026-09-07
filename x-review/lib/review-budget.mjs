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
export function orphanedReceipts(root) {
  const runs = join(root, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    try { return readState(join(runs, entry.name, 'terminal.json')).task_budget_id || null; } catch { return null; }
  }).filter(Boolean);
}
export function loadBudget(root) {
  const path = join(root, 'budget.json');
  if (!existsSync(path)) {
    const orphans = orphanedReceipts(root);
    if (orphans.length) throw new Error(`review budget state is missing while ${orphans.length} terminal receipt(s) still claim a task budget; restore ${path} or close the runs before reviewing again`);
    return { schema: 1, tasks: {}, aliases: {}, active: null };
  }
  const state = readState(path);
  if (state.schema !== 1 || !state.tasks || !state.aliases || (state.active !== null && typeof state.active !== 'string')) throw new Error('invalid review budget state');
  for (const task of Object.values(state.tasks)) {
    if (!task.id || !Array.isArray(task.approvals) || !Array.isArray(task.fix_approvals)
      || ['full', 'fix', 'delta'].some(kind => task.limits?.[kind] !== 1 || !Number.isSafeInteger(task.used?.[kind]) || task.used[kind] < 0)) throw new Error('invalid review budget counters');
  }
  return state;
}
export function taskBudget(root, cwd, options, state) {
  const branch = gitValue(cwd, ['branch', '--show-current']);
  if (!branch && !options.taskId) throw new Error('Detached HEAD requires --task-id');
  const local = options.taskId ? `task:${options.taskId}` : `branch:${branch}`;
  let key = state.aliases[local] || local;
  if (options.pr) {
    if (!/^\d+$/.test(String(options.pr)) || !options.repo) throw new Error('--pr requires a number and --repo owner/name');
    const pr = `pr:${options.repo}#${options.pr}`;
    if (state.tasks[pr] && state.tasks[key] && key !== pr) throw new Error('ambiguous task association; existing PR and local task both have budgets');
    if (state.tasks[key] && key !== pr) {
      state.tasks[pr] = state.tasks[key]; delete state.tasks[key];
      for (const alias of Object.keys(state.aliases)) if (state.aliases[alias] === key) state.aliases[alias] = pr;
    }
    key = pr;
  }
  state.aliases[local] = key;
  state.tasks[key] ||= { id: randomUUID(), limits: { full: 1, fix: 1, delta: 1 }, used: { full: 0, fix: 0, delta: 0 }, approvals: [], fix_approvals: [] };
  return state.tasks[key];
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
  if (receipt.outcome === 'success' && (!readState(join(dir, 'validation.json')).ok || receipt.result_hash !== digest(readFileSync(join(dir, 'result.json'))))) throw new Error('invalid successful terminal receipt');
  return receipt;
}
export function finishRun(root, manifest, outcome, reason) {
  const dir = join(root, 'runs', manifest.id);
  if (!existsSync(join(dir, 'validation.json'))) atomicJson(join(dir, 'validation.json'), { ok: false, reason });
  atomicJson(join(dir, 'terminal.json'), {
    run_id: manifest.id, task_budget_id: manifest.task_budget_id, outcome, reason, at: new Date().toISOString(), target_hash: manifest.target_hash,
    manifest_hash: digest(readFileSync(join(dir, 'run.json'))), validation_hash: digest(readFileSync(join(dir, 'validation.json'))),
    result_hash: outcome === 'success' ? digest(readFileSync(join(dir, 'result.json'))) : null,
  });
  atomicJson(join(dir, 'status.json'), { ...(existsSync(join(dir, 'status.json')) ? readState(join(dir, 'status.json')) : {}), state: outcome === 'success' ? 'completed' : outcome, updated_at: new Date().toISOString(), reason });
  const state = loadBudget(root);
  const task = Object.values(state.tasks).find(value => value.id === manifest.task_budget_id);
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
    const task = Object.values(state.tasks).find(value => value.id === review.task_budget_id);
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
    const task = Object.values(state.tasks).find(value => value.id === review.task_budget_id);
    if (!task || task.baseline !== review.run_id || state.active) throw new Error('review-fix evidence does not belong to the current task baseline');
    task.fix_evidence = { run_id: review.run_id, lifecycle, gate, triage: readState(join(root, 'triage.json')) };
    atomicJson(join(root, 'budget.json'), state);
  });
}
