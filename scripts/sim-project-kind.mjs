#!/usr/bin/env node
/**
 * sim-project-kind.mjs — Deterministic validation of the project_kind gauge rule.
 *
 * Background (CLAUDE.md L9): a classification rule must be validated by
 * constructing REAL fixtures (mkdtemp + real fs/git state) and running the
 * REAL candidate detection logic over them, not decided by judgment alone.
 *
 * This is a STANDALONE simulator (per interface contract: no production-code
 * imports). It implements the 4-signal detection logic in this file, builds
 * 5 base cases + 2 edge cases as real temp directories (with real files and
 * real git repos), and reports a case × expected/actual classification matrix.
 *
 * Signals:
 *   1. manifest-present   — package.json/go.mod/Cargo.toml/pyproject.toml/pom.xml/
 *                            build.gradle(.kts)/Gemfile/composer.json, OR workspace
 *                            markers (pnpm-workspace.yaml/turbo.json/nx.json/
 *                            lerna.json). Searched UPWARD from the target dir,
 *                            bounded (see UPWARD_BOUND note below).
 *   2. lockfile-present    — bun.lockb/pnpm-lock.yaml/yarn.lock/package-lock.json/
 *                            poetry.lock/uv.lock/Cargo.lock/go.sum. Direct dir only.
 *   3. source-tree-present — src/lib/app/cmd/internal subdir containing at least
 *                            one real file (recursively). Direct dir only.
 *   4. git-history-present — `git rev-list --count HEAD` > 1.
 *
 * Decision rule: all 4 signals miss -> greenfield. Any 1+ hit -> brownfield.
 *   "Absence" (no git repo / 0 commits) is a MISS, not an error.
 *   "Judgment error" (git execution genuinely fails — e.g. git not on PATH) is
 *   a fail-safe OVERRIDE to brownfield, regardless of the other 3 signals.
 *
 * Usage: node scripts/sim-project-kind.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL DETECTORS (standalone reimplementation — mirrors the spec, not any
// production module; this file must not import x-build/lib/*)
// ═══════════════════════════════════════════════════════════════════════════

const MANIFEST_FILES = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'Gemfile', 'composer.json'];
const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'];
const GRADLE_PREFIX = 'build.gradle'; // build.gradle, build.gradle.kts
const LOCKFILES = ['bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'poetry.lock', 'uv.lock', 'Cargo.lock', 'go.sum'];
const SRC_DIR_NAMES = ['src', 'lib', 'app', 'cmd', 'internal'];

// Upward search is bounded, not walked to the filesystem root. Rationale
// (surfaced by this simulator, not assumed): an unbounded walk risks matching
// an unrelated ancestor manifest (e.g. the OS temp root's own parent chain,
// or a user's home directory) and misclassifying a genuinely-isolated project
// as brownfield. A monorepo package is realistically 1-3 levels below its
// workspace root; 6 levels leaves generous headroom without scanning to `/`.
const UPWARD_BOUND = 6;

function hasManifestAt(dir) {
  for (const f of MANIFEST_FILES) if (existsSync(join(dir, f))) return true;
  for (const f of WORKSPACE_MARKERS) if (existsSync(join(dir, f))) return true;
  try {
    for (const f of readdirSync(dir)) if (f.startsWith(GRADLE_PREFIX)) return true;
  } catch { /* unreadable dir — treat as no manifest here */ }
  return false;
}

function manifestPresentUpward(startDir, maxLevels) {
  let dir = resolve(startDir);
  for (let level = 0; level <= maxLevels; level++) {
    if (hasManifestAt(dir)) return { hit: true, level };
    const parent = dirname(dir);
    if (parent === dir) return { hit: false, level, reason: 'reached-fs-root' };
    dir = parent;
  }
  return { hit: false, level: maxLevels, reason: 'bound-exhausted' };
}

function lockfilePresent(dir) {
  return LOCKFILES.some((f) => existsSync(join(dir, f)));
}

function hasAnyFileRecursive(dir, depth = 0) {
  if (depth > 20) return false; // guard against pathological symlink loops
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile()) return true;
    if (e.isDirectory() && hasAnyFileRecursive(p, depth + 1)) return true;
  }
  return false;
}

function sourceTreePresent(dir) {
  for (const name of SRC_DIR_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        if (statSync(p).isDirectory() && hasAnyFileRecursive(p)) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

/**
 * git-history-present, with the "absence vs error" distinction required by
 * the spec:
 *   - no .git repo at all           -> MISS  (state: 'miss-no-repo')
 *   - repo exists, 0 commits (HEAD unborn) -> MISS (state: 'miss-zero-commits')
 *   - repo exists, exactly 1 commit -> MISS (rule is strictly > 1)
 *   - repo exists, >1 commits       -> HIT
 *   - git binary unreachable (ENOENT) or an unrecognized non-zero exit
 *     -> ERROR (fail-safe override candidate)
 */
function gitHistorySignal(dir, env) {
  // --max-count=2 (F9) + LC_ALL/LANG=C (F3) — mirrors
  // x-build/lib/x-build/core.mjs:pkGitHistorySignal exactly (interface
  // contract: this simulator's rules must stay in lockstep with production).
  const res = spawnSync('git', ['rev-list', '--count', '--max-count=2', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...(env || process.env), LC_ALL: 'C', LANG: 'C' },
  });
  if (res.error) {
    return { hit: false, state: 'error', detail: String(res.error.code || res.error.message) };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').toLowerCase();
    if (/not a git repository/.test(stderr)) return { hit: false, state: 'miss-no-repo' };
    if (/bad revision|unknown revision|ambiguous argument|does not have any commits/.test(stderr)) {
      return { hit: false, state: 'miss-zero-commits' };
    }
    return { hit: false, state: 'error', detail: stderr.trim().slice(0, 160) || `exit ${res.status}` };
  }
  const count = parseInt((res.stdout || '').trim(), 10) || 0;
  return { hit: count > 1, state: count > 1 ? 'hit' : 'miss-zero-commits', count };
}

function gaugeProjectKind(dir, gitEnv) {
  const manifest = manifestPresentUpward(dir, UPWARD_BOUND);
  const lockfile = lockfilePresent(dir);
  const sourceTree = sourceTreePresent(dir);
  const git = gitHistorySignal(dir, gitEnv);
  const signals = {
    'manifest-present': manifest.hit,
    'lockfile-present': lockfile,
    'source-tree-present': sourceTree,
    'git-history-present': git.hit,
  };
  if (git.state === 'error') {
    return { kind: 'brownfield', reason: `git judgment error override (${git.detail})`, signals, gitState: git.state };
  }
  const anyHit = Object.values(signals).some(Boolean);
  return {
    kind: anyHit ? 'brownfield' : 'greenfield',
    reason: anyHit ? 'signal hit' : 'all signals miss (absence)',
    signals,
    gitState: git.state,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE BUILDERS (real mkdtemp dirs, real files, real git repos)
// ═══════════════════════════════════════════════════════════════════════════

const ROOT = mkdtempSync(join(tmpdir(), 'sim-project-kind-'));
const BROKEN_PATH_ENV = { ...process.env, PATH: '/nonexistent-xyz-no-git-here' };

function freshDir(name) {
  const d = join(ROOT, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

function gitCommit(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=sim@test.local', '-c', 'user.name=sim', 'commit', '-q', '--no-gpg-sign', '-m', msg],
    { cwd: dir }
  );
}

// Case 1: empty dir
function buildCase1() {
  return freshDir('case1-empty');
}

// Case 2: README.md only
function buildCase2() {
  const d = freshDir('case2-readme-only');
  writeFileSync(join(d, 'README.md'), '# hello\n');
  return d;
}

// Case 3: git clone immediately after — many commits + manifest + lockfile + src
function buildCase3() {
  const d = freshDir('case3-clone');
  gitInit(d);
  writeFileSync(join(d, 'README.md'), '# project\n');
  gitCommit(d, 'init');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'index.js'), 'module.exports = {};\n');
  gitCommit(d, 'add source');
  writeFileSync(join(d, 'src', 'util.js'), 'module.exports.util = () => 1;\n');
  gitCommit(d, 'add util');
  return d;
}

// Case 4: monorepo child package — manifest + workspace marker ONLY at the
// parent; the child dir itself has neither its own manifest nor lockfile.
function buildCase4() {
  const root = freshDir('case4-monorepo-root');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'monorepo-root', private: true }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  gitInit(root);
  gitCommit(root, 'init monorepo');
  const child = join(root, 'packages', 'child-pkg');
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, 'index.js'), 'console.log("child, no own manifest");\n');
  gitCommit(root, 'add child pkg');
  return child; // gauge is run AGAINST THE CHILD dir
}

// Case 5: only a `.xm/` state dir present
function buildCase5() {
  const d = freshDir('case5-xm-only');
  mkdirSync(join(d, '.xm'), { recursive: true });
  writeFileSync(join(d, '.xm', 'state.json'), '{}');
  return d;
}

// Edge A: git not installed (simulated via a PATH with no git binary)
function buildEdgeA() {
  return freshDir('edgeA-no-git-binary');
}

// Edge B: git init just run, 0 commits
function buildEdgeB() {
  const d = freshDir('edgeB-zero-commits');
  gitInit(d);
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

const cases = [
  { name: 'Case 1: empty dir', dir: buildCase1(), env: process.env, expected: 'greenfield' },
  { name: 'Case 2: README.md only', dir: buildCase2(), env: process.env, expected: 'greenfield' },
  { name: 'Case 3: git clone (commits+manifest+lockfile+src)', dir: buildCase3(), env: process.env, expected: 'brownfield' },
  { name: 'Case 4: monorepo child pkg (manifest only at parent)', dir: buildCase4(), env: process.env, expected: 'brownfield' },
  { name: 'Case 5: .xm/ only', dir: buildCase5(), env: process.env, expected: 'greenfield' },
  { name: 'Edge A: git binary unreachable (PATH broken)', dir: buildEdgeA(), env: BROKEN_PATH_ENV, expected: 'brownfield' },
  { name: 'Edge B: git init, 0 commits', dir: buildEdgeB(), env: process.env, expected: 'greenfield' },
];

console.log('# project_kind Gauge Simulation\n');
console.log(`Fixture root: ${ROOT}\n`);

let misclassified = 0;
const rows = [];
for (const c of cases) {
  const result = gaugeProjectKind(c.dir, c.env);
  const ok = result.kind === c.expected;
  if (!ok) misclassified++;
  rows.push({ ...c, result, ok });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('Case', 46) +
    pad('Expected', 12) +
    pad('Actual', 12) +
    pad('Match', 7) +
    'Signals (manifest/lockfile/src-tree/git-hist) + gitState'
);
console.log('─'.repeat(46 + 12 + 12 + 7 + 58));
for (const r of rows) {
  const s = r.result.signals;
  const sigStr = `${s['manifest-present'] ? 'H' : 'm'}/${s['lockfile-present'] ? 'H' : 'm'}/${s['source-tree-present'] ? 'H' : 'm'}/${s['git-history-present'] ? 'H' : 'm'} (git:${r.result.gitState})`;
  console.log(
    pad(r.name, 46) + pad(r.expected, 12) + pad(r.result.kind, 12) + pad(r.ok ? 'OK' : 'MISMATCH', 7) + sigStr
  );
  if (!r.ok) console.log('    -> reason:', r.result.reason);
}

console.log(`\nMisclassifications: ${misclassified} / ${cases.length}`);
if (misclassified === 0) {
  console.log('RESULT: 0 misclassifications — signal definitions + decision rule CONFIRMED as-is.\n');
} else {
  console.log('RESULT: misclassification found — signal definitions need adjustment (see reasons above).\n');
}

console.log('## Confirmed Rule Table\n');
console.log('| Signal | Detection | Scope |');
console.log('|---|---|---|');
console.log(
  '| manifest-present | package.json/go.mod/Cargo.toml/pyproject.toml/pom.xml/build.gradle*/Gemfile/composer.json OR workspace marker (pnpm-workspace.yaml/turbo.json/nx.json/lerna.json) | upward search, bounded to 6 parent levels (NOT filesystem root — avoids ancestor false-positive) |'
);
console.log('| lockfile-present | bun.lockb/pnpm-lock.yaml/yarn.lock/package-lock.json/poetry.lock/uv.lock/Cargo.lock/go.sum | direct dir only |');
console.log('| source-tree-present | src/lib/app/cmd/internal subdir containing >=1 real file (recursive) | direct dir only |');
console.log('| git-history-present | `git rev-list --count HEAD` > 1 | direct dir (git auto-discovers upward via .git) |');
console.log('\n| Condition | Classification |');
console.log('|---|---|');
console.log('| all 4 signals miss | greenfield |');
console.log('| 1+ signal hit | brownfield |');
console.log('| no git repo / 0 commits (git-history signal only) | MISS (absence), not error |');
console.log('| git execution genuinely fails (ENOENT / unrecognized non-zero exit) | brownfield OVERRIDE regardless of other 3 signals |');

// Cleanup
rmSync(ROOT, { recursive: true, force: true });

process.exit(misclassified === 0 ? 0 : 1);
