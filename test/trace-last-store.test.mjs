// @ts-check
//
// trace-last-store — isolation tests for gitSnapshot + last-store (.xm/last.json).
//
// HOST-REPO POLLUTION IS FORBIDDEN. Precedent: gitAutoCommit tests once committed
// unstaged changes back into the host x-kit repo on every `bun test` run
// (x-build/lib/x-build/core.mjs:468-475). To avoid a repeat, every test here:
//   - creates its own repo/dir with mkdtempSync (under os.tmpdir(), never the repo)
//   - points writes at that dir via XM_ROOT (+ chdir only for git-reachability tests)
//   - restores cwd/env in finally and rm -rf's temp dirs in afterAll
// No test may git-init, commit, or write inside the checked-out x-kit tree.

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitSnapshot, sessionStart, sessionEnd } from '../x-trace/lib/x-trace/trace-writer.mjs';
import { lastWrite, lastRead } from '../x-trace/lib/x-trace/last-store.mjs';

const LAST_STORE_SRC = fileURLToPath(new URL('../x-trace/lib/x-trace/last-store.mjs', import.meta.url));

/** @type {string[]} */
const tmpdirs = [];

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-last-store-'));
  tmpdirs.push(dir);
  return dir;
}

/** Init a git repo in `dir` with one empty commit; returns HEAD sha. */
function gitInit(dir) {
  const git = (c) => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', shell: '/bin/bash' });
  git('init -q');
  git('config user.email t@t.com');
  git('config user.name T');
  git('commit -q --allow-empty -m c1');
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

function emptyCommit(dir, msg) {
  execSync(`git commit -q --allow-empty -m ${msg}`, { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

/** Run fn with XM_ROOT + cwd pinned to `dir`, so both trace writes and git
 *  reachability checks (which use process.cwd()) target the temp repo. */
function inRepo(dir, fn) {
  const prevCwd = process.cwd();
  const prevRoot = process.env.XM_ROOT;
  process.chdir(dir);
  process.env.XM_ROOT = join(dir, '.xm');
  try {
    return fn();
  } finally {
    process.chdir(prevCwd);
    if (prevRoot === undefined) delete process.env.XM_ROOT;
    else process.env.XM_ROOT = prevRoot;
  }
}

/** Run fn with only XM_ROOT pinned (no git needed). */
function withXmRoot(dir, fn) {
  const prevRoot = process.env.XM_ROOT;
  process.env.XM_ROOT = join(dir, '.xm');
  try {
    return fn();
  } finally {
    if (prevRoot === undefined) delete process.env.XM_ROOT;
    else process.env.XM_ROOT = prevRoot;
  }
}

afterAll(() => {
  for (const dir of tmpdirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpdirs.length = 0;
});

describe('last-store — base chaining', () => {
  test('second record.base equals first record.head', () => {
    const dir = makeTmp();
    const sha1 = gitInit(dir);
    inRepo(dir, () => lastWrite('review', { ref: sha1, head: sha1, status: 'lgtm' }));

    const sha2 = emptyCommit(dir, 'c2');
    const rec2 = inRepo(dir, () => lastWrite('review', { ref: sha2, head: sha2, status: 'lgtm' }));

    expect(rec2.base).toBe(sha1);
    expect(rec2.head).toBe(sha2);
    // sha1 is a real ancestor of sha2 → chain is intact, no flag.
    expect(rec2.chain_broken).toBeUndefined();
  });
});

describe('last-store — chain_broken (FM6)', () => {
  test('previous head absent from repo → chain_broken:true', () => {
    const dir = makeTmp();
    const realHead = gitInit(dir);
    const fakeHead = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // 40 hex, not a real object

    // First record stores the fake head; second chains base=fakeHead.
    inRepo(dir, () => lastWrite('review', { ref: 'x', head: fakeHead, status: 'ok' }));
    const rec2 = inRepo(dir, () => lastWrite('review', { ref: 'y', head: realHead, status: 'ok' }));

    expect(rec2.base).toBe(fakeHead);
    expect(rec2.chain_broken).toBe(true);
  });
});

describe('last-store — concurrent writers (lock)', () => {
  test('10 parallel lastWrite processes → valid JSON, no lost updates', async () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.xm'), { recursive: true });

    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(
      runnerPath,
      `import { lastWrite } from ${JSON.stringify(LAST_STORE_SRC)};\n` +
      `const tool = process.argv[2];\n` +
      `lastWrite(tool, { ref: 'r-' + tool, head: 'h-' + tool, status: 'ok', note: 'n-' + tool });\n`,
    );

    const spawnWriter = (tool) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runnerPath, tool], {
          cwd: dir,
          env: { ...process.env, XM_ROOT: join(dir, '.xm') },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tool} exited ${code}: ${err}`))));
      });

    await Promise.all(Array.from({ length: 10 }, (_, i) => spawnWriter(`tool${i}`)));

    // File must be valid JSON (proves no torn write) and hold all 10 writes
    // (proves no lost update — a failed lock would drop concurrent tools).
    const raw = readFileSync(join(dir, '.xm', 'last.json'), 'utf8');
    const store = JSON.parse(raw);
    for (let i = 0; i < 10; i++) {
      expect(store.tools[`tool${i}`]).toBeDefined();
      expect(store.tools[`tool${i}`].ref).toBe(`r-tool${i}`);
    }
  });
});

describe('last-store — corrupt file recovery (FM2)', () => {
  test('lastRead warns + returns empty map; lastWrite preserves .bak and rebuilds', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.xm'), { recursive: true });
    const lastJson = join(dir, '.xm', 'last.json');
    writeFileSync(lastJson, 'not json {{{ broken');

    const read = withXmRoot(dir, () => lastRead());
    expect(read).toEqual({ tools: {} });

    const rec = withXmRoot(dir, () => lastWrite('review', { ref: 'r1', head: 'h1', status: 'ok' }));
    expect(rec.ref).toBe('r1');

    // Corrupt content preserved to .bak; live file is valid and holds the record.
    expect(existsSync(lastJson + '.bak')).toBe(true);
    expect(readFileSync(lastJson + '.bak', 'utf8')).toBe('not json {{{ broken');
    const rebuilt = JSON.parse(readFileSync(lastJson, 'utf8'));
    expect(rebuilt.tools.review.ref).toBe('r1');
  });
});

describe('gitSnapshot — null safety (FM1)', () => {
  test('non-git directory → all fields null, no throw', () => {
    const dir = makeTmp(); // plain temp dir, never git-init'd
    const snap = gitSnapshot(dir);
    expect(snap).toEqual({ head: null, branch: null, dirty: null });
  });

  test('git repo → head sha, branch name, dirty boolean', () => {
    const dir = makeTmp();
    const head = gitInit(dir);
    const snap = gitSnapshot(dir);
    expect(snap.head).toBe(head);
    expect(typeof snap.branch).toBe('string');
    expect(typeof snap.dirty).toBe('boolean');
    expect(snap.dirty).toBe(false); // clean tree right after commit
  });
});

describe('trace-writer — session entries carry git snapshot', () => {
  test('session_start and session_end include a git field in a repo', () => {
    const dir = makeTmp();
    const head = gitInit(dir);

    inRepo(dir, () => {
      const sid = 'review-20260703-000000-abcd';
      sessionStart(sid, 'review', { target: 'PR' });
      sessionEnd(sid, { totalDurationMs: 5, agentCount: 1 });

      const file = join(dir, '.xm', 'traces', `${sid}.jsonl`);
      const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const start = lines.find((l) => l.type === 'session_start');
      const end = lines.find((l) => l.type === 'session_end');

      expect(start.git).toBeDefined();
      expect(start.git.head).toBe(head);
      expect(start.v).toBe(1); // schema version unchanged
      expect(end.git).toBeDefined();
      expect(end.git.head).toBe(head);
    });
  });
});
