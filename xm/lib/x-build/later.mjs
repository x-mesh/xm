/**
 * x-build/later — Off-scope work capture
 */

import {
  TASK_STATES, C,
  readJSON, writeJSON,
  tasksPath, projectDir,
  resolveProject, parseOptions,
  existsSync, join,
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
  if (!sub || !['add', 'list', 'promote', 'dismiss'].includes(sub)) {
    console.error('Usage: x-build later <add|list|promote|dismiss> [args]');
    process.exit(1);
  }

  const project = resolveProject(null);

  if (sub === 'add') return laterAdd(project, args.slice(1));
  if (sub === 'list') return laterList(project, args.slice(1));
  if (sub === 'promote') return laterPromote(project, args.slice(1));
  if (sub === 'dismiss') return laterDismiss(project, args.slice(1));
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

  const data = readLater(project);
  const now = new Date().toISOString();
  const item = {
    id: nextLaterId(data.items),
    title,
    status: 'open',
    reason: opts.reason && opts.reason !== true ? String(opts.reason) : '',
    source: opts.source && opts.source !== true ? String(opts.source) : 'manual',
    impact,
    current_task: opts.task && opts.task !== true ? String(opts.task) : null,
    files: splitList(opts.files),
    created_at: now,
    updated_at: now,
  };

  data.items.push(item);
  writeLater(project, data);

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
    console.log(`  ${item.id} [${item.status}] ${item.title}${task}${files}`);
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

  const data = readLater(project);
  const item = data.items.find(entry => entry.id === id);
  if (!item) {
    console.error(`❌ Later item not found: ${id}`);
    process.exit(1);
  }
  if (item.status === 'promoted') {
    console.error(`❌ Later item ${id} was already promoted to ${item.promoted_task_id}. Remove or complete the task first.`);
    process.exit(1);
  }
  if (item.status === 'dismissed') {
    console.error(`❌ Later item ${id} is already dismissed.`);
    process.exit(1);
  }

  item.status = 'dismissed';
  item.dismiss_reason = opts.reason && opts.reason !== true ? String(opts.reason) : '';
  item.updated_at = new Date().toISOString();
  writeLater(project, data);
  console.log(`${C.green}Dismissed:${C.reset} ${id} — ${item.title}`);
}
