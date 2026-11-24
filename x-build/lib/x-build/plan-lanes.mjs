/** Lane mode of `xm build progress`: each task of a multi-task step runs in its own git worktree, and the root merges the lanes one at a time. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exitFail, modifyJSON } from './core.mjs';
import {
  VERIFY_FAILED, fail, gitHead, hashFiles, loadSession, ownCommands, readProgress, recordVerification,
  requireExecutable, requireTask, runCommand, stateForPlan, taskHash, writeTasks,
} from './plan-progress.mjs';

const LANE_STATES = ['in_progress', 'lane_verified', 'merge_conflict'];

// Index of the step that runs the task in a lane, or -1.
function laneStep(plan, taskId) {
  if (plan.execution?.lanes !== true) return -1;
  const index = plan.steps.findIndex((step) => step.includes(taskId));
  return index >= 0 && plan.steps[index].length > 1 ? index : -1;
}

// A merged lane task is a root task from then on: start and verify run in the root.
export function isLaneTask(plan, task, record) {
  return laneStep(plan, task.id) >= 0 && !record?.lane?.merged_at;
}

function laneBranch(session, task) {
  return 'xm-lane/' + session.runId + '/' + task.id;
}

function progressCommand(session, sub, task) {
  return 'xm build progress ' + sub + ' --plan ' + session.runId + ' --task ' + task.id;
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function gitOut(cwd, args) {
  const result = git(cwd, args);
  if (result.error || result.status !== 0) return fail('`git ' + args.join(' ') + '` failed in ' + cwd + ': ' + String(result.stderr || result.error?.message || '').trim());
  return result.stdout;
}

function parseEnvelope(result) {
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

// git-kit is resolved as batch.mjs does: X_BUILD_GK_ARGV (a JSON argv) or `git-kit`.
function gk(cwd, args) {
  let command;
  try { command = process.env.X_BUILD_GK_ARGV ? JSON.parse(process.env.X_BUILD_GK_ARGV) : ['git-kit']; } catch (error) { return fail('X_BUILD_GK_ARGV is not valid JSON: ' + error.message); }
  if (!Array.isArray(command) || !command.length || !command.every((item) => typeof item === 'string')) fail('X_BUILD_GK_ARGV must be a non-empty JSON string array');
  const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd, encoding: 'utf8', env: { ...process.env, GK_AGENT: '1' } });
  const envelope = result.error ? null : parseEnvelope(result);
  const message = result.error?.message || envelope?.error?.message
    || (envelope ? 'state ' + envelope.state : 'no agent envelope: ' + String(result.stderr || result.stdout || '').trim().slice(-300));
  return { ok: envelope?.state === 'ok', envelope, message, status: result.status };
}

// Paths with uncommitted changes. -z keeps paths unquoted and lists both sides of a rename;
// --untracked-files=all names each new file instead of its directory.
function changedPaths(cwd, { untracked }) {
  const entries = gitOut(cwd, ['status', '--porcelain=v1', '-z', untracked ? '--untracked-files=all' : '--untracked-files=no']).split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(entries[++i]);
  }
  return [...new Set(paths)];
}

function rootTrackedChanges(root) {
  return changedPaths(root, { untracked: false }).filter((path) => path !== '.xm' && !path.startsWith('.xm/'));
}

function hasMergeHead(root) {
  return git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;
}

// git-kit commit lints the message: a Conventional Commits header of at most 72 characters.
// The task title is shortened to fit, and the task id is always kept.
const COMMIT_HEADER_MAX = 72;
function laneCommitMessage(task) {
  const prefix = 'chore(lane): ';
  const suffix = ' (' + task.id + ')';
  const room = COMMIT_HEADER_MAX - prefix.length - suffix.length;
  const title = task.title.length > room ? task.title.slice(0, Math.max(room - 3, 0)).trimEnd() + '...' : task.title;
  return prefix + title + suffix;
}

function rootBranch(root) {
  const name = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim();
  return name && name !== 'HEAD' ? name : gitHead(root);
}

export async function startLane(session, task, json) {
  const records = readProgress(session).tasks;
  const stepIndex = laneStep(session.plan, task.id);
  const open = session.plan.steps.slice(0, stepIndex).flat()
    .filter((id) => stateForPlan(records, session.plan.tasks.find((item) => item.id === id)) !== 'verified');
  if (open.length) fail('lane task ' + task.id + ' cannot start: ' + open.join(', ') + ' of an earlier step ' + (open.length > 1 ? 'are' : 'is') + ' not verified; a lane branches from the commit that holds their work, so verify them first');
  if (gitOut(session.root, ['ls-files', '--', '.xm']).trim()) fail('lane task ' + task.id + ' cannot start: .xm/ is tracked by git in ' + session.root + '; lanes keep progress in the untracked .xm/ of the root. Untrack it (`git rm -r --cached .xm` and add .xm/ to .gitignore) first');
  const dirty = rootTrackedChanges(session.root);
  if (dirty.length) fail('lane task ' + task.id + ' cannot start: the repository root has uncommitted changes to ' + dirty.join(', ') + '; lanes branch from HEAD, so commit them first');

  const head = gitHead(session.root);
  let base;
  // Every lane of a step branches from the same commit: the root HEAD when the first lane started.
  modifyJSON(session.progressPath, (data) => {
    const next = data && data.tasks ? data : { schema_version: 1, plan_id: session.runId, tasks: {} };
    next.step_bases = next.step_bases || {};
    if (!next.step_bases[stepIndex]) next.step_bases[stepIndex] = head;
    base = next.step_bases[stepIndex];
    return next;
  });
  const branch = laneBranch(session, task);
  const acquired = gk(session.root, ['worktree', 'acquire', branch, '--from', base, '--json']);
  const reported = acquired.envelope?.result?.path;
  if (!acquired.ok || !reported) fail('`git-kit worktree acquire ' + branch + '` failed: ' + (acquired.ok ? 'no worktree path in the result' : acquired.message));
  const path = existsSync(resolve(reported)) ? realpathSync(resolve(reported)) : resolve(reported);
  const hashedNow = hashFiles(path, task.expected_files);
  modifyJSON(session.progressPath, (data) => {
    const tracked = data.tasks[task.id]?.baseline_files || {};
    data.tasks[task.id] = {
      task_hash: taskHash(task), state: 'in_progress', started_at: new Date().toISOString(),
      baseline_head: base, baseline_files: Object.fromEntries(task.expected_files.map((file) => [file, file in tracked ? tracked[file] : hashedNow[file]])),
      lane: { branch, path, base },
    };
    return data;
  });
  writeTasks(session);
  const own = ownCommands(task);
  if (json) {
    console.log(JSON.stringify({ status: 'started', plan_id: session.runId, task: task.id, lane_path: path, lane_branch: branch, base, verify_commands: own }, null, 2));
    return;
  }
  console.log('Started ' + task.id + ' ' + task.title + ' in lane ' + path);
  console.log('  branch ' + branch + ' from ' + base.slice(0, 12) + '. Edit only files in the lane.');
  console.log('verify will run in the lane:');
  for (const command of own) console.log('  ' + command);
  console.log('then `' + progressCommand(session, 'merge', task) + '` merges it into the root.');
}

export function verifyLane(session, task, record, json) {
  if (!record || !LANE_STATES.includes(record.state) || !record.lane) fail('task ' + task.id + ' has no lane record; run `' + progressCommand(session, 'start', task) + '` first');
  if (record.task_hash !== taskHash(task)) fail('plan task ' + task.id + ' changed since start; run `xm build progress start` again');
  const path = record.lane.path;
  if (!existsSync(path)) fail('lane worktree of ' + task.id + ' not found at ' + path + '; run `' + progressCommand(session, 'start', task) + '` to acquire it again');
  const current = hashFiles(path, task.expected_files);
  if (!task.expected_files.some((file) => current[file] !== record.baseline_files[file])) fail('no expected file changed in lane ' + path + ' since start of ' + task.id);
  for (const command of ownCommands(task)) {
    const result = runCommand(session, command, path);
    if (result.status === 0 && !result.error) continue;
    const exit = result.status ?? (result.error?.code || result.signal || 'unknown');
    // A lane that fails its commands is not ready to merge, whatever it passed before.
    modifyJSON(session.progressPath, (data) => {
      data.tasks[task.id] = { ...data.tasks[task.id], state: 'in_progress' };
      return data;
    });
    writeTasks(session);
    if (json) console.log(JSON.stringify({ status: 'failed', plan_id: session.runId, task: task.id, failed_command: command, exit_code: exit, scope: 'task', lane_path: path }, null, 2));
    else console.error('verification failed for ' + task.id + ' in lane ' + path + ': `' + command + '` exited with ' + exit);
    return exitFail(VERIFY_FAILED, 'verification failed');
  }
  modifyJSON(session.progressPath, (data) => {
    data.tasks[task.id] = { ...data.tasks[task.id], state: 'lane_verified', lane_verified_at: new Date().toISOString(), lane_verified_files: current };
    return data;
  });
  writeTasks(session);
  const next = progressCommand(session, 'merge', task);
  if (json) console.log(JSON.stringify({ status: 'lane_verified', plan_id: session.runId, task: task.id, lane_path: path, next }, null, 2));
  else {
    console.log('Lane verified ' + task.id + ' ' + task.title);
    console.log('  merge it into the root with `' + next + '`');
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Two merges at once would interleave in the root's index and working tree, so the root merges
// one lane at a time. The lock holds the pid: a lock whose process has died is taken over.
// fail() ends the process, so the lock is also released from an exit handler.
function takeMergeLock(session) {
  const path = join(session.dir, 'merge.lock');
  const take = () => {
    try { writeFileSync(path, String(process.pid), { flag: 'wx' }); return true; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  };
  if (!take()) {
    let holder = null;
    try { holder = Number.parseInt(readFileSync(path, 'utf8'), 10); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pidAlive(holder)) fail('another `xm build progress merge` holds ' + path + ' (pid ' + holder + '); wait for it to finish, then run merge again');
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!take()) fail('another `xm build progress merge` took ' + path + ' while its stale lock was replaced; run merge again');
  }
  const release = () => {
    try {
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('could not remove ' + path + ': ' + error.message);
    }
  };
  process.once('exit', release);
  return release;
}

export async function cmdMerge(args, json) {
  const session = await loadSession(args);
  requireExecutable(session);
  const task = requireTask(session, args);
  const records = readProgress(session).tasks;
  const record = records[task.id];
  if (laneStep(session.plan, task.id) < 0) fail('task ' + task.id + ' is not a lane task: merge applies to a task of a multi-task step in a plan with execution.lanes');
  if (record?.lane?.merged_at) fail('the lane of ' + task.id + ' was merged at ' + record.lane.merged_at + '; verify it in the root with `' + progressCommand(session, 'verify', task) + '`');
  if (!record || record.task_hash !== taskHash(task)) fail('task ' + task.id + ' has no record for the plan as it is now; run `' + progressCommand(session, 'start', task) + '` first');
  if (record.state !== 'lane_verified') fail('task ' + task.id + ' is ' + record.state + ', not lane_verified; run `' + progressCommand(session, 'verify', task) + '` first');
  const open = session.plan.tasks.filter((dep) => task.depends_on.includes(dep.id) && stateForPlan(records, dep) !== 'verified').map((dep) => dep.id);
  if (open.length) fail('task ' + task.id + ' depends on ' + open.join(', ') + ', not verified yet; merge and verify ' + open.join(', ') + ' first');
  const release = takeMergeLock(session);
  try {
    mergeLane(session, task, record, json);
  } finally {
    release();
  }
}

// Ends a merge this command started. When the abort fails, the root keeps the merge, and the
// caller is told so instead of being told the root is restored.
function abortMerge(session, before) {
  const aborted = gk(session.root, ['abort', '--yes', '--json']);
  // git-kit 0.166 prints no envelope when abort succeeds, so its exit status and the root's
  // MERGE_HEAD and HEAD decide whether the root is restored.
  const exited = aborted.ok || (!aborted.envelope && aborted.status === 0);
  if (!exited || hasMergeHead(session.root) || gitHead(session.root) !== before) {
    fail('`git-kit abort` did not restore the repository root (' + (exited ? 'MERGE_HEAD or HEAD still differs' : aborted.message) + '); the merge is still in progress there. Run `git-kit abort` in ' + session.root + ' and check `git status`');
  }
}

function mergeLane(session, task, record, json) {
  const { root } = session;
  const { branch, path } = record.lane;
  const again = progressCommand(session, 'merge', task);
  if (hasMergeHead(root)) fail('the repository root has a merge in progress (MERGE_HEAD); finish it with `git commit` or cancel it with `git-kit abort`, then run `' + again + '`');
  const dirty = rootTrackedChanges(root);
  if (dirty.length) fail('the repository root has uncommitted changes to ' + dirty.join(', ') + '; commit or stash them, then run `' + again + '`');
  if (!existsSync(path)) fail('lane worktree of ' + task.id + ' not found at ' + path);

  const before = gitHead(root);
  const uncommitted = changedPaths(path, { untracked: true });
  const laneTip = gitOut(path, ['rev-parse', 'HEAD']).trim();
  const mergeBase = gitOut(root, ['merge-base', before, laneTip]).trim();
  const committed = gitOut(root, ['diff', '--name-only', '-z', mergeBase, laneTip]).split('\0').filter(Boolean);
  const outside = [...new Set([...uncommitted, ...committed])].filter((file) => !task.expected_files.includes(file));
  if (outside.length) fail('the lane of ' + task.id + ' changes files outside its expected_files: ' + outside.join(', ') + '; restore them in ' + path + ' (a committed change needs a commit that reverts it), then run `' + again + '`');
  if (uncommitted.length) {
    const committedLane = gk(path, ['commit', '-m', laneCommitMessage(task), '--', ...uncommitted]);
    if (!committedLane.ok) fail('`git-kit commit` in lane ' + path + ' failed: ' + committedLane.message);
  }

  const merged = gk(root, ['merge', branch, '--no-ai', '--no-ff', '--no-commit', '--json']);
  if (!merged.ok) {
    const started = hasMergeHead(root);
    if (started) abortMerge(session, before);
    // git-kit's precheck reports a conflict without starting the merge; a conflict found by git
    // itself leaves MERGE_HEAD, and that merge was aborted above.
    if (!started && merged.envelope?.error?.code !== 'conflict' && merged.envelope?.state !== 'paused') {
      fail('`git-kit merge ' + branch + '` failed in ' + root + ': ' + merged.message);
    }
    modifyJSON(session.progressPath, (data) => {
      data.tasks[task.id] = { ...data.tasks[task.id], state: 'merge_conflict', merge_conflict_at: new Date().toISOString() };
      return data;
    });
    writeTasks(session);
    const target = rootBranch(root);
    const recover = ['git -C ' + path + ' merge ' + target + '  # resolve the conflicts and commit', progressCommand(session, 'verify', task), again];
    if (json) console.log(JSON.stringify({ status: 'merge_conflict', plan_id: session.runId, task: task.id, lane_branch: branch, lane_path: path, root_branch: target, message: merged.message, recover }, null, 2));
    else {
      console.error('merge of lane ' + branch + ' into ' + target + ' conflicts (' + merged.message + '); the root is unchanged.');
      console.error('Recover in the lane:');
      recover.forEach((command, index) => console.error('  ' + (index + 1) + '. ' + command));
    }
    return exitFail(VERIFY_FAILED, 'merge conflict');
  }
  if (!hasMergeHead(root)) fail('`git-kit merge ' + branch + '` reported ok but left no merge to commit in ' + root + '; check `git status` there');

  for (const command of ownCommands(task)) {
    const result = runCommand(session, command);
    if (result.status === 0 && !result.error) continue;
    const exit = result.status ?? (result.error?.code || result.signal || 'unknown');
    abortMerge(session, before);
    writeTasks(session);
    if (json) console.log(JSON.stringify({ status: 'failed', plan_id: session.runId, task: task.id, failed_command: command, exit_code: exit, scope: 'task', phase: 'merge', state: 'lane_verified' }, null, 2));
    else console.error('merge of lane ' + branch + ' aborted: `' + command + '` exited with ' + exit + ' in the repository root after the merge. ' + task.id + ' stays lane_verified; fix it in the lane, then verify and merge again');
    return exitFail(VERIFY_FAILED, 'verification failed');
  }
  const concluded = git(root, ['commit', '--no-edit']);
  if (concluded.error || concluded.status !== 0) {
    const detail = String(concluded.stderr || concluded.stdout || concluded.error?.message || '').trim();
    abortMerge(session, before);
    fail('committing the merge of lane ' + branch + ' failed, and the merge was aborted: ' + detail);
  }
  const mergeCommit = gitHead(root);
  // Recorded before the outcome: the merge is committed now, so if the plan-wide commands
  // fail below, the task is fixed and verified again in the root, not merged again.
  modifyJSON(session.progressPath, (data) => {
    const current = data.tasks[task.id];
    data.tasks[task.id] = { ...current, state: 'in_progress', lane: { ...current.lane, merged_at: new Date().toISOString(), merge_commit: mergeCommit } };
    return data;
  });
  const cleanup = [];
  const removed = git(root, ['worktree', 'remove', '--force', path]);
  if (removed.error || removed.status !== 0) cleanup.push({ command: 'git worktree remove --force ' + path, error: String(removed.stderr || removed.error?.message || '').trim() });
  const deleted = git(root, ['branch', '-D', branch]);
  if (deleted.error || deleted.status !== 0) cleanup.push({ command: 'git branch -D ' + branch, error: String(deleted.stderr || deleted.error?.message || '').trim() });
  if (!json) {
    console.log('Merged lane ' + branch + ' into ' + rootBranch(root) + ' (' + mergeCommit.slice(0, 12) + ')');
    for (const item of cleanup) console.error('could not remove the lane: `' + item.command + '` failed: ' + item.error + '. Run it in ' + root);
  }
  return recordVerification(session, task, hashFiles(root, task.expected_files), json, {
    ownPassed: true,
    extra: { lane_merged: branch, merge_commit: mergeCommit, ...(cleanup.length ? { lane_cleanup_failed: cleanup } : {}) },
  });
}
