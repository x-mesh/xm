/**
 * x-inbox-cli.mjs — end-to-end CLI coverage for the t11 transport migration:
 * `xm toss ... --json` must capture + write the outbox and print an MCP call
 * payload WITHOUT ever touching the network, and `xm inbox record` must be
 * the only way a pin_id/memory_id lands back in a ledger file afterward.
 *
 * Runs the actual CLI script (`node x-inbox-cli.mjs <sub> ...`) in a real
 * subprocess with HOME redirected to a disposable temp dir, mirroring
 * x-inbox-target.test.mjs / x-inbox-toss.test.mjs's isolation pattern — this
 * also means these tests never touch the developer's real ~/.xm/projects.json
 * or this repo's own .xm/outbox / .xm/inbox.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'xm', 'lib', 'x-inbox-cli.mjs');

function writeRegistry(home, projects) {
  const dir = join(home, '.xm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'projects.json'),
    JSON.stringify({ version: 1, updated_at: new Date().toISOString(), projects }, null, 2) + '\n',
  );
}

function makeEntry(id, path, overrides = {}) {
  return {
    id,
    path,
    name: id,
    added_at: '2026-07-19T00:00:00.000Z',
    last_seen: '2026-07-19T00:00:00.000Z',
    tags: [],
    archived: false,
    ...overrides,
  };
}

function runCli(args, { home, cwd }) {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    cwd,
    timeout: 10000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('xm toss --json — capture only, zero network, prints MCP payload', () => {
  test('writes the outbox with an empty mem_mesh and prints pin_add/add args', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-cli-home-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-target-'));
    const senderDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-sender-'));
    try {
      mkdirSync(join(targetDir, '.xm'), { recursive: true });
      // Fix the target's mem-mesh identity to "git-kit" (see the identical
      // comment in x-inbox-toss.test.mjs) so mem_mesh_project_id below is
      // deterministic instead of falling back to a temp-dir basename.
      mkdirSync(join(targetDir, '.mem-mesh'), { recursive: true });
      writeFileSync(join(targetDir, '.mem-mesh', 'project-id'), 'git-kit\n');
      writeRegistry(home, [makeEntry('git-kit', targetDir)]);

      const { status, stdout, stderr } = runCli([
        'toss', 'git-kit', 'land reports paused as ok',
        '--command', 'GK_AGENT=1 git-kit land',
        '--output', 'state: ok\n',
        '--fix', 'check the state-collapse branch',
        '--json',
      ], { home, cwd: senderDir });

      expect(status).toBe(0);
      expect(stderr).toBe('');
      const parsed = JSON.parse(stdout);

      expect(parsed.ok).toBe(true);
      expect(parsed.mem_mesh_project_id).toBe('git-kit');
      expect(parsed.item_id).toMatch(/^toss-\d{8}-[a-f0-9]{8}$/);
      expect(parsed.mcp_calls.pin_add).toEqual({
        content: 'land reports paused as ok',
        project_id: 'git-kit',
        tags: ['inbox'],
        importance: 3,
      });
      expect(parsed.mcp_calls.add.project_id).toBe('git-kit');
      expect(parsed.mcp_calls.add.category).toBe('bug');
      expect(JSON.parse(parsed.mcp_calls.add.content).id).toBe(parsed.item_id);

      expect(existsSync(parsed.outbox_path)).toBe(true);
      const onDisk = JSON.parse(readFileSync(parsed.outbox_path, 'utf8'));
      expect(onDisk.mem_mesh).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
      rmSync(senderDir, { recursive: true, force: true });
    }
  });

  test('unregistered target: non-zero exit, --json still prints a structured reason', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-cli-home-'));
    const senderDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-sender-'));
    try {
      writeRegistry(home, []);

      const { status, stdout } = runCli([
        'toss', 'totally-unknown-xyz', 'title',
        '--command', 'cmd', '--output', 'out', '--fix', 'fix', '--json',
      ], { home, cwd: senderDir });

      expect(status).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe('unregistered');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(senderDir, { recursive: true, force: true });
    }
  });
});

describe('xm inbox record — the only write-back path for pin_id/memory_id (t11)', () => {
  test('round trip: toss --json, then record --pin-id/--memory-id into the same outbox item', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-cli-home-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-target-'));
    const senderDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-sender-'));
    try {
      mkdirSync(join(targetDir, '.xm'), { recursive: true });
      writeRegistry(home, [makeEntry('git-kit', targetDir)]);

      const tossOut = runCli([
        'toss', 'git-kit', 'title',
        '--command', 'cmd', '--output', 'out', '--fix', 'fix', '--json',
      ], { home, cwd: senderDir });
      const { item_id: itemId } = JSON.parse(tossOut.stdout);

      const recordOut = runCli([
        'record', itemId, '--pin-id', 'pin-abc', '--memory-id', 'mem-xyz', '--json',
      ], { home, cwd: senderDir });

      expect(recordOut.status).toBe(0);
      const parsed = JSON.parse(recordOut.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.item.mem_mesh).toEqual({ pin_id: 'pin-abc', memory_id: 'mem-xyz' });

      const outboxFile = join(senderDir, '.xm', 'outbox', `${itemId}.json`);
      const onDisk = JSON.parse(readFileSync(outboxFile, 'utf8'));
      expect(onDisk.mem_mesh).toEqual({ pin_id: 'pin-abc', memory_id: 'mem-xyz' });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
      rmSync(senderDir, { recursive: true, force: true });
    }
  });

  test('--scope inbox writes into .xm/inbox instead of .xm/outbox', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-cli-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-project-'));
    try {
      const inboxDir = join(projectDir, '.xm', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, 'toss-renotify-item.json'), JSON.stringify({
        id: 'toss-renotify-item',
        from_project: 'other-project',
        to_project: 'this-project',
        created_at: '2026-07-19T00:00:00.000Z',
        status: 'delivered',
        title: 'renotify me',
        why: '',
        repro: { command: 'cmd', output: 'out', truncated: false },
        anchors: { from_commit: null, to_files: [] },
        fix_direction: 'fix',
        mem_mesh: { pin_id: 'pin-old-dead' },
      }, null, 2));

      const recordOut = runCli([
        'record', 'toss-renotify-item', '--pin-id', 'pin-new', '--scope', 'inbox', '--json',
      ], { home, cwd: projectDir });

      expect(recordOut.status).toBe(0);
      const parsed = JSON.parse(recordOut.stdout);
      expect(parsed.item.mem_mesh.pin_id).toBe('pin-new');

      const onDisk = JSON.parse(readFileSync(join(inboxDir, 'toss-renotify-item.json'), 'utf8'));
      expect(onDisk.mem_mesh.pin_id).toBe('pin-new');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('unknown id: exit 1, clear error, no crash', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-cli-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-project-'));
    try {
      mkdirSync(join(projectDir, '.xm', 'outbox'), { recursive: true });

      const recordOut = runCli([
        'record', 'does-not-exist', '--pin-id', 'pin-1',
      ], { home, cwd: projectDir });

      expect(recordOut.status).toBe(1);
      expect(recordOut.stderr).toMatch(/does-not-exist/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('neither --pin-id nor --memory-id given: usage error, no write', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-cli-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-project-'));
    try {
      const recordOut = runCli(['record', 'some-id'], { home, cwd: projectDir });
      expect(recordOut.status).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('xm inbox list — never attempts network pin reconciliation (t11)', () => {
  test('lists local items with no pin-reconcile side effects, even with a stale pin_id', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-cli-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'x-inbox-cli-project-'));
    try {
      const inboxDir = join(projectDir, '.xm', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, 'toss-item.json'), JSON.stringify({
        id: 'toss-item',
        from_project: 'other-project',
        to_project: 'this-project',
        created_at: '2026-07-19T00:00:00.000Z',
        status: 'delivered',
        title: 'some report',
        why: '',
        repro: { command: 'cmd', output: 'out', truncated: false },
        anchors: { from_commit: null, to_files: [] },
        fix_direction: 'fix',
        mem_mesh: { pin_id: 'pin-nonexistent' },
      }, null, 2));

      const { status, stdout, stderr } = runCli(['list', '--json'], { home, cwd: projectDir });

      expect(status).toBe(0);
      expect(stderr).toBe('');
      const { items } = JSON.parse(stdout);
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('toss-item');
      // The pin_id is exactly what was on disk — list never queried or mutated it.
      expect(items[0].mem_mesh.pin_id).toBe('pin-nonexistent');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
