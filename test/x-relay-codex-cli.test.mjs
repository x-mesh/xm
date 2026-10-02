import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalRepoPath, parseArgs } from '../xm/lib/x-relay-cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'xm', 'lib', 'x-relay-cli.mjs');
const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';
const THREAD_C = '44444444-4444-4444-8444-444444444444';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function serverFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function readClientFrames(state, onText) {
  while (state.buffer.length >= 6) {
    let length = state.buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { length = state.buffer.readUInt16BE(2); offset = 4; }
    if (state.buffer.length < offset + 4 + length) return;
    const mask = state.buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(state.buffer.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]));
    state.buffer = state.buffer.subarray(offset + 4 + length);
    onText(payload.toString('utf8'));
  }
}

function startFakeDaemon(socketPath, threads) {
  const server = net.createServer(socket => {
    const state = { buffer: Buffer.alloc(0), upgraded: false };
    socket.on('data', chunk => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      if (!state.upgraded) {
        const end = state.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(state.buffer.subarray(0, end).toString())[1];
        const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        state.buffer = state.buffer.subarray(end + 4);
        state.upgraded = true;
      }
      readClientFrames(state, text => {
        const request = JSON.parse(text);
        if (request.id == null) return;
        let result = {};
        if (request.method === 'thread/list') result = { data: threads, nextCursor: null };
        if (request.method === 'thread/read') result = { thread: threads.find(t => t.id === request.params.threadId) || null };
        socket.write(serverFrame(JSON.stringify({ id: request.id, result })));
      });
    });
    socket.on('error', () => {});
  });
  return new Promise(resolve => server.listen(socketPath, () => resolve(server)));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xmr-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  const other = join(root, 'other');
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(other);
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init'], repo);
  git(['worktree', 'add', '-q', '-b', 'linked', worktree], repo);
  mkdirSync(join(home, '.xm'));
  writeFileSync(join(home, '.xm', 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'target', name: 'target', path: repo, archived: false }] }));
  const capture = join(root, 'queue.json');
  const socketPath = join(root, 'd.sock');
  const fake = join(root, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'app-server' && args[1] === 'daemon') {
  if (process.env.FAKE_DAEMON_DOWN === '1') process.exit(1);
  process.stdout.write(JSON.stringify({ status: 'running', socketPath: process.env.FAKE_DAEMON_SOCKET }) + '\\n');
} else if (args[0] === 'queue') {
  writeFileSync(process.env.FAKE_QUEUE_CAPTURE, JSON.stringify(args));
  if (process.env.FAKE_QUEUE_FAIL === '1') { process.stderr.write('queue refused'); process.exit(1); }
  process.stdout.write('Queued message 33333333-3333-4333-8333-333333333333 for thread ' + args[args.indexOf('--thread') + 1] + '.\\n');
} else process.exit(2);
`);
  chmodSync(fake, 0o755);
  const threads = [
    { id: THREAD_A, cwd: worktree, name: 'same repository', updatedAt: 1, status: { type: 'notLoaded' } },
    { id: THREAD_B, cwd: other, name: 'other repository', updatedAt: 2, status: { type: 'notLoaded' } },
    { id: THREAD_C, cwd: repo, name: 'open in daemon', updatedAt: 0, status: { type: 'idle' } },
  ];
  return { root, home, repo, worktree, fake, capture, socketPath, threads };
}

async function withFixture(fn) {
  const f = fixture();
  const server = await startFakeDaemon(f.socketPath, f.threads);
  try { await fn(f); }
  finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(f.root, { recursive: true, force: true });
  }
}

function run(f, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], {
      cwd: f.root,
      env: { ...process.env, HOME: f.home, XM_RELAY_CODEX_BIN: f.fake, FAKE_DAEMON_SOCKET: f.socketPath, FAKE_QUEUE_CAPTURE: f.capture, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`relay CLI timed out: ${stderr}`)); }, 10000);
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, output: JSON.parse(status === 0 ? stdout : stderr) });
    });
  });
}

describe('Codex relay CLI', () => {
  test('lists saved thread candidates from the daemon and matches a linked worktree to its registered repository', async () => {
    await withFixture(async f => {
      expect(canonicalRepoPath(f.worktree)).toBe(canonicalRepoPath(f.repo));
      const result = await run(f, ['sessions', '--project', 'target']);
      expect(result.status).toBe(0);
      expect(result.output.sessions.map(row => row.thread_id)).toEqual([THREAD_C, THREAD_A]);
      expect(result.output.sessions.every(row => row.live_status === 'unverified')).toBe(true);
      expect(result.output.partial).toBe(false);
    });
  });

  test('marks daemon-loaded threads and lists them before newer unloaded ones', async () => {
    await withFixture(async f => {
      const result = await run(f, ['sessions']);
      expect(result.status).toBe(0);
      expect(result.output.sessions.map(row => [row.thread_id, row.app_server_status, row.loaded])).toEqual([
        [THREAD_C, 'idle', true],
        [THREAD_B, 'notLoaded', false],
        [THREAD_A, 'notLoaded', false],
      ]);
    });
  });

  test('queues literal message-file bytes for an exact thread and reports queued only', async () => {
    await withFixture(async f => {
      const message = 'literal $HOME `whoami` and a newline\n';
      const file = join(f.root, 'message.txt');
      writeFileSync(file, message);
      const result = await run(f, ['send', '--thread', THREAD_A, '--message-file', file, '--project', 'target']);
      expect(result.status).toBe(0);
      expect(result.output.state).toBe('queued');
      expect(result.output.submission_id).toBe('33333333-3333-4333-8333-333333333333');
      const args = JSON.parse(readFileSync(f.capture, 'utf8'));
      expect(args[args.indexOf('--message') + 1]).toBe(message);
    });
  });

  test('refuses wrong-project targets and unavailable daemon before queueing', async () => {
    await withFixture(async f => {
      const wrong = await run(f, ['send', '--thread', THREAD_B, '--message', 'hello', '--project', 'target']);
      expect(wrong.status).toBe(1);
      expect(wrong.output.error).toContain('not in project');
      const down = await run(f, ['send', '--thread', THREAD_A, '--message', 'hello'], { FAKE_DAEMON_DOWN: '1' });
      expect(down.status).toBe(1);
      expect(down.output.error).toContain('daemon is unavailable');
      expect(() => readFileSync(f.capture)).toThrow();
    });
  });

  test('fails loudly when the daemon socket refuses connections', async () => {
    await withFixture(async f => {
      const result = await run(f, ['sessions'], { FAKE_DAEMON_SOCKET: join(f.root, 'missing.sock') });
      expect(result.status).toBe(1);
      expect(result.output.error).toContain('ENOENT');
    });
  });

  test('rejects ambiguous or missing input without creating a queue submission', () => {
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message', 'a', '--message-file', 'b'])).toThrow();
    expect(() => parseArgs(['sessions', '--thread', THREAD_A])).toThrow();
  });
});
