/**
 * x-build/tasks — Task management + execution
 */

import {
  PHASES, TASK_STATES, STATUS_ALIASES, C,
  ROLE_MODEL_MAP_HR, getModelForRole, getModelForRoleWithCorrelation, generateCorrelationId, checkBudget, loadSharedConfig, XM_GLOBAL, ROOT,
  readJSON, writeJSON, modifyJSON, readMD,
  manifestPath, tasksPath, stepsPath, prdPath, contextDir, phaseDir, decisionsPath, projectDir,
  resolveProject, logDecision, addDecision, appendMetric, emitHook,
  parseOptions, renderBar, fmtDuration,
  estimateTaskCost, costFromTokens,
  gitAutoCommit, gitRollbackTask,
  updateCircuitBreaker, isCircuitOpen, beginHalfOpenProbe, scheduleRetry,
  getCircuitState, resetCircuitBreaker,
  existsSync, join, mkdirSync,
  createRL, ask, pickMenu, E, exitFail,
  readdirSync, repoRoot,
} from './core.mjs';
// Worktree orchestration lives in worktrees.mjs; the expected_files utils and
// config resolver live in the shared leaf. tasks.mjs imports both ONE-DIRECTION
// (nothing here is imported back), so there is no cycle — see worktree-shared.mjs.
import {
  worktreesDir, readRun, WORKTREE_STATUS,
  planWorktrees, runPreflight, acquireWorktree, buildAgentEnv,
  listExistingBranches,
} from './worktrees.mjs';
import {
  isParallelSafe, normalizeExpectedFiles, expectedFilesOverlap, loadWorktreeConfig,
} from './worktree-shared.mjs';

// Re-export the expected_files utils so existing importers (tests) that pull them
// from tasks.mjs keep working after the move to the shared leaf.
export { isParallelSafe, normalizeExpectedFiles, expectedFilesOverlap };

// ── cmdTasks ────────────────────────────────────────────────────────

export function cmdTasks(args) {
  const sub = args[0];
  if (!sub || !['add', 'list', 'remove', 'update', 'reopen', 'done-criteria'].includes(sub)) {
    console.error('Usage: x-build tasks <add|list|remove|update|reopen|done-criteria> [args] [--project <name>]');
    exitFail(1);
  }

  // Extract `--project <name>` from args before subcommand parsing so write
  // commands explicitly target the named project. Without this, multiple
  // active projects collapse to "last init" and writes hit the wrong one.
  const subArgs = args.slice(1);
  let explicitProject = null;
  const projIdx = subArgs.indexOf('--project');
  if (projIdx >= 0) {
    const val = subArgs[projIdx + 1];
    if (val === undefined || val.startsWith('--')) {
      console.error('❌ --project requires a value. Usage: --project <name>');
      exitFail(1);
    }
    explicitProject = val;
    subArgs.splice(projIdx, 2);
  }
  const project = resolveProject(explicitProject);

  if (sub === 'add') return taskAdd(project, subArgs);
  if (sub === 'list') return taskList(project);
  if (sub === 'remove') return taskRemove(project, subArgs);
  if (sub === 'update') return taskUpdate(project, subArgs);
  if (sub === 'reopen') return taskReopen(project, subArgs);
  if (sub === 'done-criteria') return taskDoneCriteria(project);
}

// Build a map of R# → requirement text from REQUIREMENTS.md so task names that
// reference [R1] can be expanded inline (agent prompt + task list). Without this
// an executor sees only the compressed "[R1]" tag and must open REQUIREMENTS.md
// by hand — the #1 "what does this task even mean?" gap.
function loadRequirementsMap(project) {
  const reqText = readMD(join(contextDir(project), 'REQUIREMENTS.md'));
  if (!reqText) return new Map();
  const map = new Map();
  for (const m of reqText.matchAll(/^-\s*\[(R\d+)\]\s*[:\-—]?\s*(.+)$/gim)) {
    map.set(m[1].toUpperCase(), m[2].trim());
  }
  return map;
}

// Expand [R#] refs in a task name to "R#: requirement text" lines.
function expandReqRefs(name, reqMap) {
  if (!reqMap?.size || !name) return [];
  const ids = [...name.matchAll(/\[(R\d+)\]/gi)].map(m => m[1].toUpperCase());
  const out = [];
  for (const id of ids) {
    const text = reqMap.get(id);
    if (text) out.push(`${id}: ${text}`);
  }
  return out;
}

// ── expected_files (worktree parallel-batching signal) ──────────────
//
// Plan-phase produces per-task `expected_files[]` so the worktree pipeline can
// decide which ready tasks are safe to run in parallel. The canonical rule is
// "when in doubt, run sequentially": a task with no/empty expected_files, or one
// whose files intersect another task's, is NOT parallel-safe.

// Parse a comma-separated --expected-files value into a normalized string[].
// undefined  → [] (field absent — treated as no expected files)
// true / ""  → [] (flag given without value → explicit empty)
// "a,b"      → ['a', 'b'] (trimmed, blanks dropped)
function parseExpectedFiles(raw) {
  if (raw === undefined) return [];
  if (raw === true || raw === '') return [];
  if (typeof raw !== 'string') return [];
  return raw.split(',').map(f => f.trim()).filter(Boolean);
}

// normalizeExpectedFiles / expectedFilesOverlap / isParallelSafe now live in
// worktree-shared.mjs (imported + re-exported at the top of this file) so
// worktrees.mjs can use them without importing tasks.mjs (cycle relief, t10 §4).

export function taskDoneCriteria(project) {
  const data = readJSON(tasksPath(project));
  if (!data?.tasks?.length) {
    console.log('No tasks defined. Run: x-build tasks add <name>');
    return;
  }

  const prd = readMD(prdPath(project));

  if (!prd) {
    console.log(`${C.yellow}No PRD found. done_criteria works best with PRD acceptance criteria.${C.reset}`);
    console.log(`  Set manually: x-build tasks update <id> --done-criteria "criteria"`);
    return;
  }

  const acSection = prd.match(/##\s*(?:8\.)?\s*Acceptance Criteria[\s\S]*?(?=##\s*\d|$)/i);
  const acItems = acSection ? [...acSection[0].matchAll(/- \[[ x]\] (.+)/gi)].map(m => m[1].trim()) : [];

  const acByRid = new Map();
  for (const ac of acItems) {
    const acLower = ac.toLowerCase();
    const rids = [...acLower.matchAll(/r\d+/g)].map(m => m[0]);
    for (const rid of rids) {
      if (!acByRid.has(rid)) acByRid.set(rid, []);
      acByRid.get(rid).push(ac);
    }
  }

  let updated = 0;
  for (const task of data.tasks) {
    if (task.done_criteria?.length) continue;

    const reqIds = [...(task.name.matchAll(/\[R\d+\]/g))].map(m => m[0].replace(/[\[\]]/g, '').toLowerCase());
    const criteria = [];

    for (const rid of reqIds) {
      const matched = acByRid.get(rid);
      if (matched) criteria.push(...matched);
    }

    // G5: Better fallback — include both happy path and error path
    if (criteria.length === 0) {
      criteria.push(`${task.name} — happy path verified`);
      criteria.push(`${task.name} — primary error case handled`);
    }

    // Size-based test expectations
    const testCriteria = {
      small: ['Unit test passes for core logic'],
      medium: ['Unit tests pass', 'Integration test covers main flow'],
      large: ['Unit tests pass (80%+ coverage)', 'Integration tests pass', 'E2E test covers critical path'],
    };
    criteria.push(...(testCriteria[task.size] || testCriteria.medium));

    // Domain-specific criteria based on task name keywords
    const nameLower = task.name.toLowerCase();
    if (/\b(auth|login|security|jwt|oauth|session)\b/.test(nameLower)) {
      criteria.push('No OWASP Top 10 vulnerabilities (SQLi, XSS, CSRF)');
    }
    if (/\b(api|endpoint|route|rest|graphql)\b/.test(nameLower)) {
      criteria.push('Error responses (4xx, 5xx) are handled and documented');
    }
    if (/\b(database|migration|schema|model)\b/.test(nameLower)) {
      criteria.push('Rollback scenario verified');
    }
    if (/\b(ui|frontend|component|page|view)\b/.test(nameLower)) {
      criteria.push('Renders correctly on target browsers/viewports');
    }

    // NFR criteria from PRD Section 4
    const nfrSection = prd.match(/##\s*(?:4\.)?\s*Non.?Functional[\s\S]*?(?=##\s*\d|$)/i);
    if (nfrSection) {
      const nfr = nfrSection[0];
      if (/performance|latency|response.?time/i.test(nfr) && /\b(api|endpoint|server)\b/.test(nameLower)) {
        const perfTarget = nfr.match(/(\d+\s*ms|\d+\s*s(?:ec)?)/i);
        criteria.push(perfTarget ? `Response time meets target: ${perfTarget[1]}` : 'Performance target met');
      }
    }

    task.done_criteria = criteria;
    updated++;
  }

  if (updated > 0) writeJSON(tasksPath(project), data);
  console.log(`\n✅ done_criteria generated for ${updated} tasks\n`);

  for (const task of data.tasks) {
    if (task.done_criteria) {
      console.log(`  ${task.id}: ${task.done_criteria}`);
    }
  }
  console.log('');
}

export function taskAdd(project, args) {
  const { opts, positional } = parseOptions(args);
  const name = positional.join(' ');

  if (!name) {
    console.error('Usage: x-build tasks add <name> [--desc "what+why"] [--deps t1,t2] [--size small|medium|large] [--strategy refine] [--rubric general] [--expected-files a.mjs,b.mjs]');
    exitFail(1);
  }

  const data = readJSON(tasksPath(project)) || { tasks: [] };
  const maxNum = data.tasks.reduce((max, t) => {
    const n = parseInt(t.id?.replace('t', ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  const id = `t${maxNum + 1}`;
  const deps = opts.deps ? opts.deps.split(',').map(d => d.trim()) : [];
  const size = opts.size || 'medium';

  const validIds = new Set(data.tasks.map(t => t.id));
  for (const dep of deps) {
    if (!validIds.has(dep)) {
      console.error(`❌ Unknown dependency: "${dep}" does not exist. Add it first or check the ID.`);
      exitFail(1);
    }
  }

  const role = opts.role || null;
  const strategy = opts.strategy || null;
  const rubric = opts.rubric || null;
  const team = opts.team || null;
  if (opts.desc !== undefined && typeof opts.desc !== 'string') {
    console.error('❌ --desc requires a value. Usage: --desc "what + why"');
    exitFail(1);
  }
  const description = typeof opts.desc === 'string' && opts.desc.trim() ? opts.desc.trim() : null;
  const rawCriteria = opts['done-criteria'] || null;
  const doneCriteria = rawCriteria ? rawCriteria.split(';').map(c => c.trim()).filter(Boolean) : null;
  if (opts['expected-files'] !== undefined && typeof opts['expected-files'] !== 'string') {
    console.error('❌ --expected-files requires a value. Usage: --expected-files "a.mjs,b.mjs"');
    exitFail(1);
  }
  const expectedFiles = parseExpectedFiles(opts['expected-files']);

  const task = {
    id,
    name,
    description,
    depends_on: deps,
    size,
    role,
    strategy,
    rubric,
    team,
    score: null,
    done_criteria: doneCriteria,
    expected_files: expectedFiles,
    status: TASK_STATES.PENDING,
    created_at: new Date().toISOString(),
  };

  // Scope creep detection: check against PRD Out of Scope
  const path = prdPath(project);
  if (existsSync(path)) {
    const prd = readMD(path);
    const oosSection = prd?.match(/##\s*(?:6\.)?\s*Out of Scope[\s\S]*?(?=##\s*\d|$)/i);
    if (oosSection) {
      const oosItems = oosSection[0].match(/- (.+)/g)?.map(m => m.slice(2).trim().toLowerCase()) || [];
      const nameLower = name.toLowerCase();
      const scopeHit = oosItems.find(item => {
        const words = item.split(/\s+/).filter(w => w.length > 3);
        return words.some(w => nameLower.includes(w));
      });
      if (scopeHit) {
        console.log(`${C.yellow}⚠ Scope warning: "${name}" may overlap with Out of Scope item: "${scopeHit}"${C.reset}`);
        console.log(`${C.dim}  If intentional, proceed. Otherwise consider removing this task.${C.reset}`);
      }
    }
  }

  data.tasks.push(task);
  writeJSON(tasksPath(project), data);
  console.log(`✅ Task added: ${id} — ${name}${deps.length ? ` (deps: ${deps.join(', ')})` : ''}`);
  if (description) console.log(`   ${C.dim}${description}${C.reset}`);
  if (!description) console.log(`   ${C.dim}↳ no description — add intent with: x-build tasks update ${id} --desc "what + why"${C.reset}`);
}

export function taskList(project) {
  const data = readJSON(tasksPath(project));
  if (!data?.tasks?.length) {
    console.log('No tasks defined. Run: x-build tasks add <name>');
    return;
  }

  console.log(`\n📋 Tasks (${data.tasks.length}):\n`);

  const stateIcon = {
    [TASK_STATES.PENDING]: '⬜',
    [TASK_STATES.READY]: '🟡',
    [TASK_STATES.RUNNING]: '🔵',
    [TASK_STATES.COMPLETED]: '✅',
    [TASK_STATES.FAILED]: '❌',
    [TASK_STATES.CANCELLED]: '⛔',
  };

  const reqMap = loadRequirementsMap(project);
  const scoredTasks = [];
  for (const task of data.tasks) {
    const icon = stateIcon[task.status] || '⬜';
    const deps = task.depends_on.length ? ` ← [${task.depends_on.join(', ')}]` : '';
    const size = task.size ? ` (${task.size})` : '';
    const scoreStr = task.score != null ? ` Score: ${task.score}/10` : '';
    const scoreWarn = task.score != null && task.score < 7 ? ' ⚠' : '';
    const strategyStr = task.strategy ? ` ${C.yellow}[${task.strategy}]${C.reset}` : '';
    console.log(`  ${icon} ${task.id}: ${task.name}${size}${deps}${scoreStr}${scoreWarn}${strategyStr}`);

    // Second line(s): intent (or expanded requirement text as fallback) + a
    // done-criteria count, so the list explains each task instead of just a tag.
    const sub = [];
    if (task.description) {
      sub.push(task.description.length > 100 ? task.description.slice(0, 97) + '…' : task.description);
    } else {
      for (const r of expandReqRefs(task.name, reqMap)) sub.push(r);
    }
    for (const s of sub) console.log(`     ${C.dim}↳ ${s}${C.reset}`);
    const dc = task.done_criteria?.length || 0;
    const dcLabel = dc ? `${dc} done-criteria` : `${C.yellow}no done-criteria${C.reset}`;
    const descLabel = sub.length ? '' : `${C.yellow}no description${C.reset} · `;
    console.log(`     ${C.dim}↳ ${descLabel}${dcLabel}${C.reset}`);

    if (task.score != null) scoredTasks.push(task);
  }

  if (scoredTasks.length > 0) {
    const avg = scoredTasks.reduce((s, t) => s + t.score, 0) / scoredTasks.length;
    const belowThreshold = scoredTasks.filter(t => t.score < 7).length;
    const color = avg >= 7 ? C.green : avg >= 5 ? C.yellow : C.red;
    console.log(`\n  📊 Quality: ${color}${avg.toFixed(1)}/10 avg${C.reset} (${scoredTasks.length} scored${belowThreshold ? `, ${C.yellow}${belowThreshold} below 7.0${C.reset}` : ''})`);
  }
  console.log('');
}

export function taskRemove(project, args) {
  const { opts, positional } = parseOptions(args);
  const id = positional[0];
  if (!id) {
    console.error('Usage: x-build tasks remove <task-id> [--cascade]');
    exitFail(1);
  }

  const data = readJSON(tasksPath(project));
  const idx = data.tasks.findIndex(t => t.id === id);
  if (idx === -1) {
    console.error(`❌ ${E('task-not-found', { id })}`);
    exitFail(1);
  }

  const cascade = opts.cascade !== undefined;

  // Collect all tasks to remove (id + transitive dependents if --cascade)
  const toRemove = new Set([id]);
  if (cascade) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of data.tasks) {
        if (!toRemove.has(t.id) && t.depends_on.some(d => toRemove.has(d))) {
          toRemove.add(t.id);
          changed = true;
        }
      }
    }
  } else {
    const dependents = data.tasks.filter(t => t.depends_on.includes(id));
    if (dependents.length > 0) {
      console.error(`❌ Cannot remove "${id}" — depended on by: ${dependents.map(t => t.id).join(', ')}`);
      console.error(`   Use --cascade to remove "${id}" and all dependents.`);
      exitFail(1);
    }
  }

  // Remove in reverse dependency order
  const removed = [];
  data.tasks = data.tasks.filter(t => {
    if (toRemove.has(t.id)) { removed.push(t.id); return false; }
    return true;
  });

  // Clean up stale deps in remaining tasks
  for (const t of data.tasks) {
    t.depends_on = t.depends_on.filter(d => !toRemove.has(d));
  }

  writeJSON(tasksPath(project), data);
  for (const rid of removed) console.log(`✅ Task "${rid}" removed.`);
}

export function taskUpdate(project, args) {
  const { opts, positional } = parseOptions(args);
  const id = positional[0];
  const rawStatus = opts.status;

  if (!id || (!rawStatus && opts.score === undefined && opts['done-criteria'] === undefined && opts.deps === undefined && opts.desc === undefined && opts['expected-files'] === undefined)) {
    console.error('Usage: x-build tasks update <task-id> --status <pending|ready|running|completed|failed> [--no-commit]');
    console.error('       x-build tasks update <task-id> --status completed --tokens-in <n> --tokens-out <n>  (record actual cost)');
    console.error('       x-build tasks update <task-id> --score <number>');
    console.error('       x-build tasks update <task-id> --desc "what + why"  (set task description)');
    console.error('       x-build tasks update <task-id> --done-criteria "criteria text"');
    console.error('       x-build tasks update <task-id> --deps t1,t2  (replace dependency list; pass empty string to clear)');
    console.error('       x-build tasks update <task-id> --expected-files a.mjs,b.mjs  (replace expected file list; pass empty string to clear)');
    exitFail(1);
  }

  // Use modifyJSON for atomic read-modify-write (parallel agent safe)
  let taskFound = false;
  let oldStatus, newStatus, updatedFields = [];
  let taskRef = null;

  modifyJSON(tasksPath(project), (data) => {
    if (!data) { console.error('❌ No tasks data found.'); exitFail(1); }
    const task = data.tasks.find(t => t.id === id);
    if (!task) { console.error(`❌ ${E('task-not-found', { id })}`); exitFail(1); }
    taskFound = true;
    taskRef = task;

    if (opts.score !== undefined) {
      task.score = parseFloat(opts.score);
      updatedFields.push(`score: ${task.score}`);
    }

    if (opts.desc !== undefined) {
      if (typeof opts.desc !== 'string') {
        console.error('❌ --desc requires a value. Usage: --desc "what + why"');
        exitFail(1);
      }
      task.description = opts.desc.trim() || null;
      updatedFields.push('description updated');
    }

    if (opts['done-criteria'] !== undefined) {
      if (typeof opts['done-criteria'] !== 'string') {
        console.error('❌ --done-criteria requires a value. Usage: --done-criteria "criteria text"');
        exitFail(1);
      }
      task.done_criteria = opts['done-criteria'].split(';').map(c => c.trim()).filter(Boolean);
      updatedFields.push('done_criteria updated');
    }

    if (opts['expected-files'] !== undefined) {
      // parseOptions collapses `--expected-files` (no value) and `--expected-files ""`
      // to `true`; both mean "clear". A string is parsed as comma-separated paths.
      task.expected_files = parseExpectedFiles(opts['expected-files']);
      updatedFields.push(`expected_files: [${task.expected_files.join(', ')}]`);
    }

    if (opts.deps !== undefined) {
      // parseOptions collapses `--deps` (no value) and `--deps ""` to `true`
      // because of the falsy-next-arg shortcut. Treat both as "clear".
      let newDeps;
      if (opts.deps === true || opts.deps === '') {
        newDeps = [];
      } else if (typeof opts.deps === 'string') {
        newDeps = opts.deps.split(',').map(d => d.trim()).filter(Boolean);
      } else {
        console.error('❌ --deps requires a value. Usage: --deps t1,t2  (or omit value to clear)');
        exitFail(1);
      }
      const validIds = new Set(data.tasks.map(t => t.id));
      for (const dep of newDeps) {
        if (dep === id) {
          console.error(`❌ Self-dependency rejected: task "${id}" cannot depend on itself.`);
          exitFail(1);
        }
        if (!validIds.has(dep)) {
          console.error(`❌ Unknown dependency: "${dep}" does not exist.`);
          exitFail(1);
        }
      }
      task.depends_on = newDeps;
      updatedFields.push(`depends_on: [${newDeps.join(', ')}]`);
    }

    if (!rawStatus) return data;

    newStatus = STATUS_ALIASES[rawStatus] || rawStatus;
    if (!Object.values(TASK_STATES).includes(newStatus)) {
      console.error(`❌ Invalid status: "${rawStatus}". Valid: ${Object.values(TASK_STATES).join(', ')}`);
      exitFail(1);
    }

    oldStatus = task.status;
    task.status = newStatus;
    if (newStatus === TASK_STATES.COMPLETED) task.completed_at = new Date().toISOString();
    if (newStatus === TASK_STATES.RUNNING) task.started_at = new Date().toISOString();
    if (newStatus === TASK_STATES.FAILED) {
      task.failed_at = new Date().toISOString();
      if (opts['error-msg']) task.error_message = opts['error-msg'];
    }
    return data;
  });

  if (!rawStatus) {
    console.log(`✅ Task "${id}" ${updatedFields.join(', ')}`);
    return;
  }

  // Actual token usage (optional). When the orchestrator reports real counts
  // via --tokens-in/--tokens-out, record the measured cost tagged
  // cost_source:'actual' so computeTokenActuals() learns from ground truth.
  // Without them the metric falls back to the estimate (cost_source:'estimated'),
  // which is excluded from actuals to avoid the circular estimate→actual loop.
  const _tokensIn = opts['tokens-in'] != null ? Number(opts['tokens-in']) : NaN;
  const _tokensOut = opts['tokens-out'] != null ? Number(opts['tokens-out']) : NaN;
  const _hasActuals = Number.isFinite(_tokensIn) && Number.isFinite(_tokensOut) && _tokensIn >= 0 && _tokensOut >= 0;
  const _metricModel = taskRef._assigned_model || 'sonnet';
  const _actualCost = _hasActuals ? costFromTokens(_metricModel, _tokensIn, _tokensOut) : null;
  const _costFields = {
    cost_usd: _hasActuals ? _actualCost : (taskRef._estimated_cost || 0),
    cost_source: _hasActuals ? 'actual' : 'estimated',
    actual_cost_usd: _actualCost,
    estimated_cost_usd: taskRef._estimated_cost ?? null,
    tokens_in: _hasActuals ? _tokensIn : null,
    tokens_out: _hasActuals ? _tokensOut : null,
  };

  emitHook('task:post-update', { project, taskId: id, from: oldStatus, to: newStatus });

  if (newStatus === TASK_STATES.COMPLETED) {
    const manifest = readJSON(manifestPath(project));
    const phase = PHASES.find(p => p.id === manifest?.current_phase);
    const sha = opts['no-commit'] !== undefined
      ? null
      : gitAutoCommit(project, taskRef, phase?.name || 'unknown');
    if (sha) {
      modifyJSON(tasksPath(project), (d) => {
        const t = d.tasks.find(x => x.id === id);
        if (t) t.commit_sha = sha;
        return d;
      });
      console.log(`  ${C.dim}📎 commit: ${sha.slice(0, 8)}${C.reset}`);
    }
    if (taskRef.started_at) {
      appendMetric({
        type: 'task_complete', project, taskId: id, taskName: taskRef.name,
        role: taskRef.role || 'executor',
        model: taskRef._assigned_model || 'sonnet',
        size: taskRef.size || 'medium',
        strategy: taskRef.strategy || null,
        ..._costFields,
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
  }

  if (newStatus === TASK_STATES.FAILED) {
    updateCircuitBreaker(project, true);

    if (opts.rollback !== 'false' && taskRef.commit_sha) {
      const rolled = gitRollbackTask(taskRef);
      if (rolled) console.log(`  ${C.dim}🔄 rolled back to ${taskRef.commit_sha.slice(0, 8)}${C.reset}`);
    }

    let _retryCount = taskRef.retry_count || 0;
    if (opts.retry !== 'false') {
      const retry = scheduleRetry(project, id);
      _retryCount = retry.retry_count;
      if (!retry.scheduled) {
        // Retry exhausted — mark dependent tasks as blocked
        modifyJSON(tasksPath(project), (d) => {
          for (const t of d.tasks) {
            if (t.depends_on?.includes(id) && t.status === TASK_STATES.PENDING) {
              t.blocked_by = id;
              console.log(`  ${C.yellow}⚠ ${t.id} blocked by failed ${id}${C.reset}`);
            }
          }
          return d;
        });
      }
    }

    if (taskRef.started_at) {
      appendMetric({
        type: 'task_failed', project, taskId: id, taskName: taskRef.name,
        role: taskRef.role || 'executor',
        model: taskRef._assigned_model || 'sonnet',
        size: taskRef.size || 'medium',
        strategy: taskRef.strategy || null,
        ..._costFields,
        quality_score: taskRef.score != null ? taskRef.score : 0,
        success: false,
        retry_count: _retryCount,
        failure_reason: opts?.reason || 'unknown',
        routing_decision_id: taskRef._routing_decision_id || null,
        correlation_id: taskRef._routing_decision_id || generateCorrelationId(),
        duration_ms: new Date(taskRef.failed_at || new Date()) - new Date(taskRef.started_at),
        timestamp: taskRef.failed_at || new Date().toISOString(),
      });
    }
  }

  if (newStatus === TASK_STATES.COMPLETED) {
    updateCircuitBreaker(project, false);

    const currentData = readJSON(tasksPath(project));
    const allTasks = currentData.tasks;
    const completedCount = allTasks.filter(t => t.status === TASK_STATES.COMPLETED).length;
    const failedCount = allTasks.filter(t => t.status === TASK_STATES.FAILED).length;
    if (completedCount + failedCount === allTasks.length && allTasks.length > 0) {
      const durations = allTasks
        .filter(t => t.started_at && t.completed_at)
        .map(t => new Date(t.completed_at) - new Date(t.started_at));
      const scores = allTasks.filter(t => t.score != null).map(t => t.score);
      appendMetric({
        type: 'run_complete', project, task_count: allTasks.length,
        completed: completedCount, failed: failedCount,
        total_duration_ms: durations.reduce((a, b) => a + b, 0),
        avg_quality_score: scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : null,
        timestamp: new Date().toISOString(),
      });
    }
  }

  console.log(`✅ Task "${id}" → ${newStatus}`);
}

export function taskReopen(project, args) {
  const { opts, positional } = parseOptions(args);
  const id = positional[0];
  const reason = opts.reason;

  if (!id || !reason || typeof reason !== 'string' || !reason.trim()) {
    console.error('Usage: x-build tasks reopen <task-id> --reason "<why>" [--cascade]');
    console.error('       Reopen completed/failed/cancelled task back to pending.');
    exitFail(1);
  }

  const REOPENABLE = new Set([TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED]);
  const reopened = [];
  const skipped = [];

  modifyJSON(tasksPath(project), (data) => {
    if (!data?.tasks?.length) { console.error('❌ No tasks data found.'); exitFail(1); }
    const root = data.tasks.find(t => t.id === id);
    if (!root) { console.error(`❌ ${E('task-not-found', { id })}`); exitFail(1); }
    if (!REOPENABLE.has(root.status)) {
      console.error(`❌ Cannot reopen "${id}" — current status "${root.status}". Only completed/failed/cancelled can be reopened.`);
      exitFail(1);
    }

    // Collect targets: root + transitive dependents if --cascade
    const targets = new Set([id]);
    if (opts.cascade !== undefined) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of data.tasks) {
          if (!targets.has(t.id) && t.depends_on?.some(d => targets.has(d))) {
            targets.add(t.id);
            changed = true;
          }
        }
      }
    }

    for (const t of data.tasks) {
      if (!targets.has(t.id)) continue;
      if (!REOPENABLE.has(t.status)) { skipped.push({ id: t.id, status: t.status }); continue; }

      const fromStatus = t.status;
      t.reopen_history = t.reopen_history || [];
      t.reopen_history.push({
        at: new Date().toISOString(),
        reason: reason.trim(),
        from_status: fromStatus,
      });

      t.status = TASK_STATES.PENDING;
      delete t.completed_at;
      delete t.failed_at;
      delete t.error_message;
      delete t.blocked_by;
      delete t.next_retry_at;

      reopened.push({ id: t.id, name: t.name, from: fromStatus });
    }

    return data;
  });

  if (reopened.length === 0) {
    console.log(`⚠ Nothing reopened.`);
    return;
  }

  for (const r of reopened) {
    emitHook('task:post-update', { project, taskId: r.id, from: r.from, to: TASK_STATES.PENDING });
    console.log(`✅ Reopened ${r.id} (${r.from} → pending): ${r.name}`);
  }
  if (skipped.length) {
    for (const s of skipped) {
      console.log(`  ${C.dim}↳ ${s.id} skipped (status: ${s.status})${C.reset}`);
    }
  }
  console.log(`  ${C.dim}reason: ${reason.trim()}${C.reset}`);

  // Audit trail in decisions log
  addDecision(project, {
    type: 'reopen',
    title: `Reopened ${reopened.map(r => r.id).join(', ')}`,
    rationale: reason.trim(),
    phase: 'execute',
  });
}

// ── DAG & Steps ─────────────────────────────────────────────────────

export function computeSteps(tasks) {
  if (tasks.length === 0) return [];

  const adj = new Map();
  const indegree = new Map();
  const taskMap = new Map();

  for (const t of tasks) {
    adj.set(t.id, []);
    indegree.set(t.id, 0);
    taskMap.set(t.id, t);
  }

  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!adj.has(dep)) continue;
      adj.get(dep).push(t.id);
      indegree.set(t.id, indegree.get(t.id) + 1);
    }
  }

  const steps = [];
  const remaining = new Set(tasks.map(t => t.id));
  let stepNum = 1;

  while (remaining.size > 0) {
    const ready = [];
    for (const id of remaining) {
      if (indegree.get(id) === 0) ready.push(id);
    }

    if (ready.length === 0) {
      const cycleNodes = [...remaining].join(', ');
      throw new Error(`Circular dependency detected among: ${cycleNodes}`);
    }

    steps.push({
      id: stepNum,
      tasks: ready,
      status: 'pending',
    });

    for (const id of ready) {
      remaining.delete(id);
      for (const succ of adj.get(id)) {
        indegree.set(succ, indegree.get(succ) - 1);
      }
    }

    stepNum++;
  }

  return steps;
}

export function cmdSteps(args) {
  const sub = args[0];
  if (!sub || !['compute', 'status', 'next'].includes(sub)) {
    console.error('Usage: x-build steps <compute|status|next> [project]');
    exitFail(1);
  }

  const project = resolveProject(args[1] || null, { autoInit: true });

  if (sub === 'compute') return stepsCompute(project);
  if (sub === 'status') return stepsStatus(project);
  if (sub === 'next') return stepsNext(project);
}

export function stepsCompute(project) {
  const data = readJSON(tasksPath(project));
  if (!data?.tasks?.length) {
    console.error('❌ No tasks defined. Run: x-build tasks add <name>');
    exitFail(1);
  }

  try {
    const steps = computeSteps(data.tasks);
    writeJSON(stepsPath(project), { steps, computed_at: new Date().toISOString() });

    console.log(`✅ ${steps.length} steps computed from ${data.tasks.length} tasks:\n`);
    for (const step of steps) {
      const taskNames = step.tasks.map(id => {
        const t = data.tasks.find(t => t.id === id);
        return `${id}: ${t?.name || '?'}`;
      });
      console.log(`  🔹 Step ${step.id}: [${taskNames.join(', ')}]`);
    }
    console.log('');
  } catch (err) {
    console.error(`❌ ${err.message}`);
    exitFail(1);
  }
}

export function stepsStatus(project) {
  const stepData = readJSON(stepsPath(project));
  const taskData = readJSON(tasksPath(project));

  if (!stepData?.steps?.length) {
    console.log('No steps computed. Run: x-build steps compute');
    return;
  }

  console.log(`\n🔹 Steps (${stepData.steps.length}):\n`);

  for (const step of stepData.steps) {
    const taskDetails = step.tasks.map(id => {
      const t = taskData.tasks.find(t => t.id === id);
      const icon = {
        pending: '⬜', ready: '🟡', running: '🔵',
        completed: '✅', failed: '❌', cancelled: '⛔',
      }[t?.status || 'pending'];
      return `${icon} ${id}`;
    });

    const allDone = step.tasks.every(id => {
      const t = taskData.tasks.find(t => t.id === id);
      return t?.status === TASK_STATES.COMPLETED;
    });
    const anyRunning = step.tasks.some(id => {
      const t = taskData.tasks.find(t => t.id === id);
      return t?.status === TASK_STATES.RUNNING;
    });

    let stepIcon = '⬜';
    if (allDone) stepIcon = '✅';
    else if (anyRunning) stepIcon = '🔵';

    console.log(`  ${stepIcon} Step ${step.id}: ${taskDetails.join('  ')}`);
  }
  console.log('');
}

export function stepsNext(project) {
  const stepData = readJSON(stepsPath(project));
  const taskData = readJSON(tasksPath(project));

  if (!stepData?.steps?.length) {
    console.log('No steps computed. Run: x-build steps compute');
    return;
  }

  for (const step of stepData.steps) {
    const pendingTasks = step.tasks.filter(id => {
      const t = taskData.tasks.find(t => t.id === id);
      return t && [TASK_STATES.PENDING, TASK_STATES.READY].includes(t.status);
    });

    if (pendingTasks.length > 0) {
      for (const id of pendingTasks) {
        const t = taskData.tasks.find(t => t.id === id);
        if (t) t.status = TASK_STATES.READY;
      }
      writeJSON(tasksPath(project), taskData);

      console.log(`🔹 Step ${step.id} ready — ${pendingTasks.length} tasks:`);
      for (const id of pendingTasks) {
        const t = taskData.tasks.find(t => t.id === id);
        console.log(`  🟡 ${id}: ${t?.name}`);
      }
      return;
    }
  }

  console.log('✅ All steps completed.');
}

// ── Strategy Suggestion ────────────────────────────────────────────

const STRATEGY_KEYWORDS = [
  { pattern: /\b(review|audit|check|inspect)\b/i, strategy: 'review' },
  { pattern: /\b(design|plan|architect)\b/i, strategy: 'refine' },
  { pattern: /\b(compare|evaluate|versus|vs)\b/i, strategy: 'debate' },
  { pattern: /\b(investigate|analyze|debug|diagnose)\b/i, strategy: 'investigate' },
  { pattern: /\b(security|vulnerability|pentest|attack)\b/i, strategy: 'red-team' },
  { pattern: /\b(brainstorm|ideate|explore ideas)\b/i, strategy: 'brainstorm' },
];

function suggestStrategy(taskName) {
  for (const { pattern, strategy } of STRATEGY_KEYWORDS) {
    if (pattern.test(taskName)) return strategy;
  }
  return null;
}

function taskUpdateCommand(taskId, status) {
  return `xm build${XM_GLOBAL ? ' --global' : ''} tasks update ${taskId} --status ${status}`;
}

// ── Execution Engine ────────────────────────────────────────────────

function buildAgentPrompt(project, task, briefContent, decisionsContent, { manifest, taskData, stepData, worktree = false } = {}) {
  manifest = manifest || readJSON(manifestPath(project));
  const lines = [
    `## Task: ${task.name}`,
    `ID: ${task.id} | Size: ${task.size} | Project: ${manifest?.display_name || project}`,
    '',
  ];

  // Intent — what this task is and why it exists. Without this the executor sees
  // only the one-line name and has to guess the scope and intent.
  if (task.description) {
    lines.push('## Intent', task.description, '');
  }

  // Expand [R#] refs to the actual requirement text so the executor doesn't have
  // to open REQUIREMENTS.md to learn what "[R1]" means.
  const reqRefs = expandReqRefs(task.name, loadRequirementsMap(project));
  if (reqRefs.length) {
    lines.push('## Requirements');
    for (const r of reqRefs) lines.push(`- ${r}`);
    lines.push('');
  }

  // Done criteria — definition of done
  if (task.done_criteria?.length) {
    lines.push('## Definition of Done');
    for (const c of task.done_criteria) {
      lines.push(`- [ ] ${c}`);
    }
    lines.push('');
  }

  // Step progress context
  try {
    const steps = stepData || readJSON(stepsPath(project));
    if (steps?.steps?.length) {
      const stepIdx = steps.steps.findIndex(s => Array.isArray(s.tasks) && s.tasks.includes(task.id));
      if (stepIdx >= 0) {
        lines.push(`Step: ${stepIdx + 1}/${steps.steps.length}`, '');
      }
    }
  } catch { /* steps.json optional */ }

  if (briefContent) {
    lines.push('## Project Context', briefContent, '');
  }

  if (decisionsContent) {
    lines.push(decisionsContent, '');
  }

  if (task.depends_on?.length > 0) {
    const tasks = taskData || readJSON(tasksPath(project));
    lines.push('## Completed Dependencies');
    for (const depId of task.depends_on) {
      const dep = tasks?.tasks?.find(t => t.id === depId);
      if (dep) lines.push(`- ${dep.id}: ${dep.name} (${dep.status})`);
    }
    lines.push('');
  }

  if (task.template) {
    const templateFile = join(phaseDir(project, '02-plan'), `${task.template}.md`);
    if (existsSync(templateFile)) {
      lines.push('## Task Template', readMD(templateFile).slice(0, 1500), '');
    }
  }

  lines.push(
    '## Instructions',
    `Complete the task "${task.name}" as described above.`,
    'Follow existing code patterns and conventions.',
    'Write clean, tested code.',
    '',
  );

  if (worktree) {
    // Worktree tasks merge through a gk finish gate. Completion is marked by the
    // orchestrator ONLY after the gate passes — never by the agent (F1). Marking
    // it here would flip tasks.json to completed before the gate ran, and a gate
    // failure would leave a false "completed" that unblocks downstream tasks.
    lines.push(
      '## On Completion',
      'This task runs in a dedicated git worktree behind a merge gate.',
      'Do NOT mark the task complete or failed yourself — the orchestrator marks completion ONLY after `gk worktree finish` passes the gate.',
      'When your work is done and local quality checks pass, stop and report back; the orchestrator runs the finish/gate step.',
    );
  } else {
    lines.push(
      '## On Completion',
      `After completing this task, run: ${taskUpdateCommand(task.id, 'completed')}`,
      `If the task fails, run: ${taskUpdateCommand(task.id, 'failed')}`,
    );
  }

  return lines.join('\n');
}

// A task RUNNING longer than this (or RUNNING with no started_at — an orphan
// from a crashed/abandoned agent) is considered stale and reclaimable.
const DEFAULT_STALE_RUNNING_MS = 30 * 60 * 1000; // 30 min

// worktree_status values that mean "a human/orchestrator must act" — a stale
// RUNNING task carrying one of these is NOT an abandoned orphan, so it must be
// protected from the RUNNING→PENDING reconcile (plan "상태 모델": NEEDS_FIX/
// BLOCKED must not be reverted to a plain stale RUNNING).
// The tasks.mjs ↔ worktrees.mjs cycle was removed in t10 (worktrees.mjs no
// longer imports tasks.mjs — the shared utils moved to worktree-shared.mjs), so
// WORKTREE_STATUS is no longer at TDZ risk. The lazy init is kept as cheap
// defense-in-depth; it is only ever read at call time regardless.
let _reconcileProtected = null;
function reconcileProtectedWorktreeStatus() {
  if (!_reconcileProtected) {
    _reconcileProtected = new Set([
      WORKTREE_STATUS.NEEDS_FIX,
      WORKTREE_STATUS.BLOCKED,
      WORKTREE_STATUS.MERGING,
    ]);
  }
  return _reconcileProtected;
}

// Decide whether a stale RUNNING task should be reclaimed to PENDING, using its
// worktree artifact (run.json) as evidence. Reclaim only when there is no live
// worktree behind the RUNNING status:
//   - no run.json artifact        -> orphan from a crashed agent  -> reclaim
//   - artifact + worktree path gone -> worktree lost              -> reclaim
// Otherwise protect it (NEEDS_FIX/BLOCKED/MERGING, or an artifact whose worktree
// still exists) and surface the reason — never a silent exclusion.
// Returns { reconcile, reason, worktree_status }.
function classifyStaleRunning(project, task) {
  let run = null;
  try { run = readRun(project, task.id); } catch { run = null; }
  if (!run) return { reconcile: true, reason: 'no_worktree_artifact', worktree_status: null };
  const ws = run.worktree_status ?? null;
  // run.json exists but no worktree path (acquire never produced one — e.g. a
  // BLOCKED acquire) → there is nothing live behind the RUNNING status, so it is
  // reclaimable, not "active" (F8). Empty/whitespace strings count as absent.
  if (!run.worktree || (typeof run.worktree === 'string' && !run.worktree.trim())) {
    return { reconcile: true, reason: 'no_worktree_path', worktree_status: ws };
  }
  if (!existsSync(run.worktree)) {
    return { reconcile: true, reason: 'worktree_missing', worktree_status: ws };
  }
  const reason = ws && reconcileProtectedWorktreeStatus().has(ws)
    ? `worktree_status:${ws}`
    : `worktree_active:${ws ?? 'unknown'}`;
  return { reconcile: false, reason, worktree_status: ws };
}

// Reclaim stale RUNNING tasks back to PENDING so an interrupted session can
// resume. Explicit (run --reconcile) rather than automatic — RUNNING→PENDING is
// a state mutation, so it should be a deliberate recovery action.
// Returns { reclaimed, protected } — `protected` lists stale RUNNING tasks that
// were deliberately NOT reclaimed (with a reason), so exclusions stay visible.
// dryRun reports without writing.
function reconcileStaleRunning(project, { staleMs = DEFAULT_STALE_RUNNING_MS, dryRun = false } = {}) {
  const now = Date.now();
  const reclaimed = [];
  const protectedTasks = [];
  const isStale = (t) => {
    if (t.status !== TASK_STATES.RUNNING) return false;
    const age = t.started_at ? now - new Date(t.started_at).getTime() : Infinity;
    return age > staleMs;
  };

  // Partition stale RUNNING tasks into reclaimable vs protected up front so both
  // the dry-run and write paths share one decision (no drift between preview and
  // effect). classifyStaleRunning reads run.json, which is not mutated here.
  const data = readJSON(tasksPath(project));
  const decisions = new Map();
  for (const t of data?.tasks || []) {
    if (!isStale(t)) continue;
    const d = classifyStaleRunning(project, t);
    decisions.set(t.id, d);
    if (d.reconcile) reclaimed.push({ id: t.id, name: t.name, reason: d.reason });
    else protectedTasks.push({ id: t.id, name: t.name, reason: d.reason, worktree_status: d.worktree_status });
  }

  if (dryRun) return { reclaimed, protected: protectedTasks };

  modifyJSON(tasksPath(project), (fresh) => {
    if (!fresh?.tasks) return fresh;
    for (const t of fresh.tasks) {
      if (!isStale(t)) continue;
      const d = decisions.get(t.id) ?? classifyStaleRunning(project, t);
      if (!d.reconcile) continue;
      t.reopen_history = t.reopen_history || [];
      t.reopen_history.push({ at: new Date().toISOString(), reason: 'stale_running_reconciled', from_status: 'running' });
      t.status = TASK_STATES.PENDING;
      delete t.started_at;
      delete t._assigned_model;
      delete t._routing_decision_id;
      delete t._estimated_cost;
      delete t.next_retry_at;
    }
    return fresh;
  });
  return { reclaimed, protected: protectedTasks };
}

// Read every worktree run.json under a project and project the plan's
// worktree_tasks[] shape. Empty array when no artifacts exist (back-compat:
// callers keep their existing fields). Non-directory entries (preflight.json)
// and dirs without run.json are skipped via readRun returning null.
function collectWorktreeTasks(project) {
  const dir = worktreesDir(project);
  if (!existsSync(dir)) return [];
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return []; }
  for (const entry of entries) {
    let run = null;
    try { run = readRun(project, entry); } catch { run = null; }
    if (!run) continue;
    out.push({
      task_id: run.task_id ?? entry,
      branch: run.branch ?? null,
      worktree: run.worktree ?? null,
      worktree_status: run.worktree_status ?? null,
      task_status: run.task_status ?? null,
      gk_gate_run_id: run.gk_gate_run_id ?? null,
      last_error: run.last_error ?? null,
    });
  }
  return out;
}

// Mark ready tasks RUNNING and stamp routing/cost/start metadata, then persist.
// Shared by BOTH the human and --json paths: the skill spawns agents from the
// --json plan, so without marking here a later `tasks update completed` recorded
// no metric (the appendMetric guard needs started_at) or defaulted the model to
// sonnet (_assigned_model unset). Idempotent — tasks already RUNNING are skipped
// so a re-emitted plan does not restart the duration clock. readyTasks are live
// references into taskData, so the single writeJSON persists their mutations.
function markTasksRunning(taskData, readyTasks, sharedCfg, project, step) {
  let marked = 0;
  for (const task of readyTasks) {
    if (task.status === TASK_STATES.RUNNING) continue;
    const role = task.role || (task.size === 'large' ? 'deep-executor' : 'executor');
    const { model, correlationId } = getModelForRoleWithCorrelation(role, task.size, sharedCfg);
    task._assigned_model = model;
    task._routing_decision_id = correlationId;
    task._estimated_cost = estimateTaskCost(task, model).cost_usd;
    task.status = TASK_STATES.RUNNING;
    task.started_at = new Date().toISOString();
    marked++;
  }
  if (marked > 0) {
    writeJSON(tasksPath(project), taskData);
    emitHook('task:pre-update', { project, step, tasks: readyTasks.map((t) => t.id) });
  }
  return marked;
}

// Build one agent execution-plan entry (shared by the normal --json path and the
// worktree fan-out path so both emit an identical task schema). Model prefers the
// routing decision persisted by markTasksRunning (_assigned_model) so the emitted
// model matches the one recorded on completion.
function buildPlanEntry(project, task, { briefContent, decisionsContent, manifest, taskData, stepData, sharedCfg }, { worktree = false } = {}) {
  const role = task.role || (task.size === 'large' ? 'deep-executor' : 'executor');
  const model = task._assigned_model || getModelForRole(role, task.size, sharedCfg);
  const entry = {
    task_id: task.id,
    task_name: task.name,
    size: task.size,
    role,
    agent_type: role === 'deep-executor' || model === 'opus' ? 'deep-executor' : 'executor',
    model,
    prompt: buildAgentPrompt(project, task, briefContent, decisionsContent, { manifest, taskData, stepData, worktree }),
  };
  if (worktree) {
    // Worktree entries carry NO task-status mutation commands (F1): the gk finish
    // gate is the ONLY completion path (finishWorktrees ok → markTaskCompleted).
    entry.completion_note = 'Managed worktree task — do NOT self-mark complete/failed. The orchestrator marks completion only after the gk finish gate passes.';
  } else {
    entry.on_complete = taskUpdateCommand(task.id, 'completed');
    entry.on_fail = taskUpdateCommand(task.id, 'failed');
  }
  if (task.strategy) {
    entry.strategy = task.strategy;
    entry.strategy_hint = `Use /xm:op ${task.strategy} for this task`;
  } else {
    const suggested = suggestStrategy(task.name);
    if (suggested) entry.strategy_suggestion = suggested;
  }
  if (task.team) {
    entry.team = task.team;
    entry.team_hint = `Use /x-agent team assign ${task.team} "${task.name}"`;
  }
  return entry;
}

// Worktree fan-out — the Execute-phase backend (plan "실행 모드 결정"). Emits a
// machine-readable plan for the skill orchestrator. gk is NEVER auto-finished
// here: after agents complete + verify, the orchestrator calls
// `worktrees resume` / finishWorktrees (finish is serialized under the merge
// lock). Preflight-degraded or --dry-run emit the plan WITHOUT touching gk.
function runWorktreeMode(ctx) {
  const {
    project, currentStep, stepData, readyTasks, config, opts,
    budgetExceeded, worktreeSignal, planEntryCtx, taskData, sharedCfg,
  } = ctx;
  const dryRun = opts['dry-run'] !== undefined;
  const cwd = process.cwd();

  // Budget hard stop mirrors the normal path: no plan, exit 1.
  if (budgetExceeded) {
    console.log(JSON.stringify({
      project, step: currentStep.id, total_steps: stepData.steps.length,
      mode: 'worktree', tasks: [], blocked: true, blocked_reason: 'budget_exceeded',
      worktree_signal: worktreeSignal,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Capability preflight. Degraded (gk has no --gate) → manual handoff: emit the
  // plan (commands to run by hand) but never drive gk. dry-run doesn't depend on
  // the gate surface either, so both short-circuit before any gk execution.
  const preflight = config.preflight === false ? null : runPreflight({ project, cwd });
  const degraded = preflight ? preflight.degraded : false;

  // Feed existing local branches so planWorktrees's collision suffix (feat/x,
  // feat/x-2, …) actually avoids branches already on disk (F9/F11). spawnSync,
  // no shell.
  const existingBranches = listExistingBranches(cwd);
  const plan = planWorktrees({ project, tasks: readyTasks, config, existingBranches, degraded });
  plan.step = currentStep.id;
  plan.total_steps = stepData.steps.length;
  plan.worktree_signal = worktreeSignal;
  plan.preflight = preflight;

  if (dryRun || degraded) {
    // planWorktrees already set mode to 'manual-handoff' (degraded) or 'dry-run'.
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // Real fan-out: acquire the first parallel batch (bounded by max_parallel via
  // planWorktrees's batching). Each acquire inits run.json + drops the
  // TASK-CONTEXT snapshot. finish stays with the orchestrator.
  // Prefer the first parallel batch. When NO task is parallel-safe (batch empty)
  // but sequential tasks exist, fall back to acquiring the FIRST sequential task
  // alone (F4/F5) — otherwise a step made entirely of overlapping/unknown-file
  // tasks would acquire nothing and the pipeline would stall. Each subsequent
  // `run --worktrees` picks up the next sequential task once this one completes.
  let sequentialFallback = false;
  let selectedIds = plan.parallel_batches[0] || [];
  if (selectedIds.length === 0 && plan.sequential.length > 0) {
    selectedIds = [plan.sequential[0]];
    sequentialFallback = true;
  }
  const batchTasks = selectedIds.map((id) => readyTasks.find((t) => t.id === id)).filter(Boolean);
  // Use the branch planWorktrees computed (collision-adjusted) so acquire and the
  // emitted plan agree on the branch name.
  const branchByTask = new Map(plan.tasks.map((e) => [e.task_id, e.branch]));

  const agentEnv = buildAgentEnv(repoRoot());
  const acquireResults = batchTasks.map((task) => ({
    task,
    res: acquireWorktree({ project, task, config, branch: branchByTask.get(task.id) || null, cwd }),
  }));

  // Mark only the successfully-acquired tasks RUNNING (routing/cost/started_at)
  // so a later `tasks update completed` records a metric with the right model.
  const acquired = acquireResults.filter((a) => a.res.ok).map((a) => a.task);
  if (acquired.length) markTasksRunning(taskData, acquired, sharedCfg, project, currentStep.id);

  const entries = acquireResults.map(({ task, res }) => {
    const entry = buildPlanEntry(project, task, planEntryCtx, { worktree: true });
    entry.branch = res.branch;
    entry.worktree = res.worktree || null;
    entry.env = agentEnv;                       // root env injection (X_BUILD_ROOT/X_PANEL_ROOT/XM_ROOT)
    entry.acquired = res.ok;
    entry.worktree_status = res.ok ? WORKTREE_STATUS.WORKTREE_CREATED : WORKTREE_STATUS.BLOCKED;
    if (!res.ok) entry.acquire_error = res.error;
    return entry;
  });

  console.log(JSON.stringify({
    project,
    step: currentStep.id,
    total_steps: stepData.steps.length,
    mode: 'worktree',
    base: config.base,
    max_parallel: config.max_parallel,
    parallel: acquired.length > 1,
    sequential_fallback: sequentialFallback,
    degraded: false,
    worktree_signal: worktreeSignal,
    tasks: entries,
    batches: plan.parallel_batches,
    sequential: plan.sequential,
    // finish is NOT auto-run — the orchestrator drives it after agents complete.
    finish: {
      auto: false,
      hint: 'After agents complete + verify, run: xm build worktrees resume [task-id...] (orchestrator finishWorktrees). gk finish is serialized under the target merge lock.',
    },
  }, null, 2));
}

export function cmdRun(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const manifest = readJSON(manifestPath(project));
  if (!manifest) {
    console.error('❌ No project found. Run: x-build init <name>');
    exitFail(1);
  }

  // Recovery: reclaim stale RUNNING tasks. Runs before the phase/circuit gates
  // so a wedged session can be unstuck regardless of breaker state.
  if (opts.reconcile) {
    const staleMs = opts['stale-min'] != null ? Number(opts['stale-min']) * 60000 : DEFAULT_STALE_RUNNING_MS;
    const dryRun = opts['dry-run'] !== undefined;
    const { reclaimed, protected: protectedTasks } = reconcileStaleRunning(project, { staleMs, dryRun });
    if (opts.json) {
      console.log(JSON.stringify({
        project,
        reconciled: reclaimed.map((r) => r.id),
        count: reclaimed.length,
        // Stale RUNNING tasks deliberately kept (NEEDS_FIX/BLOCKED/MERGING or a
        // live worktree) — surfaced so the exclusion is never silent.
        protected: protectedTasks.map((p) => ({ id: p.id, reason: p.reason, worktree_status: p.worktree_status })),
        dry_run: dryRun,
      }, null, 2));
    } else {
      if (reclaimed.length) {
        console.log(`${C.yellow}🩹 ${dryRun ? 'Would reconcile' : 'Reconciled'} ${reclaimed.length} stale RUNNING task(s) → PENDING:${C.reset} ${reclaimed.map((r) => r.id).join(', ')}`);
      } else {
        console.log(`${C.green}✓ No stale RUNNING tasks to reconcile.${C.reset}`);
      }
      if (protectedTasks.length) {
        console.log(`${C.dim}🛡 Kept ${protectedTasks.length} stale RUNNING task(s) with active worktrees:${C.reset} ${protectedTasks.map((p) => `${p.id} (${p.worktree_status || p.reason})`).join(', ')}`);
      }
    }
    return;
  }

  const currentPhase = PHASES.find(p => p.id === manifest.current_phase);

  if (currentPhase?.name !== 'execute') {
    console.error(`❌ Cannot run — current phase is "${currentPhase?.label}", must be Execute.`);
    console.log(`\n  📍 Next steps:`);
    console.log(`     1. Review plan:   x-build plan-check`);
    console.log(`     2. Advance phase: x-build phase next`);
    console.log(`     3. Then run:      x-build run\n`);
    exitFail(1);
  }

  if (isCircuitOpen(project)) {
    console.error(`❌ Circuit breaker is OPEN. Wait for cooldown or reset manually.`);
    exitFail(1);
  }

  const taskData = readJSON(tasksPath(project));
  const stepData = readJSON(stepsPath(project));

  if (!stepData?.steps?.length) {
    console.error('❌ No steps computed. Run: x-build steps compute');
    exitFail(1);
  }

  let currentStep = null;
  for (const step of stepData.steps) {
    const hasPending = step.tasks.some(id => {
      const t = taskData.tasks.find(t => t.id === id);
      return t && ![TASK_STATES.COMPLETED, TASK_STATES.CANCELLED].includes(t.status);
    });
    if (hasPending) {
      currentStep = step;
      break;
    }
  }

  if (!currentStep) {
    if (opts.json) {
      console.log(JSON.stringify({ project, total_steps: stepData.steps.length, tasks: [], status: 'all_done' }, null, 2));
      return;
    }
    console.log('✅ All steps completed. Run: x-build phase next');
    return;
  }

  const readyTasks = [];
  for (const id of currentStep.tasks) {
    const t = taskData.tasks.find(t => t.id === id);
    if (t && [TASK_STATES.PENDING, TASK_STATES.READY].includes(t.status)) {
      if (t.next_retry_at && new Date(t.next_retry_at) > new Date()) {
        continue;
      }
      const depsOk = t.depends_on.every(depId => {
        const dep = taskData.tasks.find(d => d.id === depId);
        return dep?.status === TASK_STATES.COMPLETED;
      });
      if (depsOk) {
        t.status = TASK_STATES.READY;
        readyTasks.push(t);
      }
    }
  }
  writeJSON(tasksPath(project), taskData);

  if (readyTasks.length === 0) {
    if (opts.json) {
      const running = currentStep.tasks
        .map((id) => taskData.tasks.find((t) => t.id === id))
        .filter((t) => t && t.status === TASK_STATES.RUNNING)
        .map((t) => t.id);
      console.log(JSON.stringify({
        project, step: currentStep.id, total_steps: stepData.steps.length,
        tasks: [], status: running.length ? 'in_progress' : 'waiting', running,
      }, null, 2));
      return;
    }
    console.log(`⏳ No ready tasks in Step ${currentStep.id}. Some may be waiting for retries or dependencies.`);
    return;
  }

  // A real probe is about to be dispatched — now transition open→half-open.
  // Doing this only at dispatch (not at the gate) means a no-op run never
  // trips the breaker into half-open. No-op when the breaker isn't ready.
  beginHalfOpenProbe(project);

  // Generate context brief inline (avoid circular import with misc.mjs)
  const briefContent = (() => {
    try {
      const briefLines = [
        `# ${manifest.display_name || project} — Context Brief`,
        '',
        `**Phase:** ${currentPhase?.label || manifest.current_phase}`,
        '',
      ];
      if (taskData?.tasks?.length > 0) {
        const _done = taskData.tasks.filter(t => t.status === TASK_STATES.COMPLETED).length;
        briefLines.push(`## Tasks: ${_done}/${taskData.tasks.length} completed`, '');
      }
      return briefLines.join('\n');
    } catch { return ''; }
  })();

  const decisionsData = readJSON(decisionsPath(project));
  const decisionsContent = decisionsData?.decisions?.length
    ? '## Key Decisions\n' + decisionsData.decisions.slice(-5).map(d =>
        `- **${d.title}** (${d.phase}): ${d.rationale || ''}`
      ).join('\n')
    : '';

  // Cost + budget enforcement applies to BOTH the human-readable and --json
  // paths. The skill layer consumes --json to spawn agents, so the budget gate
  // must run here too — it previously guarded only the human path, letting
  // --json runs bypass the configured budget entirely.
  const sharedCfg = loadSharedConfig();
  const cost = readyTasks.reduce((sum, t) => {
    const role = t.role || (t.size === 'large' ? 'deep-executor' : 'executor');
    const model = getModelForRole(role, t.size, sharedCfg);
    return sum + estimateTaskCost(t, model).cost_usd;
  }, 0);
  const budgetStatus = checkBudget(cost);
  const budgetExceeded = !!(budgetStatus.budget && budgetStatus.level === 'exceeded');

  // Worktree execution-mode decision (plan "실행 모드 결정"). The recommendation
  // is COMPUTED, not asked: worktree fan-out is only worth it when ≥2 ready tasks
  // are parallel-safe (non-overlapping expected_files) AND config enables it. The
  // signal is emitted on run --json regardless of mode so the Execute phase gate
  // can suggest fan-out. Flags: --worktrees/--no-worktrees override config.enabled.
  const wtFlags = {};
  if (typeof opts.base === 'string') wtFlags.base = opts.base;
  if (opts['max-parallel'] != null && opts['max-parallel'] !== true) wtFlags.max_parallel = Number(opts['max-parallel']);
  if (typeof opts['branch-prefix'] === 'string') wtFlags.branch_prefix = opts['branch-prefix'];
  if (opts['no-worktrees'] !== undefined) wtFlags.enabled = false;
  else if (opts.worktrees !== undefined) wtFlags.enabled = true;
  const wtConfig = loadWorktreeConfig({ flags: wtFlags });
  const { safe: wtSafe, sequential: wtSeq } = isParallelSafe(readyTasks);
  const worktreeSignal = {
    enabled: wtConfig.enabled !== false,
    parallel_safe_count: wtSafe.length,
    sequential_count: wtSeq.length,
    recommend: (wtConfig.enabled !== false) && wtSafe.length >= 2,
  };

  const planEntryCtx = { briefContent, decisionsContent, manifest, taskData, stepData, sharedCfg };

  // Explicit --worktrees opt-in routes execution through the worktree backend
  // (dry-run/degraded emit a plan only; real mode acquires + fans out). --no-
  // worktrees stays on the normal path even when config enables worktrees.
  if (opts.worktrees !== undefined && opts['no-worktrees'] === undefined) {
    return runWorktreeMode({
      project, currentStep, stepData, readyTasks, config: wtConfig, opts,
      budgetExceeded, worktreeSignal, planEntryCtx, taskData, sharedCfg,
    });
  }

  if (opts.json) {
    // Mark RUNNING on the spawn path too (skip when over budget — plan is []),
    // so a later `tasks update completed` records a metric with the right model
    // and the budget rolling window sees real spend.
    if (!budgetExceeded) markTasksRunning(taskData, readyTasks, sharedCfg, project, currentStep.id);
    const plan = readyTasks.map(task => buildPlanEntry(project, task, planEntryCtx));

    const output = {
      project,
      step: currentStep.id,
      total_steps: stepData.steps.length,
      tasks: budgetExceeded ? [] : plan,
      parallel: !budgetExceeded && readyTasks.length > 1,
      estimated_cost_usd: Number(cost.toFixed(4)),
      worktree_signal: worktreeSignal,
    };
    if (budgetStatus.budget) {
      output.budget = {
        level: budgetStatus.level,
        projected_usd: Number(budgetStatus.projected.toFixed(4)),
        max_usd: budgetStatus.budget,
        pct: Number(budgetStatus.pct.toFixed(1)),
      };
    }
    if (budgetExceeded) {
      output.blocked = true;
      output.blocked_reason = 'budget_exceeded';
      process.exitCode = 1;
    }

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human-readable output (sharedCfg / cost / budgetStatus computed above).
  console.log(`\n${C.bold}🚀 Execution Plan — Step ${currentStep.id}/${stepData.steps.length}${C.reset}\n`);

  console.log(`  Tasks: ${readyTasks.length} (${readyTasks.length > 1 ? 'parallel' : 'sequential'})`);
  console.log(`  Estimated cost: ${C.yellow}$${cost.toFixed(3)}${C.reset}`);

  // Budget check before execution (budgetStatus computed above, shared with --json).
  if (budgetStatus.budget) {
    if (budgetStatus.level === 'exceeded') {
      console.log(`  ${C.red}Budget exceeded: $${budgetStatus.projected.toFixed(2)} / $${budgetStatus.budget} (${budgetStatus.pct.toFixed(0)}%)${C.reset}`);
      console.log(`  ${C.red}Set higher budget with: /xm config set budget '{"max_usd": N}'${C.reset}\n`);
      process.exitCode = 1; // align with the --json path; a hard budget stop must not exit 0
      return;
    } else if (budgetStatus.level === 'warning') {
      console.log(`  ${C.yellow}Budget warning: $${budgetStatus.projected.toFixed(2)} / $${budgetStatus.budget} (${budgetStatus.pct.toFixed(0)}%)${C.reset}`);
    }
  }
  console.log('');

  for (const task of readyTasks) {
    const role = task.role || (task.size === 'large' ? 'deep-executor' : 'executor');
    const model = getModelForRole(role, task.size, sharedCfg);
    const strategyTag = task.strategy ? ` ${C.yellow}[${task.strategy}]${C.reset}` : '';
    const teamTag = task.team ? ` ${C.cyan}[team:${task.team}]${C.reset}` : '';
    console.log(`  🔹 ${C.bold}${task.id}${C.reset}: ${task.name} → ${C.cyan}${role} (${model})${C.reset}${strategyTag}${teamTag}`);
  }

  const allTasks = taskData.tasks;
  const doneCount = allTasks.filter(t => t.status === TASK_STATES.COMPLETED).length;
  const totalCount = allTasks.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  console.log(`\n  📊 Progress: ${doneCount}/${totalCount} tasks (${pct}%) | Step ${currentStep.id}/${stepData.steps.length}`);
  console.log(`${C.dim}  To execute, the /x-build skill will spawn agents for each task.${C.reset}`);
  console.log(`${C.dim}  Or run with --json for machine-readable output.${C.reset}\n`);

  const _marked = markTasksRunning(taskData, readyTasks, sharedCfg, project, currentStep.id);

  console.log(`${C.green}✅ ${_marked} tasks marked as RUNNING.${C.reset}`);
}

export function cmdRunStatus(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const taskData = readJSON(tasksPath(project));
  const stepData = readJSON(stepsPath(project));

  if (!stepData?.steps?.length) {
    if (opts.json) { console.log(JSON.stringify({ project, steps: [], all_done: false, error: 'no_steps', next_action: 'steps compute' }, null, 2)); return; }
    console.log('No steps. Run: x-build steps compute');
    return;
  }

  // Structured status so the skill orchestrator can route deterministically
  // instead of scraping ANSI/emoji text.
  if (opts.json) {
    const now = Date.now();
    const stepsOut = [];
    const blocked = [];
    const staleRunning = [];
    let currentStepId = null;
    let allDone = true;
    for (const step of stepData.steps) {
      const tasks = step.tasks.map((id) => taskData.tasks.find((t) => t.id === id)).filter(Boolean);
      const count = (st) => tasks.filter((t) => t.status === st).length;
      const completed = count(TASK_STATES.COMPLETED);
      const running = count(TASK_STATES.RUNNING);
      const failed = count(TASK_STATES.FAILED);
      const pending = tasks.length - completed - running - failed;
      stepsOut.push({ id: step.id, total: tasks.length, completed, running, failed, pending });
      if (completed < tasks.length) { allDone = false; if (currentStepId === null) currentStepId = step.id; }
      for (const t of tasks) {
        if (t.blocked_by) blocked.push({ id: t.id, blocked_by: t.blocked_by });
        if (t.status === TASK_STATES.RUNNING) {
          const age = t.started_at ? now - new Date(t.started_at).getTime() : Infinity;
          // Only count as stale/reclaimable when the worktree artifact agrees:
          // NEEDS_FIX/BLOCKED/MERGING or a live worktree must not read as an
          // orphan RUNNING (which would advise `run --reconcile`).
          if (age > DEFAULT_STALE_RUNNING_MS && classifyStaleRunning(project, t).reconcile) staleRunning.push(t.id);
        }
      }
    }
    // Expose worktree artifacts (empty when none — existing fields unchanged).
    const worktreeTasks = collectWorktreeTasks(project);
    const needsAttention = worktreeTasks.filter(
      (w) => w.worktree_status === WORKTREE_STATUS.NEEDS_FIX || w.worktree_status === WORKTREE_STATUS.BLOCKED,
    );
    const cb = getCircuitState(project);
    let next_action;
    if (allDone) next_action = 'phase next';
    else if (cb.state === 'open') next_action = 'wait for circuit breaker cooldown';
    else if (staleRunning.length) next_action = 'run --reconcile';
    else if (needsAttention.length) next_action = `worktrees resume or resolve NEEDS_FIX/BLOCKED worktrees: ${needsAttention.map((w) => w.task_id).join(', ')}`;
    else if (stepsOut.some((s) => s.running > 0)) next_action = 'wait for running tasks; poll run-status --json';
    else if (blocked.length || stepsOut.some((s) => s.failed > 0)) next_action = 'investigate failed/blocked tasks';
    else next_action = 'run --json';
    console.log(JSON.stringify({
      project, step: currentStepId, total_steps: stepData.steps.length,
      all_done: allDone, steps: stepsOut, blocked_tasks: blocked, stale_running: staleRunning,
      worktree_tasks: worktreeTasks,
      circuit_breaker: { state: cb.state, cooldown_until: cb.cooldown_until || null },
      next_action,
    }, null, 2));
    return;
  }

  console.log(`\n${C.bold}🚀 Execution Status${C.reset}\n`);

  let allDone = true;
  for (const step of stepData.steps) {
    const tasks = step.tasks.map(id => taskData.tasks.find(t => t.id === id)).filter(Boolean);
    const completed = tasks.filter(t => t.status === TASK_STATES.COMPLETED).length;
    const running = tasks.filter(t => t.status === TASK_STATES.RUNNING).length;
    const failed = tasks.filter(t => t.status === TASK_STATES.FAILED).length;

    let icon = '⬜';
    if (completed === tasks.length) icon = '✅';
    else if (running > 0) icon = '🔵';
    else if (failed > 0) icon = '❌';

    if (completed < tasks.length) allDone = false;

    console.log(`  ${icon} Step ${step.id}: ${renderBar(completed, tasks.length, 12)}${failed ? ` ${C.red}${failed} failed${C.reset}` : ''}${running ? ` ${C.blue}${running} running${C.reset}` : ''}`);

    for (const t of tasks) {
      const tIcon = { completed: '✅', failed: '❌', running: '🔵', pending: '⬜', ready: '🟡' }[t.status] || '⬜';
      const dur = t.started_at
        ? ` ${C.dim}${fmtDuration((t.completed_at ? new Date(t.completed_at) : new Date()) - new Date(t.started_at))}${C.reset}`
        : '';
      const retry = t.retry_count ? ` ${C.yellow}(retry ${t.retry_count})${C.reset}` : '';
      console.log(`    ${tIcon} ${t.id}: ${t.name}${dur}${retry}`);
    }
  }

  if (allDone) {
    console.log(`\n${C.green}${C.bold}✅ All steps completed! Run: x-build phase next${C.reset}`);
  }

  const cb = getCircuitState(project);
  if (cb.state !== 'closed') {
    console.log(`\n  ${C.red}⚡ Circuit breaker: ${cb.state.toUpperCase()}${C.reset}`);
    if (cb.cooldown_until) console.log(`  ${C.dim}Cooldown until: ${cb.cooldown_until}${C.reset}`);
  }

  console.log('');
}

// ── Interactive ─────────────────────────────────────────────────────

export async function interactiveTaskAdd(rl, project) {
  const name = await ask(rl, '  태스크 이름: ');
  if (!name.trim()) { console.log('  ⚠ 이름이 비어있습니다.'); return; }

  const depsInput = await ask(rl, '  의존성 (예: t1,t2, 없으면 Enter): ');
  const deps = depsInput.trim() ? depsInput.trim().split(',').map(d => d.trim()) : [];

  const sizeChoice = await pickMenu(rl, '  태스크 크기:', [
    { label: 'Small', value: 'small' },
    { label: 'Medium', value: 'medium' },
    { label: 'Large', value: 'large' },
  ]);
  const size = sizeChoice?.value || 'medium';

  const args = [name.trim()];
  if (deps.length) args.push('--deps', deps.join(','));
  args.push('--size', size);
  taskAdd(project, args);
}

export async function interactiveTaskUpdate(rl, project) {
  const data = readJSON(tasksPath(project));
  if (!data?.tasks?.length) { console.log('  태스크가 없습니다.'); return; }

  taskList(project);

  const id = await ask(rl, '  변경할 태스크 ID (예: t1): ');
  if (!id.trim()) return;

  const statusChoice = await pickMenu(rl, '  새 상태:', [
    { label: '🟡 Ready', value: 'ready' },
    { label: '🔵 Running', value: 'running' },
    { label: '✅ Completed', value: 'completed' },
    { label: '❌ Failed', value: 'failed' },
  ]);
  if (!statusChoice) return;

  taskUpdate(project, [id.trim(), '--status', statusChoice.value]);
}

export async function interactiveTasksAdd() {
  const project = resolveProject(null);
  const rl = createRL();
  try {
    let adding = true;
    while (adding) {
      await interactiveTaskAdd(rl, project);
      const more = await ask(rl, '\n  태스크 더 추가? (y/N): ');
      if (more.trim().toLowerCase() !== 'y') adding = false;
    }
  } finally {
    rl.close();
  }
}
