import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { ROOT, projectsDir } from './core.mjs';

const USAGE = 'Usage: xm next [--limit N] [--json]';
const DEFAULT_LIMIT = 3;
const PR_FIELDS = 'number,title,url,isDraft,mergeable,statusCheckRollup';
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const PENDING_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']);
const ACTIVE_INBOX = new Set(['delivered', 'in_progress']);
// Work closest to done comes first: a PR that only needs a merge beats a new backlog item.
const SCORE = { pr_ready: 100, pr_failing: 90, inbox_in_progress: 80, inbox_delivered: 70, pr_pending: 50, pr_draft: 40, later_unknown: 30, later_low: 25, later_none: 20 };

function argvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === 'string')) throw new Error(`${name} must be a non-empty JSON string array`);
  return value;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function checkState(rollup) {
  const rows = Array.isArray(rollup) ? rollup : [];
  if (rows.some((row) => FAILED_CONCLUSIONS.has(row.conclusion) || FAILED_CONCLUSIONS.has(row.state))) return 'failing';
  if (rows.some((row) => PENDING_STATES.has(row.status) || PENDING_STATES.has(row.state))) return 'pending';
  return 'passed';
}

function prCandidate(pr) {
  const base = { source: 'pr', id: `#${pr.number}`, title: pr.title, url: pr.url };
  if (pr.isDraft) return { ...base, score: SCORE.pr_draft, reason: 'draft PR', command: `gh pr ready ${pr.number}` };
  const checks = checkState(pr.statusCheckRollup);
  if (checks === 'failing') return { ...base, score: SCORE.pr_failing, reason: 'checks failed', command: `gh pr checks ${pr.number}` };
  if (checks === 'pending') return { ...base, score: SCORE.pr_pending, reason: 'checks running', command: `xm pr land ${pr.number} --wait --dry-run` };
  // gh reports UNKNOWN until GitHub computes mergeability; xm pr land re-checks it, so only a known conflict demotes the PR.
  if (pr.mergeable === 'CONFLICTING') return { ...base, score: SCORE.pr_failing, reason: 'merge conflict', command: `gh pr view ${pr.number}` };
  return { ...base, score: SCORE.pr_ready, reason: 'checks passed and mergeable', command: `xm pr land ${pr.number} --dry-run` };
}

function collectPrs(gh, cwd) {
  const result = spawnSync(gh[0], [...gh.slice(1), 'pr', 'list', '--author', '@me', '--state', 'open', '--json', PR_FIELDS], { cwd, encoding: 'utf8' });
  let rows = null;
  try { rows = JSON.parse(String(result.stdout || '').trim()); } catch {}
  if (result.error || result.status !== 0 || !Array.isArray(rows)) {
    return { status: 'unavailable', error: String(result.stderr || result.error?.message || 'gh pr list failed').trim(), candidates: [] };
  }
  return { status: 'ok', candidates: rows.map(prCandidate) };
}

function collectInbox(dir) {
  if (!existsSync(dir)) return { status: 'ok', candidates: [] };
  const candidates = readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => readJson(join(dir, name)))
    .filter((item) => item && ACTIVE_INBOX.has(item.status))
    .map((item) => ({
      source: 'inbox', id: item.id, title: item.title, created_at: item.created_at,
      score: item.status === 'in_progress' ? SCORE.inbox_in_progress : SCORE.inbox_delivered,
      reason: item.status === 'in_progress' ? `in progress, from ${item.from_project}` : `reported by ${item.from_project}`,
      command: item.status === 'in_progress' ? `xm inbox list` : `xm inbox take ${item.id}`,
    }));
  return { status: 'ok', candidates };
}

function collectLater(dir) {
  if (!existsSync(dir)) return { status: 'ok', candidates: [] };
  const candidates = [];
  for (const project of readdirSync(dir)) {
    const data = readJson(join(dir, project, 'later.json'));
    for (const item of data?.items || []) {
      if (item.status !== 'open') continue;
      candidates.push({
        source: 'later', id: item.id, project, title: item.title, created_at: item.created_at,
        score: SCORE[`later_${item.impact}`] ?? SCORE.later_none,
        reason: `later item in ${project}${item.impact && item.impact !== 'none' ? `, impact ${item.impact}` : ''}`,
        command: `xm build later promote ${item.id} --project ${project}`,
      });
    }
  }
  return { status: 'ok', candidates };
}

// Higher score first; within a score, the oldest item first so nothing starves.
function rank(candidates) {
  return [...candidates].sort((a, b) => b.score - a.score || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function batchCommand(top) {
  const titles = top.filter((item) => item.source !== 'pr').map((item) => item.title);
  return titles.length >= 2 ? `/xm:batch ${titles.map((title) => JSON.stringify(title)).join(' ')}` : null;
}

export function cmdNextWork(args = []) {
  const json = args.includes('--json');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : DEFAULT_LIMIT;
  const unknown = args.filter((arg, index) => arg !== '--json' && index !== limitIndex && !(limitIndex >= 0 && index === limitIndex + 1));
  if (!Number.isInteger(limit) || limit < 1 || unknown.length) {
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }
  let gh;
  try { gh = argvEnv('X_BUILD_GH_ARGV', ['gh']); } catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 2; return null; }

  const sources = {
    prs: collectPrs(gh, process.cwd()),
    inbox: collectInbox(join(dirname(ROOT), 'inbox')),
    later: collectLater(projectsDir()),
  };
  const all = rank(Object.values(sources).flatMap((source) => source.candidates));
  const top = all.slice(0, limit);
  const output = {
    action: 'next',
    candidates: top,
    total: all.length,
    batch_command: batchCommand(top),
    sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { status: source.status, count: source.candidates.length, ...(source.error ? { error: source.error } : {}) }])),
  };
  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return output;
  }
  if (!top.length) console.log('Nothing to pick up: no open PRs of yours, no active inbox items, no open later items.');
  top.forEach((item, index) => {
    console.log(`${index + 1}. [${item.source} ${item.id}] ${item.title}`);
    console.log(`   ${item.reason}`);
    console.log(`   → ${item.command}`);
  });
  if (all.length > top.length) console.log(`(${all.length - top.length} more; xm next --limit ${all.length})`);
  if (output.batch_command) console.log(`\nTo deliver these as parallel PRs (xm:batch checks that they are independent):\n  ${output.batch_command}`);
  if (sources.prs.status !== 'ok') console.log(`\n⚠ PRs skipped: ${sources.prs.error}`);
  return output;
}
