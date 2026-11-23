/** Per-plan progress state and a generated tasks.md checklist for an x-plan PlanEnvelope. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modifyJSON, readJSON, writeMD, exitFail } from './core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMAND_TIMEOUT_MS = 120000;
const VERIFY_FAILED = 2;

async function loadPlanNormalizer() {
  const candidates = [join(HERE, '..', 'x-plan', 'normalize.mjs'), join(HERE, '..', '..', '..', 'x-plan', 'lib', 'x-plan', 'normalize.mjs')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try { return await import(path); } catch {}
  }
  return null;
}

function fail(message, code = 1) {
  console.error(message);
  exitFail(code, message);
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// Mirrors x-plan artifact.mjs repositoryRoot so both resolve the same .xm/plan.
function planRepoRoot(cwd) {
  if (existsSync(join(cwd, '.xm'))) return cwd;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (top) return top;
  } catch {}
  return cwd;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fileHash(root, file) {
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (isAbsolute(file) || rel.startsWith('..') || isAbsolute(rel)) fail('expected file escapes the repository: ' + file);
  return existsSync(abs) ? sha256(readFileSync(abs)) : null;
}

function hashFiles(root, files) {
  return Object.fromEntries(files.map((file) => [file, fileHash(root, file)]));
}

function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    const problem = missingBaselineCommit(root);
    return fail(problem
      ? 'progress records HEAD as the baseline, and ' + problem + '. Create the first commit, then run this command again. An agent asks the user before it creates a repository or a commit.'
      : 'progress requires a git repository with at least one commit');
  }
}

// Why root has no commit to record as a baseline, or null when git gives another failure.
// Each call has the limit of the rev-parse in gitHead: this runs after that call failed, and
// a git that hangs must still end in an error instead of a command that never returns.
function missingBaselineCommit(root) {
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  const head = git('rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (head.error || head.status === 0) return null;
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.error) return null;
  return inside.status === 0 ? 'this repository has no commit yet' : root + ' is not in a git repository';
}

function taskHash(task) {
  return sha256(JSON.stringify(task));
}

async function loadSession(args) {
  const runId = flag(args, '--plan');
  if (!runId || !RUN_ID.test(runId) || runId.includes('..')) fail('invalid or missing --plan run id');
  const root = planRepoRoot(process.cwd());
  const dir = join(root, '.xm', 'plan', runId);
  const envelopePath = join(dir, 'envelope.json');
  if (!existsSync(envelopePath)) fail('plan session or envelope.json not found: ' + runId);
  const core = await loadPlanNormalizer();
  if (!core) fail('x-plan normalizer not found');
  let raw;
  try { raw = JSON.parse(readFileSync(envelopePath, 'utf8')); } catch (error) { return fail('envelope.json is not valid JSON: ' + error.message); }
  return { runId, root, dir, plan: core.normalizePlanEnvelope(raw), progressPath: join(dir, 'progress.json') };
}

function readProgress(session) {
  const data = readJSON(session.progressPath);
  return data && typeof data === 'object' && data.tasks ? data : { schema_version: 1, plan_id: session.runId, tasks: {} };
}

function deriveStatus(session, task, record) {
  if (!record) return 'pending';
  if (record.task_hash !== taskHash(task)) return 'reset';
  if (record.state !== 'verified') return 'in_progress';
  const current = hashFiles(session.root, Object.keys(record.verified_files || {}));
  return Object.entries(record.verified_files || {}).some(([file, hash]) => current[file] !== hash) ? 'changed_after_verification' : 'verified';
}

function summarize(session) {
  const progress = readProgress(session);
  const tasks = session.plan.tasks.map((task) => ({ task, status: deriveStatus(session, task, progress.tasks[task.id]) }));
  return { progress, tasks, verified: tasks.filter((item) => item.status === 'verified').length };
}

function renderTasks(session, summary) {
  const byId = new Map(summary.tasks.map((item) => [item.task.id, item]));
  const ordered = [];
  for (const step of session.plan.steps) for (const id of step) if (byId.has(id) && !ordered.includes(byId.get(id))) ordered.push(byId.get(id));
  for (const item of summary.tasks) if (!ordered.includes(item)) ordered.push(item);
  const lines = [
    '<!-- Generated by `xm build progress`. Do not edit; changes are overwritten. -->',
    '',
    '# Tasks: ' + session.plan.goal,
    '',
    summary.verified + '/' + summary.tasks.length + ' verified',
    '',
  ];
  for (const { task, status } of ordered) {
    const suffix = status === 'pending' || status === 'verified' ? '' : '  (' + status + ')';
    lines.push('- [' + (status === 'verified' ? 'x' : ' ') + '] ' + task.id + ' ' + task.title + '  [' + task.requirement_refs.join(', ') + ']' + suffix);
    if (task.depends_on.length) lines.push('  - Depends on: ' + task.depends_on.join(', '));
    if (task.contract_deps?.length) lines.push('  - Contract only: ' + task.contract_deps.join(', '));
    if (task.expected_files.length) lines.push('  - Files: ' + task.expected_files.join(', '));
    lines.push('  - Done when: ' + task.done_criteria.join('; '));
    if (task.verify_commands?.length) lines.push('  - Verify: ' + task.verify_commands.join('; '));
  }
  return lines.join('\n') + '\n';
}

function writeTasks(session) {
  const summary = summarize(session);
  const text = renderTasks(session, summary);
  writeMD(join(session.dir, 'tasks.md'), text);
  return { summary, text };
}

function requireTask(session, args) {
  const id = flag(args, '--task');
  if (!id) fail('missing --task');
  const task = session.plan.tasks.find((item) => item.id === id);
  if (!task) fail('unknown task id: ' + id);
  return task;
}

function requireExecutable(session) {
  if (session.plan.executable !== true) fail('plan is not executable: ' + session.runId);
  if (!session.plan.validation.commands.length) fail('plan has no validation.commands to verify against');
}

// The task's own commands run first: they observe this task's criteria, while the plan-wide
// commands only show that nothing else broke.
function verifyCommands(session, task) {
  return [...(task.verify_commands || []), ...session.plan.validation.commands];
}

function cmdStart(args, json) {
  return loadSession(args).then((session) => {
    requireExecutable(session);
    const task = requireTask(session, args);
    const baselineHead = gitHead(session.root);
    const hashedNow = hashFiles(session.root, task.expected_files);
    modifyJSON(session.progressPath, (data) => {
      const next = data && data.tasks ? data : { schema_version: 1, plan_id: session.runId, tasks: {} };
      // A file the task already tracked keeps its first baseline. Without this, a task that
      // was revised after its work is done could never be verified again: start would take
      // the finished file as the baseline, and verify would find no change. A file that is
      // new to the task is hashed now, so a revision that names other files still needs work.
      const tracked = next.tasks[task.id]?.baseline_files || {};
      const baselineFiles = Object.fromEntries(task.expected_files.map((file) => [file, file in tracked ? tracked[file] : hashedNow[file]]));
      next.tasks[task.id] = {
        task_hash: taskHash(task), state: 'in_progress', started_at: new Date().toISOString(),
        baseline_head: baselineHead, baseline_files: baselineFiles,
      };
      return next;
    });
    writeTasks(session);
    const commands = verifyCommands(session, task);
    if (json) console.log(JSON.stringify({ status: 'started', plan_id: session.runId, task: task.id, verify_commands: commands }, null, 2));
    else {
      console.log('Started ' + task.id + ' ' + task.title);
      console.log('verify will run:');
      for (const command of commands) console.log('  ' + command);
    }
  });
}

function runCommand(root, command) {
  return spawnSync(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd: root, stdio: 'ignore', timeout: COMMAND_TIMEOUT_MS });
}

async function cmdVerify(args, json) {
  const session = await loadSession(args);
  requireExecutable(session);
  const task = requireTask(session, args);
  const records = readProgress(session).tasks;
  const record = records[task.id];
  if (!record || record.state !== 'in_progress') fail('task ' + task.id + ' has no in_progress record; run `xm build progress start` first');
  if (record.task_hash !== taskHash(task)) fail('plan task ' + task.id + ' changed since start; run `xm build progress start` again');
  // A task can start beside a dependency (contract_deps), so the order is enforced here: a
  // consumer is not checked off against a producer that has not passed its own verification.
  // The record must be for the producer as the plan defines it now. For a contract pair the
  // producer's done criteria are the interface, so a producer revised after its verification
  // has to be started and verified again first; cmdStart keeps that possible.
  const unverified = session.plan.tasks.filter((dep) => task.depends_on.includes(dep.id)
    && !(records[dep.id]?.state === 'verified' && records[dep.id].task_hash === taskHash(dep))).map((dep) => dep.id);
  if (unverified.length) fail('task ' + task.id + ' depends on ' + unverified.join(', ') + ', not verified yet; verify ' + unverified.join(', ') + ' first');
  const current = hashFiles(session.root, task.expected_files);
  if (!task.expected_files.some((file) => current[file] !== record.baseline_files[file])) fail('no expected file changed since start of ' + task.id);

  const commands = verifyCommands(session, task);
  for (const command of commands) {
    const result = runCommand(session.root, command);
    if (result.status !== 0 || result.error) {
      const exit = result.status ?? (result.error?.code || result.signal || 'unknown');
      if (json) console.log(JSON.stringify({ status: 'failed', plan_id: session.runId, task: task.id, failed_command: command, exit_code: exit }, null, 2));
      else console.error('verification failed for ' + task.id + ': `' + command + '` exited with ' + exit);
      writeTasks(session);
      exitFail(VERIFY_FAILED, 'verification failed');
      return;
    }
  }
  modifyJSON(session.progressPath, (data) => {
    data.tasks[task.id] = {
      ...data.tasks[task.id], state: 'verified', verified_at: new Date().toISOString(), verified_head: gitHead(session.root),
      verified_files: current, commands, commands_hash: sha256(JSON.stringify(commands)),
    };
    return data;
  });
  writeTasks(session);
  if (json) console.log(JSON.stringify({ status: 'verified', plan_id: session.runId, task: task.id }, null, 2));
  else console.log('Verified ' + task.id + ' ' + task.title);
}

async function cmdShow(args, json) {
  const session = await loadSession(args);
  const { summary, text } = writeTasks(session);
  if (json) {
    console.log(JSON.stringify({
      plan_id: session.runId, goal: session.plan.goal, verified: summary.verified, total: summary.tasks.length,
      tasks: summary.tasks.map(({ task, status }) => ({ id: task.id, title: task.title, status })),
    }, null, 2));
  } else process.stdout.write(text);
}

export async function cmdProgress(args = []) {
  const [sub, ...rest] = args;
  const json = rest.includes('--json');
  if (sub === 'start') return cmdStart(rest, json);
  if (sub === 'verify') return cmdVerify(rest, json);
  if (sub === 'show') return cmdShow(rest, json);
  return fail('Usage: xm build progress <start|verify|show> --plan <run-id> [--task <id>] [--json]');
}
