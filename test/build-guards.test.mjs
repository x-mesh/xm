// Guards added/hardened in the x-build guard audit (F1 repoRoot, F2 rollback
// blast-radius, F3 exitFail library mode).
//
// These need ROOT to point inside a real git repo. ROOT is captured from
// X_BUILD_ROOT at core.mjs import time, and bun shares one process across test
// files — so setting process.env here would leak into every other test file.
// We run the checks in an isolated child process whose env carries X_BUILD_ROOT,
// keeping the parent (and sibling test files) clean.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = join(__dirname, '..', 'x-build', 'lib', 'x-build', 'core.mjs');

let repo;
let report;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'xb-guards-'));
  mkdirSync(join(repo, '.xm', 'build'), { recursive: true });
  const git = (c) => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe', shell: '/bin/bash' });
  git('init -q');
  git('config user.email t@t.com');
  git('config user.name T');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add -A && git commit -q -m c1');

  // Child runner: imports core with X_BUILD_ROOT = <repo>/.xm/build, exercises
  // each guard, prints a JSON report. Isolation means no env leak to siblings.
  const runner = `
    import * as core from ${JSON.stringify(CORE)};
    import { execSync } from 'node:child_process';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const repo = ${JSON.stringify(repo)};
    const git = (c) => execSync('git ' + c, { cwd: repo, stdio: 'pipe', shell: '/bin/bash' }).toString().trim();
    const read = (f) => readFileSync(join(repo, f), 'utf8');
    const out = {};
    out.repoRoot = core.repoRoot();

    // F2a: commit_sha === HEAD with a DIRTY tree → rollback proceeds AND reverts
    // the working tree. Asserting the file content reverts proves the reset
    // actually executed (a clean tree would make reset --hard a no-op that
    // passes even if the guard were removed).
    writeFileSync(join(repo, 'a.txt'), 'DIRTY\\n');
    const head1 = git('rev-parse HEAD');
    out.head1 = head1;
    out.rollbackHead = core.gitRollbackTask({ id: 't1', commit_sha: head1 });
    out.headAfterHeadRollback = git('rev-parse HEAD');
    out.aRevertedToCommitted = read('a.txt') === 'a\\n';

    // F2b: commit_sha is an ancestor (a later commit exists) → refused, c2 kept.
    const oldHead = git('rev-parse HEAD');
    writeFileSync(join(repo, 'b.txt'), 'b\\n');
    git('add -A && git commit -q -m c2');
    out.expectedNewHead = git('rev-parse HEAD');
    out.rollbackAncestor = core.gitRollbackTask({ id: 't2', commit_sha: oldHead });
    out.headAfterAncestorRollback = git('rev-parse HEAD');

    // F2c: detached HEAD pointing at c1 → rollback to c1 (== HEAD) proceeds,
    // confirming the guard does not spuriously refuse in detached state.
    git('checkout -q ' + oldHead);
    out.rollbackDetached = core.gitRollbackTask({ id: 't3', commit_sha: oldHead });

    // F3: library mode → exitFail throws CliError carrying the message instead
    // of exiting; restored to false so it can never kill a later caller.
    core.setLibraryMode(true);
    try { core.exitFail(1, 'boom'); out.exitThrew = false; }
    catch (e) { out.exitThrew = e instanceof core.CliError; out.exitCode = e.code; out.exitMsg = e.message; }

    // review #2: a guard's CliError thrown inside a modifyJSON mutator must
    // propagate, not get swallowed as lock contention (spin-wait 20× + re-run).
    const t0 = Date.now();
    try { core.modifyJSON(join(repo, 'mj.json'), () => { core.exitFail(1, 'guard-in-mutator'); }); out.modifyJsonThrew = false; }
    catch (e) { out.modifyJsonThrew = e instanceof core.CliError; }
    out.modifyJsonFast = (Date.now() - t0) < 200; // not the ~1s spin-wait path
    core.setLibraryMode(false);
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    env: { ...process.env, X_BUILD_ROOT: join(repo, '.xm', 'build') },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`runner failed: ${r.stderr || r.stdout}`);
  report = JSON.parse(r.stdout);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('F1 — repoRoot is the repo root, not .xm/', () => {
  test('repoRoot() resolves to the repo, two levels above ROOT', () => {
    expect(report.repoRoot).toBe(resolve(repo));
    expect(report.repoRoot).not.toBe(resolve(repo, '.xm')); // the old off-by-one
  });
});

describe('F2 — gitRollbackTask refuses to discard later commits', () => {
  test('rolls back when commit_sha IS current HEAD and actually reverts the tree', () => {
    expect(report.rollbackHead).toBe(true);
    expect(report.headAfterHeadRollback).toBe(report.head1); // HEAD unchanged
    expect(report.aRevertedToCommitted).toBe(true);          // dirty change discarded
  });

  test('refuses when commit_sha is an ancestor — later commit survives', () => {
    expect(report.rollbackAncestor).toBe(false);
    expect(report.headAfterAncestorRollback).toBe(report.expectedNewHead);
  });

  test('proceeds in detached-HEAD state when commit_sha equals HEAD', () => {
    expect(report.rollbackDetached).toBe(true);
  });
});

describe('F3 — exitFail honors library mode', () => {
  test('throws CliError (code + message) instead of exiting when library mode is on', () => {
    expect(report.exitThrew).toBe(true);
    expect(report.exitCode).toBe(1);
    expect(report.exitMsg).toBe('boom'); // message threading (review F4)
  });

  test('modifyJSON propagates a guard CliError instead of swallowing it (review #2)', () => {
    expect(report.modifyJsonThrew).toBe(true);
    expect(report.modifyJsonFast).toBe(true); // no 20× spin-wait
  });
});
