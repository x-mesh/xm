/**
 * L3 verification for the git-history escape metric (see escape-git.mjs).
 *
 * escape-git.mjs computes `test_pairing_rate` from PATH SHAPE alone: a defect
 * commit "shipped a test" if any file it touched looks like a test file. That is
 * a habit metric. It cannot distinguish a test that reproduces the bug from a
 * test that was merely edited in the same commit, so a high rate (x-kit reports
 * 0.951) is not evidence of quality.
 *
 * This module upgrades the claim by replaying the test against the parent commit:
 *
 *   control   — check out the fix commit, run the tests it touched. They must pass.
 *   treatment — check out the PARENT, restore the fix's tests on top, run them again.
 *
 * A test that genuinely covers the bug FAILS in treatment, because the source fix
 * is absent. A test that passes in both states never exercised the defect, and the
 * commit inflated `test_pairing_rate` without adding detection.
 *
 * Impure by necessity: this creates a throwaway worktree, installs dependencies,
 * and runs the test suite. It therefore cannot live in escape-git.mjs (PURE, see
 * test/purity-contract.test.mjs) or in attention-collect.mjs (read-only with
 * respect to the repository). The primary checkout is never touched.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  GIT_LOG_ARGS, gitWindowArg, parseGitLog, gitEscapeConfig,
  isTestPath, normalizeGitPath, summarizeGitHistory,
} from './escape-git.mjs';

const MAX_GIT_BUFFER = 32 * 1024 * 1024;
const OUTPUT_TAIL = 2000;
export const ESCAPE_VERIFY_FILE = 'escape-verify.json';

function git(cwd, args, { timeout = 120_000 } = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_BUFFER, windowsHide: true, timeout });
}

function tail(value) {
  const text = String(value || '');
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

/**
 * Counts from a bun test summary, or null when the shape is unrecognised.
 *
 * The distinction between a failed assertion and a module that would not load
 * is the whole value of this check. A test importing a symbol the fix
 * introduced ALWAYS "fails" on the parent — with a SyntaxError, not a verdict
 * about behaviour. Scoring that as detection would manufacture exactly the
 * false confidence this module exists to measure.
 */
export function parseRunnerCounts(text) {
  const source = String(text || '');
  // bun pluralises only the error line: "1 error" but "2 errors". Matching the
  // singular alone silently reports error:0, which would promote a binding-only
  // replay to `catches` — the exact overstatement this module exists to remove.
  const read = label => {
    const match = new RegExp('^\\s*(\\d+)\\s+' + label + 's?\\s*$', 'm').exec(source);
    return match ? Number(match[1]) : null;
  };
  const pass = read('pass'), fail = read('fail'), error = read('error');
  if (pass == null && fail == null) return null;
  return { pass: pass ?? 0, fail: fail ?? 0, error: error ?? 0 };
}

/**
 * Verdict for one replayed commit.
 *
 * `control` failing is NOT a finding about the test — it means the sample itself
 * is unusable (flaky suite, missing toolchain, environment drift on an old
 * commit). Counting those as either outcome would bias the corrected rate, so
 * they are excluded from the denominator and reported separately.
 */
export function classifyReplay({ control, treatment }) {
  if (!control || control.outcome !== 'pass') return 'inconclusive';
  if (!treatment) return 'inconclusive';
  if (treatment.outcome === 'timeout') return 'inconclusive';
  if (treatment.outcome !== 'fail') return 'decorative';
  const counts = treatment.counts;
  // Only load errors and not one failed assertion: the test names new API, it
  // does not reproduce the defect.
  if (counts && counts.fail === 0 && counts.error > 0) return 'catches_by_binding';
  return 'catches';
}

/**
 * Group the flattened per-file defect rows back into commits, keeping only the
 * ones that claim a paired test. Verifying exactly this population is what makes
 * the corrected rate comparable to `test_pairing_rate` — a different denominator
 * would produce a number that looks like a correction but is not one.
 */
export function selectPairedCommits(summary, commitsBySha, config) {
  const cfg = gitEscapeConfig(config);
  const seen = new Map();
  for (const defect of summary?.defects || []) {
    if (!defect?.fix_shipped_test || seen.has(defect.sha)) continue;
    const commit = commitsBySha.get(defect.sha);
    if (!commit) continue;
    const files = (commit.files || []).map(normalizeGitPath).filter(Boolean);
    const testFiles = files.filter(file => isTestPath(file, cfg));
    if (!testFiles.length) continue;
    seen.set(defect.sha, { sha: defect.sha, ts: defect.ts, commit_type: defect.commit_type, subject: commit.subject, test_files: testFiles });
  }
  return [...seen.values()];
}

/**
 * Only runners that can execute a NAMED SUBSET of test files are supported.
 * Running the whole suite per replay would be slow and, worse, would mix in the
 * repository's pre-existing failures — the treatment signal would drown.
 */
export function detectSubsetTestRunner(workspace) {
  if (!existsSync(join(workspace, 'package.json'))) return null;
  if (existsSync(join(workspace, 'bun.lock')) || existsSync(join(workspace, 'bun.lockb'))) {
    return { kind: 'bun', run: files => ['bun', ['test', ...files]], install: ['bun', ['install']] };
  }
  return null;
}

function manifestFingerprint(workspace) {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'bun.lock', 'bun.lockb']) {
    const path = join(workspace, name);
    if (!existsSync(path)) continue;
    hash.update(name);
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

function runTests(runner, workspace, files, timeoutMs) {
  const [command, args] = runner.run(files);
  const result = spawnSync(command, args, {
    cwd: workspace, encoding: 'utf8', maxBuffer: MAX_GIT_BUFFER, windowsHide: true, timeout: timeoutMs,
  });
  if (result.error && result.error.code === 'ETIMEDOUT') return { outcome: 'timeout', exit_code: null, output_tail: tail(result.stdout) + tail(result.stderr) };
  if (result.error) return { outcome: 'error', exit_code: null, output_tail: tail(result.error.message) };
  const combined = String(result.stdout || '') + String(result.stderr || '');
  return {
    outcome: result.status === 0 ? 'pass' : 'fail',
    exit_code: result.status,
    counts: parseRunnerCounts(combined),
    output_tail: tail(combined),
  };
}

/** Reset the sandbox to `ref`, discarding whatever the previous replay left. */
function checkoutClean(workspace, ref) {
  const checkout = git(workspace, ['checkout', '--force', '--detach', ref]);
  if (checkout.status !== 0) return String(checkout.stderr || 'checkout failed').trim().slice(0, 200);
  // -d only; ignored files (node_modules) must survive so the install is reused.
  git(workspace, ['clean', '-fd']);
  return null;
}

function replayCommit(workspace, runner, entry, timeoutMs, installState) {
  const ensureDeps = () => {
    const fingerprint = manifestFingerprint(workspace);
    if (installState.fingerprint === fingerprint) return null;
    const [command, args] = runner.install;
    const result = spawnSync(command, args, { cwd: workspace, encoding: 'utf8', maxBuffer: MAX_GIT_BUFFER, windowsHide: true, timeout: timeoutMs });
    if (result.error || result.status !== 0) return String(result.stderr || result.error?.message || 'install failed').trim().slice(0, 200);
    installState.fingerprint = fingerprint;
    return null;
  };

  const controlError = checkoutClean(workspace, entry.sha);
  if (controlError) return { ...entry, verdict: 'inconclusive', reason: 'checkout failed: ' + controlError };
  const installError = ensureDeps();
  if (installError) return { ...entry, verdict: 'inconclusive', reason: 'dependency install failed: ' + installError };

  // Only replay tests that exist at the fix commit; a test deleted by the fix
  // cannot be restored onto the parent and would fail for the wrong reason.
  const present = entry.test_files.filter(file => existsSync(join(workspace, file)));
  if (!present.length) return { ...entry, verdict: 'skipped', reason: 'no test file present at the fix commit' };

  const control = runTests(runner, workspace, present, timeoutMs);
  if (control.outcome !== 'pass') {
    return { ...entry, verdict: 'inconclusive', reason: 'control run did not pass (' + control.outcome + ')', control };
  }

  const parentError = checkoutClean(workspace, entry.sha + '^');
  if (parentError) return { ...entry, verdict: 'inconclusive', reason: 'parent checkout failed: ' + parentError, control };
  const parentInstallError = ensureDeps();
  if (parentInstallError) return { ...entry, verdict: 'inconclusive', reason: 'parent dependency install failed: ' + parentInstallError, control };

  const restore = git(workspace, ['checkout', entry.sha, '--', ...present]);
  if (restore.status !== 0) {
    return { ...entry, verdict: 'inconclusive', reason: 'could not restore tests onto parent', control };
  }

  const treatment = runTests(runner, workspace, present, timeoutMs);
  return { ...entry, verdict: classifyReplay({ control, treatment }), control, treatment };
}

/**
 * Replay the tests of paired defect commits against their parents.
 *
 * Returns a report rather than throwing: an unusable repository, a missing
 * runner, or an empty window must degrade into a stated reason, because a
 * silent zero here would read as "every test is real".
 */
export function verifyTestPairing(root, { since = '90d', maxCommits = 500, limit = 20, timeoutMs = 180_000, config = null } = {}) {
  const resolved = resolve(root);
  const empty = { schema_v: 1, available: false, sampled: 0, rows: [], errors: [] };

  const window = gitWindowArg(since);
  if (!window) return { ...empty, errors: ['invalid git window: ' + since] };
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ...empty, errors: ['invalid sample limit'] };

  const log = git(resolved, [...GIT_LOG_ARGS, '--since=' + window, '-n', String(maxCommits)]);
  if (log.error || log.status !== 0) {
    return { ...empty, errors: [String(log.stderr || log.error?.message || 'git log failed').trim().slice(0, 200)] };
  }

  const parsed = parseGitLog(log.stdout);
  const cfg = gitEscapeConfig(config);
  const summary = summarizeGitHistory(parsed.commits, cfg);
  const bySha = new Map(parsed.commits.map(commit => [commit.sha, commit]));
  const paired = selectPairedCommits(summary, bySha, cfg);
  if (!paired.length) {
    return { ...empty, available: true, claimed_rate: summary.test_pairing_rate, errors: ['no defect commit in this window claims a paired test'] };
  }

  const sample = paired.slice(0, limit);
  const sandbox = mkdtempSync(join(tmpdir(), 'xm-escape-verify-'));
  const added = git(resolved, ['worktree', 'add', '--detach', sandbox, 'HEAD']);
  if (added.status !== 0) {
    rmSync(sandbox, { recursive: true, force: true });
    return { ...empty, errors: ['could not create verification worktree: ' + String(added.stderr || '').trim().slice(0, 200)] };
  }

  const rows = [];
  try {
    const runner = detectSubsetTestRunner(sandbox);
    if (!runner) {
      return {
        ...empty, available: true, claimed_rate: summary.test_pairing_rate,
        errors: ['no supported subset test runner detected (bun only in v1)'],
      };
    }
    const installState = { fingerprint: null };
    for (const entry of sample) rows.push(replayCommit(sandbox, runner, entry, timeoutMs, installState));
  } finally {
    git(resolved, ['worktree', 'remove', '--force', sandbox]);
    rmSync(sandbox, { recursive: true, force: true });
    git(resolved, ['worktree', 'prune']);
  }

  const catches = rows.filter(row => row.verdict === 'catches').length;
  const decorative = rows.filter(row => row.verdict === 'decorative').length;
  const bindingOnly = rows.filter(row => row.verdict === 'catches_by_binding').length;
  // Binding-only replays are counted in the denominator but NOT as detection:
  // they fail on the parent for a reason that has nothing to do with the bug.
  const decided = catches + decorative + bindingOnly;
  return {
    schema_v: 1,
    available: true,
    window: since,
    paired_commits: paired.length,
    sampled: rows.length,
    catches,
    catches_by_binding: bindingOnly,
    decorative,
    inconclusive: rows.filter(row => row.verdict === 'inconclusive').length,
    skipped: rows.filter(row => row.verdict === 'skipped').length,
    claimed_rate: summary.test_pairing_rate,
    // Share of sampled paired commits whose test actually detects its own bug.
    // Multiply the claimed rate by this to correct it; null when nothing was decided.
    verified_share: decided ? Math.round((catches / decided) * 1000) / 1000 : null,
    corrected_rate: decided && summary.test_pairing_rate != null
      ? Math.round(summary.test_pairing_rate * (catches / decided) * 1000) / 1000
      : null,
    rows,
    errors: [],
  };
}

export function escapeVerifyPath(root) {
  return join(resolve(root), '.xm', 'review', ESCAPE_VERIFY_FILE);
}

function writeReport(root, report) {
  const path = escapeVerifyPath(root);
  const dir = join(resolve(root), '.xm', 'review');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('escape-verify report directory is unsafe');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return path;
}

function parseIntArg(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isInteger(value) ? value : fallback;
}

export function cmdVerifyTests(args = []) {
  const json = args.includes('--json');
  const sinceIndex = args.indexOf('--since');
  const since = sinceIndex === -1 ? '90d' : String(args[sinceIndex + 1] || '90d');
  const limit = parseIntArg(args, '--limit', 20);
  const timeoutMs = parseIntArg(args, '--timeout-ms', 180_000);

  const report = verifyTestPairing(process.cwd(), { since, limit, timeoutMs });
  const path = report.available && report.sampled ? writeReport(process.cwd(), report) : null;

  if (json) {
    console.log(JSON.stringify({ ...report, report_path: path }));
    if (!report.available) process.exitCode = 1;
    return;
  }

  if (!report.available) {
    console.log('L3 verification unavailable.');
    for (const error of report.errors) console.log('  ' + error);
    process.exitCode = 1;
    return;
  }
  if (report.errors.length) for (const error of report.errors) console.log('note: ' + error);
  if (!report.sampled) return;

  console.log(`L3 test-pairing verification — ${report.sampled} of ${report.paired_commits} paired defect commits replayed (${report.window})`);
  console.log(`  catches         ${report.catches}  an assertion fails without the fix — it detects its own bug`);
  console.log(`  binding-only    ${report.catches_by_binding}  only a load error without the fix — it names new API, it does not detect`);
  console.log(`  decorative      ${report.decorative}  passes without the fix — it never exercised the defect`);
  console.log(`  inconclusive    ${report.inconclusive}  control run unusable (flaky suite, env drift, timeout)`);
  console.log(`  skipped         ${report.skipped}`);
  if (report.verified_share == null) {
    console.log('\nNothing was decided — the corrected rate cannot be computed from this sample.');
  } else {
    console.log(`\n  claimed test_pairing_rate  ${report.claimed_rate}  (path shape only — a habit metric)`);
    console.log(`  verified share             ${report.verified_share}  (of decided replays, the share that truly detect)`);
    console.log(`  corrected rate             ${report.corrected_rate}`);
  }
  for (const row of report.rows) {
    if (row.verdict === 'decorative') {
      console.log(`\n  ✗ ${row.sha.slice(0, 8)} ${row.subject}`);
      console.log(`      passes on the parent — it does not catch this bug`);
    } else if (row.verdict === 'catches_by_binding') {
      console.log(`\n  ~ ${row.sha.slice(0, 8)} ${row.subject}`);
      console.log(`      only fails to load on the parent — no assertion caught the defect`);
    }
  }
  if (path) console.log(`\nsaved: ${path}`);
}
