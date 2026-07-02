/**
 * t9 — `review-integration`: build a main...develop patch, run gate-panel policy
 * under the reserved __integration__ id / release phase, warn on oversize patch.
 *
 * The panel is faked via X_BUILD_PANEL_ARGV (gate-panel reuses that same hook),
 * so no real multi-model panel runs. A temp git repo supplies the two branches.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIG_ROOT = process.env.X_BUILD_ROOT;
const ORIG_PANEL = process.env.X_BUILD_PANEL_ARGV;

let repo;
const gitq = (c) => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe', shell: '/bin/bash' });

const wt = await import('../../x-build/lib/x-build/worktrees.mjs');
const PROJECT = 'demo';

// Fake panel that emits a clean verdict regardless of args (node -e ignores them).
const CLEAN_PANEL = "process.stdout.write(JSON.stringify({run:'ri-clean',counts:{},consensus:[],confirmed:[],contested:[],unreviewed:[]}))";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'wt-ri-'));
  gitq('init -q -b main');
  gitq('config user.email t@t.com');
  gitq('config user.name T');
  writeFileSync(join(repo, 'f.txt'), 'base\n');
  gitq('add -A && git commit -q -m c1');
  gitq('checkout -q -b develop');
  writeFileSync(join(repo, 'feature.txt'), 'new feature line\n');
  gitq('add -A && git commit -q -m feat');

  process.env.X_BUILD_ROOT = join(repo, '.xm', 'build');
  process.env.X_BUILD_PANEL_ARGV = JSON.stringify(['node', '-e', CLEAN_PANEL]);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (ORIG_ROOT !== undefined) process.env.X_BUILD_ROOT = ORIG_ROOT; else delete process.env.X_BUILD_ROOT;
  if (ORIG_PANEL !== undefined) process.env.X_BUILD_PANEL_ARGV = ORIG_PANEL; else delete process.env.X_BUILD_PANEL_ARGV;
});

describe('reviewIntegration', () => {
  test('builds main...develop patch, runs release gate, passes clean', () => {
    const out = wt.reviewIntegration({ project: PROJECT, base: 'main', target: 'develop', cwd: repo });
    expect(out.patch_bytes).toBeGreaterThan(0);
    expect(out.empty).toBe(false);
    expect(out.gate.decision).toBe('pass');
    expect(out.gate.task_id).toBe('__integration__');
    expect(out.gate.phase).toBe('release');
    expect(out.exit_code).toBe(0);
    expect(out.size_warning).toBe(null);

    // patch artifact + panel-release.json under __integration__
    expect(existsSync(out.patch_path)).toBe(true);
    expect(readFileSync(out.patch_path, 'utf8')).toContain('feature.txt');
    expect(existsSync(out.artifact_path)).toBe(true);
    expect(out.artifact_path).toContain('__integration__');
    expect(out.artifact_path).toContain('panel-release.json');
  });

  test('emits a size warning when patch exceeds the configured cap', () => {
    const out = wt.reviewIntegration({ project: PROJECT, base: 'main', target: 'develop', cwd: repo, maxPatchBytes: 1 });
    expect(out.size_warning).toBeTruthy();
    expect(out.size_warning).toContain('exceeds configured cap');
    // size guard warns only — it never flips the gate decision
    expect(out.gate.decision).toBe('pass');
  });

  test('INTEGRATION_TASK_ID is the reserved namespace id', () => {
    expect(wt.INTEGRATION_TASK_ID).toBe('__integration__');
  });
});
