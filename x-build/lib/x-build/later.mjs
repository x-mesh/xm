/**
 * x-build/later — Off-scope work capture
 */

import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import {
  TASK_STATES, C,
  readJSON, writeJSON, modifyJSON,
  tasksPath, projectDir,
  resolveProject, parseOptions,
  existsSync, join, resolve, ROOT, readFileSync,
} from './core.mjs';

const VALID_STATUS = new Set(['open', 'promoted', 'dismissed']);
const DEFERABLE_IMPACTS = new Set(['none', 'low', 'unknown']);

function laterPath(project) {
  return join(projectDir(project), 'later.json');
}

function readLater(project) {
  return readJSON(laterPath(project)) || { items: [] };
}

function writeLater(project, data) {
  writeJSON(laterPath(project), data);
}

function nextLaterId(items) {
  const max = items.reduce((n, item) => {
    const parsed = parseInt(String(item.id || '').replace(/^l/, ''), 10);
    return Number.isFinite(parsed) && parsed > n ? parsed : n;
  }, 0);
  return `l${max + 1}`;
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function workspaceRoot() {
  return resolve(ROOT, '..', '..');
}

function normalizeWorkspaceFile(file) {
  const raw = String(file || '').trim();
  if (!raw) return null;
  const root = workspaceRoot();
  const abs = resolve(root, raw);
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel === '..' || rel.startsWith('../')) {
    console.error(`❌ Later file path escapes the workspace: ${raw}`);
    process.exit(1);
  }
  return rel;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileSnapshot(file) {
  const rel = normalizeWorkspaceFile(file);
  const abs = resolve(workspaceRoot(), rel);
  if (!existsSync(abs)) return { file: rel, exists: false, sha256: null };
  return { file: rel, exists: true, sha256: hashFile(abs) };
}

function compareSnapshot(snapshot) {
  const abs = resolve(workspaceRoot(), snapshot.file);
  const exists = existsSync(abs);
  const sha256 = exists ? hashFile(abs) : null;
  return {
    file: snapshot.file,
    changed: exists !== snapshot.exists || sha256 !== snapshot.sha256,
    before_exists: snapshot.exists,
    after_exists: exists,
  };
}

function nextTaskId(tasks) {
  const max = tasks.reduce((n, task) => {
    const parsed = parseInt(String(task.id || '').replace(/^t/, ''), 10);
    return Number.isFinite(parsed) && parsed > n ? parsed : n;
  }, 0);
  return `t${max + 1}`;
}

// ── cmdLater ────────────────────────────────────────────────────────

export function cmdLater(args) {
  const sub = args[0];
  if (!sub || !['add', 'list', 'promote', 'dismiss', 'verify-scope'].includes(sub)) {
    console.error('Usage: x-build later <add|list|promote|dismiss|verify-scope> [args]');
    process.exit(1);
  }

  const project = resolveProject(null);

  if (sub === 'add') return laterAdd(project, args.slice(1));
  if (sub === 'list') return laterList(project, args.slice(1));
  if (sub === 'promote') return laterPromote(project, args.slice(1));
  if (sub === 'dismiss') return laterDismiss(project, args.slice(1));
  if (sub === 'verify-scope') return laterVerifyScope(project, args.slice(1));
}

export function laterAdd(project, args) {
  const { opts, positional } = parseOptions(args);
  const title = positional.join(' ').trim();
  if (!title) {
    console.error('Usage: x-build later add "title" [--reason "..."] [--source "..."] [--impact none|low|unknown] [--files a,b] [--task t1]');
    process.exit(1);
  }

  const impact = String(opts.impact || 'none').toLowerCase();
  if (!DEFERABLE_IMPACTS.has(impact)) {
    console.error(`❌ Off-scope item "${title}" is not safely deferable (impact: ${impact}).`);
    console.error('   If it affects the current task, update the active task or fix it inside the current scope instead.');
    process.exit(1);
  }

  const currentTask = opts.task && opts.task !== true ? String(opts.task) : null;
  if (currentTask) {
    const tasksData = readJSON(tasksPath(project)) || { tasks: [] };
    const validIds = new Set(tasksData.tasks.map(task => task.id));
    if (!validIds.has(currentTask)) {
      console.error(`❌ Unknown current task: "${currentTask}" does not exist. Add it first or omit --task.`);
      process.exit(1);
    }
  }

  const files = splitList(opts.files).map(normalizeWorkspaceFile).filter(Boolean);
  const fileSnapshots = files.map(fileSnapshot);
  let item;
  modifyJSON(laterPath(project), current => {
    const data = current || { items: [] };
    const now = new Date().toISOString();
    item = {
      id: nextLaterId(data.items || []),
      title,
      status: 'open',
      reason: opts.reason && opts.reason !== true ? String(opts.reason) : '',
      source: opts.source && opts.source !== true ? String(opts.source) : 'manual',
      impact,
      current_task: currentTask,
      files,
      file_snapshots: fileSnapshots,
      created_at: now,
      updated_at: now,
    };
    data.items = data.items || [];
    data.items.push(item);
    return data;
  });

  console.log(`${C.green}Later item added:${C.reset} ${item.id} — ${item.title}`);
  console.log('  Deferred by design. Do not edit code for this item until it is promoted to a task.');
}

export function laterList(project, args) {
  const { opts } = parseOptions(args);
  const status = opts.status && opts.status !== true ? String(opts.status) : 'open';
  if (!VALID_STATUS.has(status) && status !== 'all') {
    console.error(`Usage: x-build later list [--status open|promoted|dismissed|all]`);
    process.exit(1);
  }

  const data = readLater(project);
  const items = status === 'all' ? data.items : data.items.filter(item => item.status === status);

  if (items.length === 0) {
    console.log(`No later items${status === 'all' ? '' : ` with status "${status}"`}.`);
    return;
  }

  console.log(`\nLater (${items.length} ${status === 'all' ? 'total' : status}):\n`);
  for (const item of items) {
    const files = item.files?.length ? ` files: ${item.files.join(',')}` : '';
    const task = item.current_task ? ` task: ${item.current_task}` : '';
    const promoted = item.promoted_task_id ? ` promoted: ${item.promoted_task_id}` : '';
    console.log(`  ${item.id} [${item.status}] ${item.title}${task}${promoted}${files}`);
    if (item.reason) console.log(`     reason: ${item.reason}`);
  }
  console.log('');
}

export function laterPromote(project, args) {
  const { opts, positional } = parseOptions(args);
  const id = positional[0];
  if (!id) {
    console.error('Usage: x-build later promote <id> [--size small|medium|large] [--deps t1,t2]');
    process.exit(1);
  }

  const data = readLater(project);
  const item = data.items.find(entry => entry.id === id);
  if (!item) {
    console.error(`❌ Later item not found: ${id}`);
    process.exit(1);
  }
  if (item.status !== 'open') {
    console.error(`❌ Later item ${id} is already ${item.status}.`);
    process.exit(1);
  }

  const tasksData = readJSON(tasksPath(project)) || { tasks: [] };
  const deps = splitList(opts.deps);
  const validIds = new Set(tasksData.tasks.map(task => task.id));
  for (const dep of deps) {
    if (!validIds.has(dep)) {
      console.error(`❌ Unknown dependency: "${dep}" does not exist. Add it first or check the ID.`);
      process.exit(1);
    }
  }

  const taskId = nextTaskId(tasksData.tasks);
  const now = new Date().toISOString();
  tasksData.tasks.push({
    id: taskId,
    name: item.title,
    depends_on: deps,
    size: opts.size && opts.size !== true ? String(opts.size) : 'medium',
    role: null,
    strategy: null,
    rubric: null,
    team: null,
    score: null,
    done_criteria: item.reason ? [`Address later item ${id}: ${item.reason}`] : null,
    status: TASK_STATES.PENDING,
    created_at: now,
    source: `later:${id}`,
  });
  writeJSON(tasksPath(project), tasksData);

  item.status = 'promoted';
  item.promoted_task_id = taskId;
  item.updated_at = now;
  writeLater(project, data);

  console.log(`${C.green}Promoted:${C.reset} ${id} → ${taskId} — ${item.title}`);
}

export function laterDismiss(project, args) {
  const { opts, positional } = parseOptions(args);
  const id = positional[0];
  if (!id) {
    console.error('Usage: x-build later dismiss <id> [--reason "..."]');
    process.exit(1);
  }

  let item;
  let previousStatus = null;
  modifyJSON(laterPath(project), current => {
    const data = current || { items: [] };
    item = data.items.find(entry => entry.id === id);
    if (!item) return data;
    previousStatus = item.status;
    if (item.status === 'promoted' || item.status === 'dismissed') return data;
    item.status = 'dismissed';
    item.dismiss_reason = opts.reason && opts.reason !== true ? String(opts.reason) : '';
    item.updated_at = new Date().toISOString();
    return data;
  });
  if (!item) {
    console.error(`❌ Later item not found: ${id}`);
    process.exit(1);
  }
  if (item.status === 'promoted') {
    console.error(`❌ Later item ${id} was already promoted to ${item.promoted_task_id}. Remove or complete the task first.`);
    process.exit(1);
  }
  if (previousStatus === 'dismissed') {
    console.error(`❌ Later item ${id} is already dismissed.`);
    process.exit(1);
  }

  console.log(`${C.green}Dismissed:${C.reset} ${id} — ${item.title}`);
}

export function laterVerifyScope(project, args) {
  const { opts } = parseOptions(args);
  const data = readLater(project);
  const openItems = (data.items || []).filter(item => item.status === 'open');
  const failures = [];
  const warnings = [];

  for (const item of openItems) {
    if (!Array.isArray(item.file_snapshots) || item.file_snapshots.length === 0) {
      if (item.files?.length) warnings.push(`${item.id}: no baseline snapshot recorded for ${item.files.join(', ')}`);
      continue;
    }
    for (const result of item.file_snapshots.map(compareSnapshot)) {
      if (result.changed) {
        failures.push(`${item.id}: ${result.file} changed while later item is still open`);
      }
    }
  }

  if (warnings.length > 0 && opts.strict) {
    failures.push(...warnings);
  }

  if (failures.length > 0) {
    console.log(`${C.red}Later scope check failed.${C.reset}`);
    for (const failure of failures) console.log(`  - ${failure}`);
    for (const warning of warnings) console.log(`  ${C.yellow}Warning:${C.reset} ${warning}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${C.green}Later scope check passed.${C.reset}`);
  console.log(`  Open later items: ${openItems.length}`);
  for (const warning of warnings) console.log(`  ${C.yellow}Warning:${C.reset} ${warning}`);
}
