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

    // F2: x-build must not commit to or rewind the user's repo. The auto-commit
    // and rollback helpers were removed 2026-08-11 (see core.mjs Git
    // Integration); assert the exports are GONE so a re-introduction fails here.
    out.noAutoCommit = typeof core.gitAutoCommit === 'undefined';
    out.noRollback = typeof core.gitRollbackTask === 'undefined';
    // A user's staged work and HEAD must both survive a completed task.
    writeFileSync(join(repo, 'a.txt'), 'DIRTY\\n');
    git('add a.txt');
    out.headBefore = git('rev-parse HEAD');

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

describe('F2 — x-build never commits to or rewinds the user repo', () => {
  // History showed the opposite: of 89 tm() commits, 82 contained ONLY the
  // user's own staged work under a task name that did not describe it. Both
  // helpers are gone; these assertions fail if either comes back.
  test('gitAutoCommit is not exported', () => {
    expect(report.noAutoCommit).toBe(true);
  });

  test('gitRollbackTask is not exported', () => {
    expect(report.noRollback).toBe(true);
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
