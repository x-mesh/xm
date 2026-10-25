import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const USAGE = 'Usage: xm pr land [<number|url|branch>] [--wait] [--timeout <sec>] [--allow-no-checks] [--require-review] [--cleanup] [--dry-run|--yes] [--json]';
const VIEW_FIELDS = 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,mergeCommit,mergedAt';
const MERGEABLE_STATES = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'];
const DEFAULT_TIMEOUT_SEC = 1800;
const DEFAULT_POLL_MS = 15000;

// A value flag always takes the next argument, so `--timeout -1` reaches validation
// instead of being dropped for looking like another flag.
function option(args, name) {
  const inline = args.find((arg) => arg.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return null;
  return index + 1 < args.length ? args[index + 1] : '';
}

function positionalArgs(args, valueOptions = []) {
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.includes(arg)) { index += 1; continue; }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  return positional;
}

function fail(action, errors, { json = false, code = 2 } = {}) {
  const output = { action, status: code === 1 ? 'error' : 'blocked', errors: Array.isArray(errors) ? errors : [errors] };
  if (json) console.log(JSON.stringify(output, null, 2));
  else for (const error of output.errors) console.error('❌ ' + error);
  process.exitCode = code;
  return null;
}

function emit(value, json, lines) {
  console.log(json ? JSON.stringify(value, null, 2) : [].concat(lines).join('\n'));
  return value;
}

function argvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === 'string')) throw new Error(`${name} must be a non-empty JSON string array`);
  return value;
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd, env: { ...env, GK_AGENT: '1' }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return { ok: !result.error && result.status === 0, exit_code: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || result.error?.message || '') };
}

function parseJSON(raw) {
  try { return JSON.parse(String(raw).trim()); } catch { return null; }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function viewPr(gh, target, cwd) {
  const result = run(gh, ['pr', 'view', ...(target ? [target] : []), '--json', VIEW_FIELDS], cwd);
  return { ...result, value: result.ok ? parseJSON(result.stdout) : null };
}

// gh exits non-zero while checks are pending or failing, and errors with
// "no checks reported" when a branch has none, so the exit code alone says nothing.
function readChecks(gh, target, cwd) {
  const result = run(gh, ['pr', 'checks', target, '--json', 'name,state,bucket'], cwd);
  const rows = parseJSON(result.stdout);
  if (Array.isArray(rows)) return { ok: true, rows };
  if (/no checks reported/i.test(result.stderr)) return { ok: true, rows: [] };
  return { ok: false, error: result.stderr.trim() || 'gh pr checks failed' };
}

function summarizeChecks(rows) {
  const failed = rows.filter((row) => row.bucket === 'fail' || row.bucket === 'cancel').map((row) => row.name);
  const pending = rows.filter((row) => row.bucket === 'pending').map((row) => row.name);
  // No rows is its own state: right after a push, CI may not have registered its checks yet.
  const status = !rows.length ? 'none' : failed.length ? 'failed' : pending.length ? 'pending' : 'passed';
  return { status, total: rows.length, failed, pending };
}

function mergeBlocker(pr) {
  if (pr.mergeable !== 'MERGEABLE') return `PR mergeable state is ${pr.mergeable}`;
  if (!MERGEABLE_STATES.includes(pr.mergeStateStatus)) return `PR merge state is ${pr.mergeStateStatus}`;
  return null;
}

function repoRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// A review counts only when it finished, approved, and reviewed the exact head
// that will be merged; a review of an earlier push says nothing about this one.
function findReview(root, headOid) {
  const runsDir = root ? join(root, '.xm', 'review', 'runs') : null;
  if (!runsDir || !existsSync(runsDir)) return null;
  const read = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  for (const id of readdirSync(runsDir).sort().reverse()) {
    const dir = join(runsDir, id);
    if (read(join(dir, 'run.json'))?.snapshot?.commit !== headOid) continue;
    if (read(join(dir, 'terminal.json'))?.outcome !== 'success') continue;
    const result = read(join(dir, 'result.json'));
    if (result?.verdict === 'LGTM') return { run_id: id, verdict: result.verdict };
  }
  return null;
}

function listWorktrees(cwd) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n\n').filter(Boolean).map((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] || null;
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] || null;
    return { path, branch, head };
  });
}

function repoFromUrl(url) {
  return /\/([^/]+\/[^/]+)\/pull\/\d+\/?$/.exec(String(url || ''))?.[1]?.toLowerCase() || null;
}

// The follow-up acts on local worktrees, so it must run only in a checkout of the PR's repository.
function localRepoMismatch(gh, pr, cwd) {
  // GH_REPO overrides gh's repository, which would make gh name a repository other than this checkout.
  const { GH_REPO: _override, ...env } = process.env;
  const viewed = run(gh, ['repo', 'view', '--json', 'nameWithOwner'], cwd, env);
  const local = viewed.ok ? parseJSON(viewed.stdout)?.nameWithOwner?.toLowerCase() : null;
  const remote = repoFromUrl(pr.url);
  if (!local || !remote) return 'cannot confirm that this checkout is the PR repository';
  return local === remote ? null : `this checkout is ${local}, not the PR repository ${remote}`;
}

function gkEnvelope(result) {
  return parseJSON(result.stdout) || parseJSON(result.stderr);
}

function afterMerge(gh, gk, pr, { cleanup, cwd }) {
  const mismatch = localRepoMismatch(gh, pr, cwd);
  if (mismatch) return { sync: { status: 'skipped', reason: mismatch }, cleanup: { status: 'skipped', reason: mismatch } };
  const worktrees = listWorktrees(cwd);
  const baseTree = worktrees.find((tree) => tree.branch === pr.baseRefName);
  let sync;
  if (!baseTree) {
    sync = { status: 'skipped', reason: `${pr.baseRefName} is not checked out in any worktree` };
  } else {
    // --no-autostash: a non-TTY pull must refuse a dirty base rather than stash someone's work.
    const pulled = run(gk, ['pull', '--strategy', 'ff-only', '--no-autostash'], baseTree.path);
    const envelope = gkEnvelope(pulled);
    sync = envelope?.state === 'ok'
      ? { status: 'pulled', worktree: baseTree.path }
      : { status: 'failed', worktree: baseTree.path, error: envelope?.error?.message || pulled.stderr.trim() || 'git-kit pull failed' };
  }

  let removal = { status: 'skipped', reason: 'pass --cleanup to remove the head worktree' };
  if (cleanup) {
    const headTree = worktrees.find((tree) => tree.branch === pr.headRefName);
    // A branch name alone does not identify the PR: a fork PR or a later branch can reuse it.
    if (pr.isCrossRepository) removal = { status: 'skipped', reason: 'the PR comes from another repository' };
    else if (!headTree) removal = { status: 'skipped', reason: `${pr.headRefName} has no worktree` };
    else if (headTree.head !== pr.headRefOid) removal = { status: 'skipped', reason: `${headTree.path} is not at the merged head ${pr.headRefOid}` };
    else if (headTree.path === worktrees[0]?.path) removal = { status: 'skipped', reason: 'the head branch is checked out in the main worktree' };
    else {
      const removeFrom = baseTree?.path || worktrees[0].path;
      const removed = run(gk, ['worktree', 'remove', headTree.path], removeFrom);
      const envelope = gkEnvelope(removed);
      removal = envelope?.state === 'ok'
        ? { status: 'removed', worktree: headTree.path }
        : { status: 'failed', worktree: headTree.path, error: envelope?.error?.message || removed.stderr.trim() || 'git-kit worktree remove failed' };
    }
  }
  return { sync, cleanup: removal };
}

function describe(output) {
  const lines = [`PR #${output.pr.number} ${output.pr.headRefName} → ${output.pr.baseRefName}: ${output.status}`];
  if (output.checks) lines.push(`  checks: ${output.checks.status} (${output.checks.total})${output.checks.failed.length ? ' failed: ' + output.checks.failed.join(', ') : ''}${output.checks.pending.length ? ' pending: ' + output.checks.pending.join(', ') : ''}`);
  if (output.review) lines.push(`  review: ${output.review.status}${output.review.run_id ? ' (' + output.review.run_id + ')' : ''}`);
  if (output.blocker) lines.push(`  blocked: ${output.blocker}`);
  if (output.merge_argv) lines.push(`  merge: ${output.merge_argv.join(' ')}`);
  if (output.merge_commit) lines.push(`  merge commit: ${output.merge_commit}`);
  if (output.after?.sync) lines.push(`  base sync: ${output.after.sync.status}${output.after.sync.reason ? ' — ' + output.after.sync.reason : ''}${output.after.sync.error ? ' — ' + output.after.sync.error : ''}`);
  if (output.after?.cleanup) lines.push(`  cleanup: ${output.after.cleanup.status}${output.after.cleanup.reason ? ' — ' + output.after.cleanup.reason : ''}${output.after.cleanup.error ? ' — ' + output.after.cleanup.error : ''}`);
  if (output.status === 'awaiting_confirmation') lines.push('Re-run with --yes to merge.');
  return lines;
}

function cmdLand(args) {
  const action = 'pr.land';
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  const wait = args.includes('--wait');
  const requireReview = args.includes('--require-review');
  const cleanup = args.includes('--cleanup');
  const allowNoChecks = args.includes('--allow-no-checks');
  if (dryRun && yes) return fail(action, '--dry-run and --yes cannot be combined', { json });
  const positional = positionalArgs(args, ['--timeout']);
  if (positional.length > 1) return fail(action, USAGE, { json });
  const timeoutRaw = option(args, '--timeout');
  const timeoutSec = timeoutRaw === null ? DEFAULT_TIMEOUT_SEC : timeoutRaw.trim() === '' ? NaN : Number(timeoutRaw);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) return fail(action, '--timeout must be a non-negative number of seconds', { json });
  // Tests shorten the poll; a real run keeps the default so it does not hammer the GitHub API.
  const pollMs = Number(process.env.X_BUILD_PR_LAND_POLL_MS) || DEFAULT_POLL_MS;

  let gh, gk;
  try {
    gh = argvEnv('X_BUILD_GH_ARGV', ['gh']);
    gk = argvEnv('X_BUILD_GK_ARGV', ['git-kit']);
  } catch (error) { return fail(action, error.message, { json }); }
  const cwd = process.cwd();

  let viewed = viewPr(gh, positional[0], cwd);
  if (!viewed.value) return fail(action, `cannot read the PR: ${viewed.stderr.trim() || 'gh pr view failed'}`, { json, code: 1 });
  let pr = viewed.value;
  // Every later gh call names the PR by URL: a bare number resolves against the
  // repository in cwd, which is not the PR's repository when a URL was given.
  const target = pr.url;
  const prSummary = () => ({ number: pr.number, url: pr.url, state: pr.state, baseRefName: pr.baseRefName, headRefName: pr.headRefName, headRefOid: pr.headRefOid });
  const finish = (output) => {
    if (['sync', 'cleanup'].some((step) => output.after?.[step]?.status === 'failed')) process.exitCode = 1;
    return emit(output, json, describe(output));
  };
  const landed = () => {
    const output = { action, status: 'merged', reused: true, pr: prSummary(), merge_commit: pr.mergeCommit?.oid || null };
    if (yes) output.after = afterMerge(gh, gk, pr, { cleanup, cwd });
    return finish(output);
  };

  if (pr.state === 'MERGED') return landed();

  const deadline = Date.now() + timeoutSec * 1000;
  let checks;
  for (;;) {
    const read = readChecks(gh, target, cwd);
    if (!read.ok) return fail(action, `cannot read PR checks: ${read.error}`, { json, code: 1 });
    checks = summarizeChecks(read.rows);
    const mergeUnknown = pr.mergeable === 'UNKNOWN';
    const settled = checks.status === 'failed' || ((checks.status === 'passed' || (checks.status === 'none' && allowNoChecks)) && !mergeUnknown);
    if (!wait || settled || pr.state !== 'OPEN' || pr.isDraft || Date.now() >= deadline) break;
    sleep(pollMs);
    viewed = viewPr(gh, target, cwd);
    if (!viewed.value) return fail(action, `cannot read the PR: ${viewed.stderr.trim() || 'gh pr view failed'}`, { json, code: 1 });
    pr = viewed.value;
  }
  if (pr.state === 'MERGED') return landed();

  const found = findReview(repoRoot(cwd), pr.headRefOid);
  const review = found ? { status: 'approved', ...found } : { status: requireReview ? 'missing' : 'not_required' };
  const blocker = pr.state !== 'OPEN' ? `PR is ${pr.state}`
    : pr.isDraft ? 'PR is a draft'
    : checks.status === 'failed' ? `checks failed: ${checks.failed.join(', ')}`
    : checks.status === 'pending' ? `checks still pending: ${checks.pending.join(', ')}`
    : checks.status === 'none' && !allowNoChecks ? 'no checks reported; pass --allow-no-checks to merge a PR without checks'
    : review.status === 'missing' ? `no finished LGTM review for head ${pr.headRefOid}`
    : mergeBlocker(pr);
  const mergeArgv = ['gh', 'pr', 'merge', target, '--merge', '--match-head-commit', pr.headRefOid];

  if (blocker) {
    const output = { action, status: 'blocked', pr: prSummary(), checks, review, blocker };
    process.exitCode = 2;
    return emit(output, json, describe(output));
  }
  if (!yes) {
    const output = { action, status: dryRun ? 'dry-run' : 'awaiting_confirmation', pr: prSummary(), checks, review, merge_argv: mergeArgv, cleanup };
    if (!dryRun) process.exitCode = 2;
    return emit(output, json, describe(output));
  }

  const merged = run(gh, mergeArgv.slice(1), cwd);
  viewed = viewPr(gh, target, cwd);
  if (!viewed.value) {
    const output = { action, status: 'merge_unknown', pr: prSummary(), checks, review, blocker: `merge result cannot be confirmed: ${viewed.stderr.trim()}` };
    process.exitCode = 1;
    return emit(output, json, describe(output));
  }
  pr = viewed.value;
  if (pr.state !== 'MERGED') {
    const output = merged.ok
      ? { action, status: 'merge_pending', pr: prSummary(), checks, review, blocker: 'gh accepted the merge but the PR is not merged yet; re-run to finish' }
      : { action, status: 'blocked', pr: prSummary(), checks, review, blocker: `gh pr merge failed: ${merged.stderr.trim() || 'exit ' + merged.exit_code}` };
    process.exitCode = 2;
    return emit(output, json, describe(output));
  }
  return finish({ action, status: 'merged', reused: false, pr: prSummary(), checks, review, merge_commit: pr.mergeCommit?.oid || null, after: afterMerge(gh, gk, pr, { cleanup, cwd }) });
}

export async function cmdPr(args = []) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'land') return cmdLand(rest);
  return fail('pr', USAGE, { json: args.includes('--json') });
}
