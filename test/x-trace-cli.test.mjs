// @ts-check
//
// x-trace-cli — isolated contract tests for the x-trace CLI.
//
// HOST-REPO POLLUTION IS FORBIDDEN. Precedent: gitAutoCommit tests once committed
// unstaged changes back into the host x-kit repo on every `bun test` run
// (x-build/lib/x-build/core.mjs). To avoid a repeat, every test here:
//   - creates its own git repo under os.tmpdir() with mkdtempSync (never the repo)
//   - spawns the CLI as a real subprocess with cwd=<temp repo> and
//     XM_ROOT=<temp repo>/.xm, so BOTH the ledger writes and every internal
//     `git`/gitSnapshot call target the temp repo, not the checked-out x-kit tree
//   - rm -rf's every temp dir in afterAll
// No test may git-init, commit, or write inside the checked-out x-kit tree, and
// nothing mutates process.cwd()/env of the test runner (isolation lives in the
// subprocess env), so tests are order-independent and parallel-safe.

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../x-trace/lib/x-trace-cli.mjs', import.meta.url));

/** @type {string[]} */
const tmpdirs = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-trace-cli-'));
  tmpdirs.push(dir);
  const git = (c) => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', shell: '/bin/bash' });
  git('init -q');
  git('config user.email t@t.com');
  git('config user.name T');
  git('commit -q --allow-empty -m c1');
  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, head };
}

function emptyCommit(dir, msg) {
  execSync(`git commit -q --allow-empty -m ${msg}`, { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

/** Run the CLI as a subprocess pinned to `dir` (cwd + XM_ROOT). Returns {code,stdout,stderr}. */
function runCli(dir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, XM_ROOT: join(dir, '.xm') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

afterAll(() => {
  for (const dir of tmpdirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpdirs.length = 0;
});

describe('record → last', () => {
  test('record reflects in `last` (human) and `last --json` (schema)', () => {
    const { dir, head } = makeRepo();

    const rec = runCli(dir, ['record', 'review', '--status', 'lgtm', '--note', 'ok']);
    expect(rec.code).toBe(0);
    expect(rec.stdout).toContain('recorded review');

    const human = runCli(dir, ['last', 'review']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('review:');
    expect(human.stdout).toContain(head.slice(0, 7)); // ref defaulted to current HEAD
    expect(human.stdout).toContain('lgtm');

    const json = runCli(dir, ['last', '--json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.review).toBeDefined();
    expect(parsed.review.ref).toBe(head);
    expect(parsed.review.head).toBe(head);
    expect(parsed.review.status).toBe('lgtm');
    expect(parsed.review.note).toBe('ok');
    // base is present in the schema (null on first record for this tool).
    expect('base' in parsed.review).toBe(true);
    expect(parsed.review.base).toBeNull();
  });

  test('explicit --ref overrides the HEAD default', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'build', '--ref', 'v1.2.3', '--status', 'released']);
    const json = JSON.parse(runCli(dir, ['last', '--json', 'build']).stdout);
    expect(json.build.ref).toBe('v1.2.3');
  });
});

describe('status', () => {
  test('reports N commits since the recorded HEAD', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'review', '--status', 'lgtm']);
    emptyCommit(dir, 'c2');
    emptyCommit(dir, 'c3');

    const status = runCli(dir, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('review:');
    expect(status.stdout).toContain('2 commits since');

    const json = JSON.parse(runCli(dir, ['status', '--json']).stdout);
    expect(json.review.commits_since).toBe(2);
    expect(json.review.chain_broken).toBe(false);
  });

  test('singular "1 commit" and zero right after record', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'op', '--status', 'done']);
    expect(runCli(dir, ['status']).stdout).toContain('0 commits since');
    emptyCommit(dir, 'c2');
    expect(runCli(dir, ['status']).stdout).toContain('1 commit since');
  });
});

describe('doctor --rebuild (AC3)', () => {
  test('reconstructs last.json from a git-bearing trace, skips legacy traces', () => {
    const { dir, head } = makeRepo();
    const tracesDir = join(dir, '.xm', 'traces');
    mkdirSync(tracesDir, { recursive: true });

    // A t1-shaped trace: session_start carries the skill, session_end carries git.head.
    const good = [
      JSON.stringify({ type: 'session_start', skill: 'review', args: {}, session_id: 'review-20260703-101010-aaaa', ts: '2026-07-03T10:10:10.000Z', v: 1 }),
      JSON.stringify({ type: 'session_end', status: 'success', git: { head, branch: 'main', dirty: false }, session_id: 'review-20260703-101010-aaaa', ts: '2026-07-03T10:10:12.000Z', v: 1 }),
    ].join('\n') + '\n';
    writeFileSync(join(tracesDir, 'review-20260703-101010-aaaa.jsonl'), good);

    // A legacy trace: no git field on session_end → not reconstructable, must be reported.
    const legacy = [
      JSON.stringify({ type: 'session_start', skill: 'op', args: {}, session_id: 'op-20260101-090000-bbbb', ts: '2026-01-01T09:00:00.000Z', v: 1 }),
      JSON.stringify({ type: 'session_end', status: 'success', session_id: 'op-20260101-090000-bbbb', ts: '2026-01-01T09:00:01.000Z', v: 1 }),
    ].join('\n') + '\n';
    writeFileSync(join(tracesDir, 'op-20260101-090000-bbbb.jsonl'), legacy);

    const rebuilt = runCli(dir, ['doctor', '--rebuild']);
    expect(rebuilt.code).toBe(0);
    expect(rebuilt.stdout).toContain('Rebuilt last.json: 1 tool');
    expect(rebuilt.stdout).toMatch(/1 legacy trace/); // op reported as non-reconstructable

    // The rebuilt ledger holds review with the trace's HEAD.
    const json = JSON.parse(runCli(dir, ['last', '--json']).stdout);
    expect(json.review).toBeDefined();
    expect(json.review.head).toBe(head);
    expect(json.review.status).toBe('rebuilt');
    expect(json.op).toBeUndefined();
  });

  test('doctor (no --rebuild) validates and flags nothing on a clean ledger', () => {
    const { dir } = makeRepo();
    runCli(dir, ['record', 'ship', '--status', 'ok']);
    const out = runCli(dir, ['doctor']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('1 tool');
    expect(out.stdout).toContain('✓ ship');
    expect(out.stdout).toContain('All records valid.');
  });
});

describe('empty-state honesty (A1)', () => {
  test('`last` on an empty ledger explains + notes coverage limits', () => {
    const { dir } = makeRepo();
    const out = runCli(dir, ['last']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('No tool activity recorded yet.');
    expect(out.stdout).toContain('기록되지 않은 활동이 있을 수 있음');
  });

  test('`status` on an empty ledger notes coverage limits', () => {
    const { dir } = makeRepo();
    const out = runCli(dir, ['status']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('기록되지 않은 활동이 있을 수 있음');
  });
});

describe('unknown tool (FM4)', () => {
  test('warns once but records anyway, exit 0', () => {
    const { dir } = makeRepo();
    const out = runCli(dir, ['record', 'frobnicate', '--status', 'x']);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain('is not a known tool');
    // Recorded despite the warning.
    const json = JSON.parse(runCli(dir, ['last', '--json', 'frobnicate']).stdout);
    expect(json.frobnicate).toBeDefined();
    expect(json.frobnicate.status).toBe('x');
  });
});

describe('lock contention (FM3)', () => {
  test('record warns and exits 0 when the last-store lock is held', () => {
    const { dir } = makeRepo();
    mkdirSync(join(dir, '.xm'), { recursive: true });
    // Pre-create a FRESH lock on last.json. last-store reclaims a lock only when
    // its mtime > 10s; the 50-attempt/~1s acquire window stays under that, so the
    // write provably throws — exercising the best-effort exit-0 path (FM3).
    const lockPath = join(dir, '.xm', 'last.json.lock');
    writeFileSync(lockPath, String(process.pid));

    const out = runCli(dir, ['record', 'review', '--status', 'lgtm']);
    expect(out.code).toBe(0); // best-effort: never fail the caller over a ledger write
    expect(out.stderr).toContain('best-effort');

    rmSync(lockPath, { force: true });
  });
});

describe('since <ref>', () => {
  test('lists tools recorded after the ref commit; usage error without a ref', () => {
    const { dir } = makeRepo();
    const base = emptyCommit(dir, 'base'); // ref boundary
    runCli(dir, ['record', 'eval', '--status', 'scored']); // recorded after base

    const out = runCli(dir, ['since', base]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('eval');

    const usage = runCli(dir, ['since']);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('Usage: xm trace since');
  });
});
