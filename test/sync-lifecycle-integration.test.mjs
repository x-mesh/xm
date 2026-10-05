import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const ROOT = join(import.meta.dir, '..');
let fixture, server, dashboard, database, url, key;
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const hash = text => createHash('sha256').update(text).digest('hex');
const materialized = (project, path) => join(fixture, 'data', project, '.xm', path);
function machine(name) { const cwd = join(fixture, name, 'project'); mkdirSync(join(cwd, '.xm'), { recursive: true }); return cwd; }
async function cli(kind, cwd, id, project, { success = true, serverUrl = url } = {}) {
  const home = join(fixture, 'homes', id); mkdirSync(home, { recursive: true });
  const proc = Bun.spawn(['node', join(ROOT, `x-sync/lib/x-sync/sync-${kind}.mjs`), '--project', project], {
    cwd, env: { ...process.env, HOME: home, XM_SYNC_SERVER_URL: serverUrl, XM_SYNC_API_KEY: key, XM_SYNC_MACHINE_ID: id }, stdout: 'pipe', stderr: 'pipe',
  });
  const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(status).toBe(success ? 0 : 1);
  return { status, stdout, stderr };
}
async function push(project, id, files) {
  const response = await fetch(`${url}/sync/push`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: project, machine_id: id, full_snapshot: true, files: files.map(([path, content]) => ({ path, content, hash: hash(content) })) }) });
  expect(response.status).toBe(200); return response.json();
}
async function rows(project) {
  const response = await fetch(`${url}/sync/pull?project_id=${project}&cursor=0`, { headers: { 'X-Api-Key': key } });
  expect(response.status).toBe(200); return (await response.json()).files;
}

beforeEach(async () => {
  fixture = mkdtempSync(join(tmpdir(), 'sync-lifecycle-'));
  key = randomBytes(24).toString('hex');
  dashboard = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  process.env.XM_SYNC_API_KEY = key;
  process.env.XM_SYNC_DB_PATH = join(fixture, 'sync.db');
  process.env.XM_SYNC_DATA_DIR = join(fixture, 'data');
  process.env.XM_DASHBOARD_URL = `http://127.0.0.1:${dashboard.port}`;
  cpSync(join(ROOT, 'x-sync/lib'), join(fixture, 'lib'), { recursive: true });
  const path = join(fixture, 'lib/x-sync-server.mjs');
  const source = readFileSync(path, 'utf8').replace('Bun.serve({ port: PORT, fetch: router });', "globalThis.syncLifecycleServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: router }); globalThis.syncLifecycleDb = db;");
  writeFileSync(path, source);
  await import(pathToFileURL(path).href);
  server = globalThis.syncLifecycleServer; database = globalThis.syncLifecycleDb;
  url = `http://127.0.0.1:${server.port}`;
});
afterEach(() => { server?.stop(true); dashboard?.stop(true); database?.close(); rmSync(fixture, { recursive: true, force: true }); });

test('server rejects raw absolute paths before storing a snapshot', async () => {
  const response = await fetch(`${url}/sync/push`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: 'absolute', machine_id: 'A', full_snapshot: true,
      files: [{ path: '/traces/item.jsonl', content: 'invalid', hash: hash('invalid') }] }) });
  expect(response.status).toBe(400);
  expect(await rows('absolute')).toHaveLength(0);
  await cli('pull', machine('B'), 'B', 'absolute');
});

test('an empty final snapshot deletes the last remote file', async () => {
  const a = machine('A'), b = machine('B');
  write(join(a, '.xm/traces/item.jsonl'), 'v1');
  await cli('push', a, 'A', 'empty'); await cli('pull', b, 'B', 'empty');
  rmSync(join(a, '.xm/traces/item.jsonl'));
  await cli('push', a, 'A', 'empty'); await cli('pull', b, 'B', 'empty');
  expect((await rows('empty')).filter(row => !row.deleted)).toHaveLength(0);
  expect(existsSync(join(b, '.xm/traces/item.jsonl'))).toBe(false);
});

test('remote updates replace tracked copies and never echo through another machine', async () => {
  const a = machine('A'), b = machine('B');
  write(join(a, '.xm/traces/item.jsonl'), 'v1');
  await cli('push', a, 'A', 'updates'); await cli('pull', b, 'B', 'updates');
  write(join(a, '.xm/traces/item.jsonl'), 'v2');
  await cli('push', a, 'A', 'updates'); await cli('pull', b, 'B', 'updates');
  expect(readFileSync(join(b, '.xm/traces/item.jsonl'), 'utf8')).toBe('v2');
  await cli('push', b, 'B', 'updates');
  expect((await rows('updates')).filter(row => !row.deleted).map(row => row.machine_id)).toEqual(['A']);
});

test('an imported update preserves owner-only file permissions', async () => {
  const b = machine('B'), path = 'traces/private.jsonl';
  await push('mode', 'A', [[path, 'v1']]); await cli('pull', b, 'B', 'mode');
  chmodSync(join(b, '.xm', path), 0o600);
  await push('mode', 'A', [[path, 'v2']]); await cli('pull', b, 'B', 'mode');
  expect(lstatSync(join(b, '.xm', path)).mode & 0o777).toBe(0o600);
});

test('remote deletion preserves both original local files and locally edited imported copies', async () => {
  const b = machine('B');
  write(join(b, '.xm/build/state.json'), 'local original');
  await push('local', 'A', [['build/state.json', 'remote']]); await cli('pull', b, 'B', 'local');
  expect(readFileSync(join(b, '.xm/build/state.json'), 'utf8')).toBe('local original');
  await push('local', 'A', []); await cli('pull', b, 'B', 'local');
  expect(readFileSync(join(b, '.xm/build/state.json'), 'utf8')).toBe('local original');
  expect(existsSync(join(b, '.xm/build/state.A.json'))).toBe(false);
  await push('local', 'A', [['traces/edited.jsonl', 'remote']]); await cli('pull', b, 'B', 'local');
  write(join(b, '.xm/traces/edited.jsonl'), 'local edit');
  await push('local', 'A', []); await cli('pull', b, 'B', 'local');
  expect(readFileSync(join(b, '.xm/traces/edited.jsonl'), 'utf8')).toBe('local edit');
});

test('cursor identity isolates projects and server URLs', async () => {
  await push('older', 'A', [['traces/old.jsonl', 'old']]);
  await push('newer', 'A', [['traces/new1.jsonl', 'new'], ['traces/new2.jsonl', 'new']]);
  const b = machine('B');
  await cli('pull', b, 'B', 'newer'); await cli('pull', b, 'B', 'older');
  expect(readFileSync(join(b, '.xm/traces/old.jsonl'), 'utf8')).toBe('old');
  let requestedCursor = null;
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => {
    requestedCursor = new URL(req.url).searchParams.get('cursor');
    return Response.json({ files: [{ path: 'traces/other.jsonl', machine_id: 'C', content: 'other', deleted: 0 }], cursor: 1, server_time: Date.now() });
  } });
  try { await cli('pull', b, 'B', 'older', { serverUrl: `http://127.0.0.1:${other.port}` }); } finally { other.stop(true); }
  expect(requestedCursor).toBe('0'); expect(readFileSync(join(b, '.xm/traces/other.jsonl'), 'utf8')).toBe('other');
});

test('a tombstone restores another active machine in the materialized view', async () => {
  await push('shared', 'A', [['build/state.json', 'A']]);
  await push('shared', 'B', [['build/state.json', 'B']]);
  await push('shared', 'A', []);
  expect(readFileSync(materialized('shared', 'build/state.json'), 'utf8')).toBe('B');
  await push('shared', 'B', []); expect(existsSync(materialized('shared', 'build/state.json'))).toBe(false);
});

test('materialization failure is nonzero and an identical retry repairs the missing file', async () => {
  const a = machine('A'); write(join(a, '.xm/blocked/item.json'), 'data');
  const blocker = materialized('repair', 'blocked'); write(blocker, 'blocker');
  await cli('push', a, 'A', 'repair', { success: false });
  expect(existsSync(join(a, '.xm/.sync-state.json'))).toBe(false);
  rmSync(blocker);
  await cli('push', a, 'A', 'repair');
  expect(readFileSync(materialized('repair', 'blocked/item.json'), 'utf8')).toBe('data');
});

test('pull rejects symlink escapes without advancing its cursor', async () => {
  const b = machine('B'), outside = join(fixture, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(b, '.xm/traces'), 'dir');
  await push('symlink', 'A', [['traces/escape.jsonl', 'bad']]);
  await cli('pull', b, 'B', 'symlink', { success: false });
  expect(existsSync(join(outside, 'escape.jsonl'))).toBe(false);
  expect(existsSync(join(b, '.xm/.sync-state.json'))).toBe(false);
});

test('push excludes worktrees, nested repositories and temporary gate source copies', async () => {
  const a = machine('A');
  write(join(a, '.xm/merge-review/pr1/src/secret.js'), 'source');
  write(join(a, '.xm/another-repo/.git'), 'gitdir: fake'); write(join(a, '.xm/another-repo/src/a.js'), 'source');
  write(join(a, '.xm/review/runs/example/verification-work/src/a.js'), 'source');
  write(join(a, '.xm/traces/good.jsonl'), 'state');
  await cli('push', a, 'A', 'scope');
  expect((await rows('scope')).filter(row => !row.deleted).map(row => row.path)).toEqual(['traces/good.jsonl']);
});

test('legacy untracked local files survive a first pull and remote tombstone', async () => {
  const b = machine('B'); write(join(b, '.xm/traces/legacy.jsonl'), 'ambiguous old copy');
  write(join(b, '.xm/.sync-state.json'), JSON.stringify({ last_pull_cursor: 9999, last_pull_project: 'legacy' }));
  await push('legacy', 'A', [['traces/legacy.jsonl', 'remote new']]); await cli('pull', b, 'B', 'legacy');
  expect(readFileSync(join(b, '.xm/traces/legacy.jsonl'), 'utf8')).toBe('ambiguous old copy');
  expect(readFileSync(join(b, '.xm/traces/legacy.A.jsonl'), 'utf8')).toBe('remote new');
  await push('legacy', 'A', []); await cli('pull', b, 'B', 'legacy');
  expect(readFileSync(join(b, '.xm/traces/legacy.jsonl'), 'utf8')).toBe('ambiguous old copy');
  expect(existsSync(join(b, '.xm/traces/legacy.A.jsonl'))).toBe(false);
});

test('locally edited namespaced copies stay protected from echo after update and deletion', async () => {
  const b = machine('B'); write(join(b, '.xm/build/state.json'), 'local');
  await push('edited-ns', 'A', [['build/state.json', 'v1']]); await cli('pull', b, 'B', 'edited-ns');
  write(join(b, '.xm/build/state.A.json'), 'local annotations');
  await push('edited-ns', 'A', [['build/state.json', 'v2']]); await cli('pull', b, 'B', 'edited-ns');
  await cli('push', b, 'B', 'edited-ns');
  expect((await rows('edited-ns')).filter(row => !row.deleted && row.machine_id === 'B').map(row => row.path)).toEqual(['build/state.json']);
  expect(readFileSync(join(b, '.xm/build/state.A.json'), 'utf8')).toBe('local annotations');
  await push('edited-ns', 'A', []); await cli('pull', b, 'B', 'edited-ns'); await cli('push', b, 'B', 'edited-ns');
  expect((await rows('edited-ns')).filter(row => !row.deleted && row.machine_id === 'B').map(row => row.path)).toEqual(['build/state.json']);
});

test('pending pull ownership survives an interrupted write and prevents echo on restart', async () => {
  const b = machine('B'), path = 'traces/pending.jsonl';
  await push('pending', 'A', [[path, 'remote']]);
  const scopeKey = JSON.stringify([url, 'pending', 'B']);
  const importKey = JSON.stringify(['A', path]);
  write(join(b, '.xm/.sync-state.json'), JSON.stringify({ pull_scopes: { [scopeKey]: { cursor: 0, imports: { [importKey]: { machine_id: 'A', path, target: path, hash: hash('remote'), previous_hash: null, pending: true } } } } }));
  write(join(b, '.xm', path), 'remote');
  await cli('push', b, 'B', 'pending');
  expect((await rows('pending')).filter(row => !row.deleted).map(row => row.machine_id)).toEqual(['A']);
  await cli('pull', b, 'B', 'pending');
  const state = JSON.parse(readFileSync(join(b, '.xm/.sync-state.json')));
  expect(state.pull_scopes[scopeKey].imports[importKey].pending).toBe(false);
  expect(state.pull_scopes[scopeKey].cursor).toBeGreaterThan(0);
  await cli('push', b, 'B', 'pending');
  expect((await rows('pending')).filter(row => !row.deleted).map(row => row.machine_id)).toEqual(['A']);
});

test('server refuses materialization through a project symlink without changing the database', async () => {
  const outside = join(fixture, 'outside'); mkdirSync(outside);
  mkdirSync(join(fixture, 'data'), { recursive: true }); symlinkSync(outside, join(fixture, 'data/linked'), 'dir');
  const response = await fetch(`${url}/sync/push`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: 'linked', machine_id: 'A', full_snapshot: true, files: [{ path: 'traces/item.jsonl', content: 'bad', hash: hash('bad') }] }) });
  expect(response.status).toBe(400); expect((await rows('linked')).filter(row => !row.deleted)).toHaveLength(0);
  expect(existsSync(join(outside, '.xm/traces/item.jsonl'))).toBe(false);
});

test('handoff and lesson paths obey the same symlink boundary as ordinary pulls', async () => {
  for (const kind of ['handoff', 'lesson']) {
    const b = machine(kind), outside = join(fixture, `outside-${kind}`); mkdirSync(outside);
    const path = kind === 'handoff' ? 'build/SESSION-STATE.json' : 'humble/lessons/L1.json';
    const dir = kind === 'handoff' ? 'build' : 'humble/lessons';
    mkdirSync(dirname(join(b, '.xm', dir)), { recursive: true }); symlinkSync(outside, join(b, '.xm', dir), 'dir');
    const content = kind === 'handoff' ? JSON.stringify({ saved_at: '2026-10-01T00:00:00Z', handoff_generation: 1 }) : JSON.stringify({ id: 'L1', status: 'active' });
    await push(kind, 'A', [[path, content]]); await cli('pull', b, 'B', kind, { success: false });
    expect(existsSync(join(outside, kind === 'handoff' ? 'SESSION-STATE.json' : 'L1.json'))).toBe(false);
  }
});

test('standalone server and client packages include their runtime dependencies', async () => {
  const home = join(fixture, 'install-home'), bin = join(fixture, 'install-bin'); mkdirSync(bin);
  const curl = join(bin, 'curl');
  write(curl, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const url=args.find(x=>x.startsWith('https://'));const dest=args[args.indexOf('-o')+1];const rel=url.split('/main/')[1];fs.copyFileSync(path.join(${JSON.stringify(ROOT)},rel),dest);
`);
  chmodSync(curl, 0o755);
  for (const mode of ['server', 'client']) {
    const proc = Bun.spawn(['bash', join(ROOT, 'x-sync/install.sh'), mode], { cwd: ROOT, env: { ...process.env, HOME: home, XM_BIN_DIR: bin, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' });
    const [status, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(status).toBe(0);
    expect(err).toBe('');
  }
  const installed = join(home, '.local/share/x-sync');
  for (const name of ['x-sync-server.mjs', 'sync-push.mjs', 'sync-pull.mjs']) {
    const proc = Bun.spawn(['bun', 'build', join(installed, name), '--target', 'bun', '--outfile', join(fixture, `${name}.bundle`)], { stdout: 'pipe', stderr: 'pipe' });
    const [status, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(status).toBe(0);
  }
  const layout = join(fixture, 'docker/sync');
  write(join(layout, 'x-sync-server.mjs'), readFileSync(join(ROOT, 'x-sync/lib/x-sync-server.mjs')));
  write(join(layout, 'x-sync/sync-storage.mjs'), readFileSync(join(ROOT, 'x-sync/lib/x-sync/sync-storage.mjs')));
  const dockerfile = readFileSync(join(ROOT, 'x-sync/Dockerfile'), 'utf8');
  expect(dockerfile).toContain('COPY x-sync/lib/x-sync/sync-storage.mjs ./sync/x-sync/');
  const build = Bun.spawn(['bun', 'build', join(layout, 'x-sync-server.mjs'), '--target', 'bun', '--outfile', join(fixture, 'docker-server.bundle')], { stdout: 'pipe', stderr: 'pipe' });
  const [status, out, err] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  expect(status).toBe(0);
});
