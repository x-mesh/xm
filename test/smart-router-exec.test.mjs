/**
 * Smart Router — Step 1 is a program, so run it.
 *
 * The context-detection block in references/review-workflow.md is executed
 * verbatim by the review skill and decides the entire review scope. Until this
 * file existed it was pinned only by substring assertions, which cannot tell a
 * correct block from a broken one: a real edit once left the block with an
 * unterminated quote — `bash -n` rejected it — while every string assertion
 * stayed green, because `grep -qE` and `HEAD~` were both still present
 * somewhere in the file.
 *
 * Each case builds a throwaway repo, sources the extracted block, and asserts
 * the resulting BASE / LAST_REVIEW. `gh` is stubbed per-case through PATH so no
 * test ever reaches the network.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, 'x-review', 'skills', 'review', 'references', 'review-workflow.md');
const FENCE = '`'.repeat(3);

/** Extract the one bash fence under the Smart Router heading. */
function extractBlock() {
  const doc = readFileSync(WORKFLOW, 'utf8');
  const section = doc.split('## Smart Router — Step 1')[1];
  if (!section) throw new Error('Smart Router — Step 1 section is missing');
  const fences = section.split(FENCE).length - 1;
  if (fences !== 2) throw new Error(`expected exactly one fenced block, found ${fences} fence markers`);
  const match = section.match(new RegExp(`${FENCE}bash\\n([\\s\\S]*?)${FENCE}`));
  if (!match) throw new Error('no ```bash block under the Smart Router heading');
  return match[1];
}

let BLOCK;
beforeAll(() => {
  BLOCK = extractBlock();
});

// A signing or hooks setting in the developer's global git config would fail
// these fixtures for reasons unrelated to the block under test, and a suite
// that goes red for unrelated reasons gets skipped — reopening the regression.
const HERMETIC_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...HERMETIC_GIT } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir, branch = 'main') {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

function commit(dir, name) {
  writeFileSync(join(dir, name), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', name);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * Run the block in `cwd` and return its resulting variables.
 * `gh` is always stubbed: `ghOutput` null means "no PR" (exit 1).
 */
function runBlock(cwd, ghOutput = null, ledgerRef = null) {
  const stub = mkdtempSync(join(tmpdir(), 'xm-router-bin-'));
  const gh = join(stub, 'gh');
  writeFileSync(
    gh,
    ghOutput === null
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\ncat <<'GH_EOF'\n${ghOutput}\nGH_EOF\n`,
  );
  chmodSync(gh, 0o755);
  // `xm` yields nothing unless a case pins a recorded ledger ref.
  const xm = join(stub, 'xm');
  writeFileSync(
    xm,
    ledgerRef === null
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\ncat <<'XM_EOF'\n{"review":{"ref":"${ledgerRef}"}}\nXM_EOF\n`,
  );
  chmodSync(xm, 0o755);

  const script = `${BLOCK}\nprintf 'BASE=%s\\nLAST_REVIEW=%s\\nPR_NUM=%s\\nPR_BASE=%s\\n' "$BASE" "$LAST_REVIEW" "$PR_NUM" "$PR_BASE"\n`;
  const r = spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC_GIT, PATH: `${stub}:${process.env.PATH}` },
  });
  rmSync(stub, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`block exited ${r.status}: ${r.stderr}`);
  const out = {};
  for (const line of r.stdout.trim().split('\n')) {
    const eq = line.indexOf('=');
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Files `git diff BASE..HEAD` would review. */
function scopeFrom(dir, base) {
  if (!base) return null;
  const r = spawnSync('git', ['diff', '--name-only', `${base}..HEAD`], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC_GIT },
  });
  if (r.status !== 0) return 'GIT_DIFF_FAILED';
  return r.stdout.trim().split('\n').filter(Boolean).sort().join(' ');
}

function withTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-router-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('Smart Router — Step 1 executes correctly', () => {
  test('the fenced block is valid shell', () => {
    // The guard that string assertions cannot provide.
    const r = spawnSync('bash', ['-n'], { input: BLOCK, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('a branch cut from develop is diffed against develop, not main', () => {
    withTmp((tmp) => {
      const up = initRepo(join(tmp, 'up'));
      commit(up, 'released.txt');
      git(up, 'checkout', '-qb', 'develop');
      for (const n of ['d1.txt', 'd2.txt', 'd3.txt', 'd4.txt', 'd5.txt']) commit(up, n);
      git(up, 'checkout', '-q', 'main'); // upstream HEAD points at main, as x-kit's does

      const clone = join(tmp, 'clone');
      git(tmp, 'clone', '-q', up, clone);
      git(clone, 'fetch', '-q', 'origin', 'develop');
      git(clone, 'checkout', '-q', '-b', 'feature/x', 'origin/develop');
      commit(clone, 'only-change.txt');

      expect(git(clone, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).toBe('origin/main');

      const { BASE } = runBlock(clone);
      // First-match-wins would pick origin/main and drag in all five d*.txt.
      expect(scopeFrom(clone, BASE)).toBe('only-change.txt');
    });
  });

  test('resolves a base when only origin/main exists', () => {
    withTmp((tmp) => {
      const up = initRepo(join(tmp, 'up'));
      commit(up, 'base.txt');
      const clone = join(tmp, 'clone');
      git(tmp, 'clone', '-q', up, clone);
      git(clone, 'checkout', '-qb', 'feature/y');
      commit(clone, 'work.txt');
      git(clone, 'branch', '-D', '-q', 'main');

      const { BASE } = runBlock(clone);
      expect(BASE).not.toBe('');
      expect(scopeFrom(clone, BASE)).toBe('work.txt');
    });
  });

  test('leaves BASE empty when no candidate resolves, so priority 2 is skipped', () => {
    withTmp((tmp) => {
      const repo = initRepo(join(tmp, 'solo'), 'trunk');
      commit(repo, 'a.txt');
      git(repo, 'checkout', '-qb', 'feature/z');
      commit(repo, 'b.txt');

      const { BASE } = runBlock(repo);
      expect(BASE).toBe('');
    });
  });

  test('skips a candidate that already contains HEAD instead of reporting no changes', () => {
    withTmp((tmp) => {
      // main fast-forwards onto the feature tip, so merge-base(origin/main, HEAD)
      // IS HEAD. Without the guard that candidate scores N=0, wins outright, and
      // `git diff HEAD..HEAD` reports an empty review of a branch with real work.
      const up = initRepo(join(tmp, 'up'));
      commit(up, 'released.txt');
      git(up, 'checkout', '-qb', 'develop');
      commit(up, 'unreleased.txt');
      git(up, 'checkout', '-qb', 'feature/m');
      const tip = commit(up, 'work.txt');
      git(up, 'checkout', '-q', 'main');
      git(up, 'merge', '--ff-only', '-q', tip);

      const clone = join(tmp, 'clone');
      git(tmp, 'clone', '-q', up, clone);
      git(clone, 'fetch', '-q', 'origin', 'develop');
      git(clone, 'checkout', '-q', '-b', 'feature/m', tip);

      // Precondition: origin/main really does contain HEAD.
      expect(git(clone, 'merge-base', 'origin/main', 'HEAD')).toBe(git(clone, 'rev-parse', 'HEAD'));

      const { BASE } = runBlock(clone);
      expect(BASE).not.toBe(git(clone, 'rev-parse', 'HEAD'));
      expect(scopeFrom(clone, BASE)).toBe('work.txt');
    });
  });

  test('a PR base outside the static candidate list still wins', () => {
    withTmp((tmp) => {
      // The PR base must NOT be one of main/master/develop: with `develop` the
      // static entry decides the outcome, and this case passes even with the
      // PR-derived candidate deleted from the loop entirely.
      const up = initRepo(join(tmp, 'up'));
      commit(up, 'released.txt');
      git(up, 'checkout', '-qb', 'release/1.x');
      commit(up, 'rel.txt');
      git(up, 'checkout', '-q', 'main');

      const clone = join(tmp, 'clone');
      git(tmp, 'clone', '-q', up, clone);
      git(clone, 'fetch', '-q', 'origin', 'release/1.x');
      git(clone, 'checkout', '-q', '-b', 'feature/pr', 'origin/release/1.x');
      commit(clone, 'pr-change.txt');

      const { PR_NUM, PR_BASE, BASE } = runBlock(clone, '17\nrelease/1.x');
      expect(PR_NUM).toBe('17');
      expect(PR_BASE).toBe('release/1.x');
      // Without the PR candidate the nearest static one is origin/main, which
      // pulls rel.txt in as if it were part of this branch's change.
      expect(scopeFrom(clone, BASE)).toBe('pr-change.txt');
    });
  });

  test('PR detection does not depend on an external jq', () => {
    withTmp((tmp) => {
      const repo = initRepo(join(tmp, 'repo'));
      commit(repo, 'a.txt');
      // A PATH without jq: the block must still read the PR fields, because gh's
      // own -q runs its embedded query engine.
      const stub = mkdtempSync(join(tmpdir(), 'xm-router-nojq-'));
      for (const [name, body] of [
        ['gh', "#!/bin/sh\ncat <<'GH_EOF'\n42\nmain\nGH_EOF\n"],
        ['xm', '#!/bin/sh\nexit 1\n'],
        ['jq', '#!/bin/sh\necho "jq: command not found" >&2\nexit 127\n'],
      ]) {
        const p = join(stub, name);
        writeFileSync(p, body);
        chmodSync(p, 0o755);
      }
      const script = `${BLOCK}\nprintf 'PR_NUM=%s\\nPR_BASE=%s\\n' "$PR_NUM" "$PR_BASE"\n`;
      const r = spawnSync('bash', ['-c', script], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ...HERMETIC_GIT, PATH: `${stub}:${process.env.PATH}` },
      });
      rmSync(stub, { recursive: true, force: true });
      expect(r.stdout).toContain('PR_NUM=42');
      expect(r.stdout).toContain('PR_BASE=main');
    });
  });

  test('a tag sharing a branch name cannot shadow the branch', () => {
    withTmp((tmp) => {
      // git resolves a bare refname through refs/tags BEFORE refs/heads, and this
      // block sends the resulting ambiguity warning to /dev/null. Here the tag sits
      // ON the feature history, one commit nearer HEAD than the branch it shadows,
      // so nearest-wins scoring actively prefers it and drops real work from scope.
      const repo = initRepo(join(tmp, 'shadow'), 'develop');
      commit(repo, 'a.txt'); // develop stays here
      git(repo, 'checkout', '-q', '-b', 'feature/s');
      const nearer = commit(repo, 'b.txt');
      git(repo, 'tag', 'develop', nearer); // tag named like the branch, nearer to HEAD
      commit(repo, 'c.txt');

      // Preconditions: the names really do disagree, and the tag really does win a
      // bare lookup.
      expect(git(repo, 'rev-parse', 'refs/heads/develop')).not.toBe(nearer);
      expect(git(repo, 'rev-parse', 'refs/tags/develop')).toBe(nearer);

      const { BASE } = runBlock(repo);
      // b.txt is unreviewed work on this branch; a bare `develop` drops it.
      expect(scopeFrom(repo, BASE)).toBe('b.txt c.txt');
    });
  });

  test('a repo shorter than the window keeps the root commit in scope', () => {
    withTmp((tmp) => {
      const repo = initRepo(join(tmp, 'shallow'));
      for (const n of ['c1.txt', 'c2.txt', 'c3.txt']) commit(repo, n);

      const { LAST_REVIEW } = runBlock(repo);
      expect(LAST_REVIEW).not.toBe('HEAD~10');
      // Falling back to the root COMMIT instead of the empty tree silently drops
      // the root's own file from the review.
      expect(scopeFrom(repo, LAST_REVIEW)).toBe('c1.txt c2.txt c3.txt');
    });
  });

  test('a single-commit repo does not diff HEAD against itself', () => {
    withTmp((tmp) => {
      const repo = initRepo(join(tmp, 'solo-commit'));
      commit(repo, 'only.txt');

      const { LAST_REVIEW } = runBlock(repo);
      expect(LAST_REVIEW).not.toBe(git(repo, 'rev-parse', 'HEAD'));
      expect(scopeFrom(repo, LAST_REVIEW)).toBe('only.txt');
    });
  });

  test('an unreachable ledger ref falls back to the window, not to all history', () => {
    withTmp((tmp) => {
      // The hex format gate passes an orphaned SHA, so only the reachability
      // check stands between it and the diff. Falling to the start of history
      // here would review all twenty commits instead of the last ten.
      const repo = initRepo(join(tmp, 'orphan'));
      for (let i = 1; i <= 20; i += 1) commit(repo, `f${i}.txt`);

      const { LAST_REVIEW } = runBlock(repo, null, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      expect(LAST_REVIEW).toBe(git(repo, 'rev-parse', 'HEAD~10'));
      const scope = scopeFrom(repo, LAST_REVIEW);
      expect(scope).not.toBe('GIT_DIFF_FAILED');
      expect(scope.split(' ')).toHaveLength(10);
    });
  });
});
