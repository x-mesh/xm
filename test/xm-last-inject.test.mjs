// @ts-check
//
// xm-last-inject — black-box tests for the SessionStart hook
// (.claude/hooks/xm-last-inject.sh). The hook is run as a real bash subprocess
// with the same env the Claude Code harness supplies (CLAUDE_PROJECT_DIR + a
// pinned HOME), so these tests exercise exactly what ships.
//
// FM7 contract under test: EVERY path prints one line of valid JSON and exits 0.
// The happy path emits a SessionStart additionalContext; every failure/empty
// path emits a bare `{}`. Nothing may hang, throw, or write to stderr-as-output.
//
// HOST POLLUTION IS FORBIDDEN. The hook + the x-trace CLI it drives resolve
// .xm/ via XM_ROOT and scan the plugin cache via $HOME. Every test therefore:
//   - points XM_ROOT at a throwaway mkdtemp dir (never the repo's .xm/)
//   - pins HOME to a throwaway dir so the cache scan lands in temp / no-ops
//   - only ever READS the repo tree (running the CLI from source)
//   - rm -rf's every temp dir in afterAll
// The one repo reference is CLAUDE_PROJECT_DIR=REPO so the hook finds the
// source-tree CLI; the CLI writes solely under XM_ROOT.

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(REPO, '.claude', 'hooks', 'xm-last-inject.sh');
const CLI = join(REPO, 'x-trace', 'lib', 'x-trace-cli.mjs');

// jq is a hard dependency of the hook; without it the hook degrades to `{}`.
// Detect once so the happy-path assertion adapts instead of failing spuriously
// on a machine that lacks jq.
const HAS_JQ = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

const HEAD_SHA = execSync('git rev-parse HEAD', { cwd: REPO, encoding: 'utf8' }).trim();

/** @type {string[]} */
const tmpdirs = [];
function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
});

/** Run the hook as bash + return { status, stdout, stderr }. */
function runHook(env = {}) {
  return spawnSync('bash', [HOOK], {
    cwd: REPO,
    env: { PATH: process.env.PATH, HOME: makeTmp('xm-inject-home-'), ...env },
    encoding: 'utf8',
  });
}

/** Seed a per-tool record into an isolated XM_ROOT via the real CLI. */
function seed(xmRoot, tool, ref, status) {
  const r = spawnSync(process.execPath, [CLI, 'record', tool, '--ref', ref, '--status', status], {
    cwd: REPO,
    env: { PATH: process.env.PATH, HOME: makeTmp('xm-inject-seedhome-'), XM_ROOT: xmRoot },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
}

describe('xm-last-inject SessionStart hook', () => {
  test('emits SessionStart additionalContext when the ledger has records', () => {
    const xmRoot = makeTmp('xm-inject-root-');
    seed(xmRoot, 'review', HEAD_SHA, 'reviewed');
    seed(xmRoot, 'build', HEAD_SHA, 'phase-2 done');

    const r = runHook({ XM_ROOT: xmRoot, CLAUDE_PROJECT_DIR: REPO });
    expect(r.status).toBe(0);

    // Always valid JSON, regardless of jq availability.
    const out = JSON.parse(r.stdout);

    if (!HAS_JQ) {
      // Documented degrade path: no jq -> no injection, never a crash.
      expect(out).toEqual({});
      return;
    }

    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    // Both seeded tools surface, one line each, carrying ref + status.
    expect(ctx).toContain('review:');
    expect(ctx).toContain('reviewed');
    expect(ctx).toContain('build:');
    expect(ctx).toContain('phase-2 done');
    expect(ctx).toContain(HEAD_SHA.slice(0, 7));
    // commits_since resolves for the current HEAD -> "0 commits ago".
    expect(ctx).toContain('commits ago');
  });

  test('emits {} when the x-trace CLI cannot be located', () => {
    // CLAUDE_PROJECT_DIR points at an empty dir (no source/mirror) and HOME is a
    // throwaway (no plugin cache), so CLI discovery finds nothing.
    const noProject = makeTmp('xm-inject-noproj-');
    const r = runHook({ CLAUDE_PROJECT_DIR: noProject, HOME: makeTmp('xm-inject-nocli-home-') });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });

  test('emits {} when the ledger is empty (no recorded activity)', () => {
    // Fresh XM_ROOT with no records -> `last --json` yields {} -> no-op.
    const xmRoot = makeTmp('xm-inject-empty-');
    const r = runHook({ XM_ROOT: xmRoot, CLAUDE_PROJECT_DIR: REPO });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });
});
