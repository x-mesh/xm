import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'xm', 'lib', 'x-local-fix-cli.mjs');

function writeRegistry(home, project) {
  mkdirSync(join(home, '.xm'), { recursive: true });
  writeFileSync(join(home, '.xm', 'projects.json'), JSON.stringify({ version: 1, projects: [project] }));
}

function runCli(args, { home, cwd, env = {} }) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: home, ...env }, timeout: 10000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('xm local-fix — sender outbox + target worktree preparation', () => {
  test('creates a sender audit record and a git-kit-managed target worktree without touching the target inbox', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-local-fix-home-'));
    const sender = mkdtempSync(join(tmpdir(), 'x-local-fix-sender-'));
    const target = mkdtempSync(join(tmpdir(), 'x-local-fix-target-'));
    const bin = mkdtempSync(join(tmpdir(), 'x-local-fix-bin-'));
    const worktree = join(target, 'managed-worktree');
    const log = join(target, 'git-kit.log');
    try {
      mkdirSync(join(target, '.xm'), { recursive: true });
      mkdirSync(join(target, '.mem-mesh'), { recursive: true });
      writeFileSync(join(target, '.mem-mesh', 'project-id'), 'target-project\n');
      writeRegistry(home, { id: 'target-project', name: 'target-project', path: target, archived: false });
      writeFileSync(join(bin, 'git-kit'), '#!/bin/sh\nmkdir -p "$LOCAL_FIX_WORKTREE"\nprintf "{\\\"state\\\":\\\"ok\\\",\\\"result\\\":{\\\"path\\\":\\\"%s\\\",\\\"branch\\\":\\\"%s\\\"}}\\n" "$LOCAL_FIX_WORKTREE" "$3"\nprintf "%s:%s\\n" "$GK_AGENT" "$*" > "$LOCAL_FIX_LOG"\n');
      spawnSync('chmod', ['+x', join(bin, 'git-kit')]);

      const result = runCli([
        'target-project', 'fix target now', '--command', 'repro', '--output', 'failed', '--fix', 'change target', '--json',
      ], {
        home, cwd: sender,
        env: { PATH: `${bin}:${process.env.PATH}`, LOCAL_FIX_WORKTREE: worktree, LOCAL_FIX_LOG: log },
      });

      expect(result.status).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.ok).toBe(true);
      expect(out.target_worktree).toBe(worktree);
      expect(out.branch).toBe(`local-fix/${out.item_id}`);
      expect(out.mcp_calls.pin_add.project_id).toBe('target-project');
      expect(out.mcp_calls.pin_add.tags).toEqual(['inbox', 'local-fix']);
      expect(existsSync(out.outbox_path)).toBe(true);
      expect(existsSync(join(target, '.xm', 'inbox'))).toBe(false);
      expect(readFileSync(log, 'utf8')).toContain(`1:worktree acquire local-fix/${out.item_id} --from HEAD --json`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(sender, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('keeps the sender outbox when worktree preparation fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-local-fix-home-'));
    const sender = mkdtempSync(join(tmpdir(), 'x-local-fix-sender-'));
    const target = mkdtempSync(join(tmpdir(), 'x-local-fix-target-'));
    const bin = mkdtempSync(join(tmpdir(), 'x-local-fix-bin-'));
    try {
      mkdirSync(join(target, '.xm'), { recursive: true });
      writeRegistry(home, { id: 'target-project', name: 'target-project', path: target, archived: false });
      writeFileSync(join(bin, 'git-kit'), '#!/bin/sh\necho unavailable >&2\nexit 1\n');
      spawnSync('chmod', ['+x', join(bin, 'git-kit')]);

      const result = runCli([
        'target-project', 'fix target now', '--command', 'repro', '--output', 'failed', '--fix', 'change target', '--json',
      ], { home, cwd: sender, env: { PATH: `${bin}:${process.env.PATH}` } });

      expect(result.status).toBe(1);
      const out = JSON.parse(result.stdout);
      expect(out.ok).toBe(false);
      expect(out.message).toContain('worktree preparation failed');
      expect(existsSync(out.capture.outboxPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(sender, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
