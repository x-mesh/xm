import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '..');
const PUSH = join(ROOT, 'x-sync', 'lib', 'x-sync', 'sync-push.mjs');
const PULL = join(ROOT, 'x-sync', 'lib', 'x-sync', 'sync-pull.mjs');
const BUILD = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');

async function run(script, args, cwd, env) {
  const proc = Bun.spawn(['node', script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

let fixture;
let server;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'xm-sync-handoff-e2e-'));
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(fixture, { recursive: true, force: true });
});

test('push on one machine becomes canonical handon state on another machine', async () => {
  const source = join(fixture, 'source', 'project');
  const target = join(fixture, 'target', 'project');
  const sourceBuild = join(source, '.xm', 'build');
  const targetBuild = join(target, '.xm', 'build');
  mkdirSync(sourceBuild, { recursive: true });
  mkdirSync(targetBuild, { recursive: true });

  const sourceState = {
    v: 1,
    saved_at: '2026-08-08T02:00:00.000Z',
    handoff_generation: 2,
    where: { branch: 'develop', last_commits: [] },
    what_done: [],
    what_remains: { active_projects: [], uncommitted: [], ideas: [] },
    decisions: [],
    context: { current_focus: 'restored-from-linux' },
    narrative: null,
    why_stopped: 'switch machine',
  };
  const targetOld = {
    ...sourceState,
    saved_at: '2026-08-08T03:00:00.000Z', // clock is ahead, but generation is older
    handoff_generation: 1,
    context: { current_focus: 'stale-local-mac' },
  };
  writeFileSync(join(sourceBuild, 'SESSION-STATE.json'), JSON.stringify(sourceState));
  writeFileSync(join(sourceBuild, 'HANDOFF.md'), '# Linux handoff');
  writeFileSync(join(sourceBuild, 'memmesh-mirror.json'), '{"status":"pending"}');
  writeFileSync(join(sourceBuild, 'SESSION-STATE.legacy-host.json'), JSON.stringify(targetOld));
  writeFileSync(join(targetBuild, 'SESSION-STATE.json'), JSON.stringify(targetOld));

  let pushed = null;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/sync/push') {
        pushed = await req.json();
        return Response.json({ accepted: pushed.files.length, skipped: 0, deleted: 0 });
      }
      if (req.method === 'GET' && url.pathname === '/sync/pull') {
        const files = (pushed?.files ?? []).map((file, index) => ({
          ...file,
          machine_id: pushed.machine_id,
          pushed_at: index + 1,
          deleted: 0,
        }));
        return Response.json({ files, cursor: files.length, server_time: Date.now() });
      }
      return new Response('not found', { status: 404 });
    },
  });

  const common = {
    XM_SYNC_SERVER_URL: `http://127.0.0.1:${server.port}`,
    XM_SYNC_API_KEY: 'test-key',
  };
  const pushedResult = await run(PUSH, ['--project', 'portable-project'], source, {
    ...common,
    XM_SYNC_MACHINE_ID: 'linux-x64',
  });
  expect(pushedResult.exitCode).toBe(0);
  expect(pushed.files.map((file) => file.path)).toContain('build/SESSION-STATE.json');
  expect(pushed.files.map((file) => file.path)).toContain('build/HANDOFF.md');
  expect(pushed.files.map((file) => file.path)).not.toContain('build/memmesh-mirror.json');
  expect(pushed.files.map((file) => file.path)).not.toContain('build/SESSION-STATE.legacy-host.json');

  const pulledResult = await run(PULL, ['--project', 'portable-project'], target, {
    ...common,
    XM_SYNC_MACHINE_ID: 'mac-arm64',
  });
  expect(pulledResult.exitCode).toBe(0);
  expect(pulledResult.stdout).toContain('handoff updated from linux-x64');

  const restored = await run(BUILD, ['handon', '--json'], target, {});
  expect(restored.exitCode).toBe(0);
  const restoredState = JSON.parse(restored.stdout);
  expect(restoredState.handoff_generation).toBe(2);
  expect(restoredState.context.current_focus).toBe('restored-from-linux');
  expect(readFileSync(join(targetBuild, 'HANDOFF.md'), 'utf8')).toContain('canonical, atomic session state');
});
