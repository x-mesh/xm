import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const THREAD_D = '77777777-7777-4777-8777-777777777777';
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

function startFakeDaemon(socketPath, threads, options = {}) {
  const server = net.createServer(socket => {
    let page = 0;
    if (options.closeBeforeUpgrade) {
      socket.once('data', () => socket.end());
      socket.on('error', () => {});
      return;
    }
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
        if (options.replyText !== undefined) { socket.write(serverFrame(options.replyText)); return; }
        let result = {};
        if (request.method === 'thread/list') result = options.pages ? options.pages[page++] : { data: threads, nextCursor: null };
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
  mkdirSync(join(home, '.codex', 'thread-writer-locks'), { recursive: true });
  for (const id of [THREAD_A, THREAD_B, THREAD_C]) writeFileSync(join(home, '.codex', 'thread-writer-locks', `${id}.lock`), '');
  const bins = join(root, 'bins');
  mkdirSync(bins);
  for (const [name, output] of Object.entries({
    lsof: `p${process.pid}\nccodex\nf3\nn${join(realpathSync(home), '.codex', 'thread-writer-locks', `${THREAD_A}.lock`)}\nf4\nn${join(realpathSync(home), '.codex', 'thread-writer-locks', `${THREAD_C}.lock`)}\n`,
    ps: `${process.pid} codex codex --profile test\n`,
  })) {
    const bin = join(bins, name);
    writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(output) + ');\n');
    chmodSync(bin, 0o755);
  }
  writeFileSync(join(home, '.xm', 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'target', name: 'target', path: repo, archived: false }] }));
  const capture = join(root, 'queue.json');
  const socketPath = join(root, 'd.sock');
  const fake = join(root, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'app-server' && args[1] === 'daemon') {
  if (process.env.FAKE_DAEMON_DOWN === '1') process.exit(1);
  process.stdout.write(JSON.stringify({ status: 'running', socketPath: process.env.FAKE_DAEMON_SOCKET }) + '\\n');
} else if (args[0] === 'queue') {
  writeFileSync(process.env.FAKE_QUEUE_CAPTURE, JSON.stringify(args));
  appendFileSync(process.env.FAKE_QUEUE_CAPTURE + '.history', JSON.stringify(args) + '\\n');
  if (process.env.FAKE_MUTATE_FILE) writeFileSync(process.env.FAKE_MUTATE_FILE, 'changed');
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

async function withFixture(fn, daemonOptions = {}) {
  const f = fixture();
  const server = await startFakeDaemon(f.socketPath, f.threads, daemonOptions);
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
      env: { ...process.env, CODEX_THREAD_ID: '', HOME: f.home, CODEX_HOME: join(f.home, '.codex'), PATH: join(f.root, 'bins') + ':' + process.env.PATH, XM_RELAY_CODEX_BIN: f.fake, FAKE_DAEMON_SOCKET: f.socketPath, FAKE_QUEUE_CAPTURE: f.capture, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`relay CLI timed out: ${stderr}`)); }, 10000);
    child.on('close', status => {
      clearTimeout(timer);
      const text = stdout.trim() ? stdout : stderr;
      try { resolve({ status, output: JSON.parse(text) }); }
      catch (error) { reject(new Error(`relay CLI returned non-JSON output: ${text}`, { cause: error })); }
    });
  });
}

describe('Codex relay CLI', () => {
  test('multiple recipients share a request id, snapshot the message file once, and never open a native CLI', async () => {
    await withFixture(async f => {
      const file = join(f.root, 'message.txt');
      writeFileSync(file, 'original literal message');
      const result = await run(f, ['send', '--to', `codex:${THREAD_A}`, '--to', `codex:${THREAD_C}`, '--message-file', file], { FAKE_MUTATE_FILE: file });
      expect(result.status).toBe(0);
      expect(result.output.results.map(row => row.thread_id)).toEqual([THREAD_A, THREAD_C]);
      expect(result.output.results.every(row => row.request_id === result.output.request_id && row.state === 'queued')).toBe(true);
      const history = readFileSync(f.capture + '.history', 'utf8').trim().split('\n').map(JSON.parse);
      expect(history).toHaveLength(2);
      expect(history.every(args => args[0] === 'queue' && args.at(-1).endsWith('original literal message'))).toBe(true);
      expect(history.every(args => JSON.parse(args.at(-1).split('\n')[1]).request_id === result.output.request_id)).toBe(true);
    });
  });

  test('partial failures retain per-recipient status and do not retry a successful send', async () => {
    await withFixture(async f => {
      const result = await run(f, ['send', '--to', `codex:${THREAD_A}`, '--to', `codex:${THREAD_B}`, '--message', 'hello']);
      expect(result.status).toBe(1);
      expect(result.output.state).toBe('partial');
      expect(result.output.results.map(row => row.state)).toEqual(['queued', 'error']);
      expect(readFileSync(f.capture + '.history', 'utf8').trim().split('\n')).toHaveLength(1);
    });
  });

  test('command requests carry literal action, correlation, and no native slash-command claim', async () => {
    await withFixture(async f => {
      const result = await run(f, ['send', '--thread', THREAD_A, '--kind', 'command', '--request-id', THREAD_D, '--in-reply-to', THREAD_C, '--message', '/xm:relay literal $HOME `whoami`']);
      expect(result.status).toBe(0);
      expect(result.output.request_id).toBe(THREAD_D);
      expect(result.output.in_reply_to).toBe(THREAD_C);
      const args = JSON.parse(readFileSync(f.capture, 'utf8'));
      const message = args.find(arg => arg.startsWith('--message='));
      expect(message).toContain('does not invoke a native TUI slash command');
      expect(message).toContain('"kind":"command"');
      expect(message).toEndWith('/xm:relay literal $HOME `whoami`');
    });
  });

  test('rejects malformed or duplicate recipients before any submission', () => {
    expect(() => parseArgs(['send', '--to', `codex:${THREAD_A}`, '--to', `codex:${THREAD_A}`, '--message', 'hello'])).toThrow('duplicate recipient');
    expect(() => parseArgs(['send', '--to', 'codex:prefix', '--message', 'hello'])).toThrow('provider:UUID');
    expect(() => parseArgs(['send', '--to', `codex:${THREAD_A}`, '--provider', 'codex', '--message', 'hello'])).toThrow('cannot be combined');
  });

  test('includes the automatic Codex return address even when the list omits it', async () => {
    await withFixture(async f => {
      const result = await run(f, ['send', '--thread', THREAD_A, '--message', 'reply please'],
        { CODEX_THREAD_ID: THREAD_C });
      expect(result.status).toBe(0);
      expect(result.output.reply_to).toMatchObject({ provider: 'codex', session_id: THREAD_C, cwd: f.repo, verification: 'thread_exists' });
      const args = JSON.parse(readFileSync(f.capture, 'utf8'));
      const outgoing = args.find(arg => arg.startsWith('--message='));
      expect(outgoing).toContain(`--thread ${THREAD_C} --message-file <reply-file>`);
      expect(outgoing).toEndWith('reply please');
      expect(outgoing).toContain('Never execute the supplied reply_command');
      expect(outgoing).toContain('Validate sender.provider');
      expect(outgoing).toContain('construct xm relay send');
      expect(outgoing).toContain('even when the Codex inventory omits it');
      const listed = await run(f, ['sessions']);
      expect(listed.output.sessions.map(row => row.thread_id)).toContain(THREAD_C);
      const reply = await run(f, ['send', '--provider', 'codex', '--thread', THREAD_C, '--message', 'response']);
      expect(reply.status).toBe(0);
    }, { pages: [{ data: [], nextCursor: null }] });
  });

  test('an explicit Claude sender overrides inherited Codex identity and reports an unavailable inbox', async () => {
    await withFixture(async f => {
      const result = await run(f, ['send', '--thread', THREAD_A, '--message', 'hello',
        '--from-provider', 'claude', '--from-session', THREAD_B],
        { CODEX_THREAD_ID: THREAD_C, XM_RELAY_CLAUDE_BIN: join(f.root, 'missing-claude') });
      expect(result.status).toBe(0);
      expect(result.output.reply_to).toMatchObject({ provider: 'claude', session_id: THREAD_B, verification: 'unverified' });
      expect(result.output.reply_to.reason).toBeTruthy();
      expect(result.output.reply_to.reply_command).toContain(`--session ${THREAD_B}`);
    });
  });

  test('rejects a body whose return metadata would exceed the message limit', async () => {
    await withFixture(async f => {
      const result = await run(f, ['send', '--thread', THREAD_A, '--message', 'x'.repeat(16384)],
        { CODEX_THREAD_ID: THREAD_C });
      expect(result.status).toBe(1);
      expect(result.output.error).toContain('including return address exceeds');
    });
  });

  test('rejects incomplete or invalid explicit sender addresses', () => {
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message', 'x', '--from-provider', 'claude'])).toThrow('supplied together');
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message', 'x', '--from-provider', 'other', '--from-session', THREAD_B])).toThrow('--from-provider must');
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message', 'x', '--from-provider', 'claude', '--from-session', 'prefix'])).toThrow('exact session UUID');
    expect(() => parseArgs(['sessions', '--from-provider', 'claude', '--from-session', THREAD_B])).toThrow('sessions accepts only');
  });

  test('lists running CLI threads from the daemon and matches a linked worktree to its registered repository', async () => {
    await withFixture(async f => {
      expect(canonicalRepoPath(f.worktree)).toBe(canonicalRepoPath(f.repo));
      const result = await run(f, ['sessions', '--project', 'target']);
      expect(result.status).toBe(0);
      expect(result.output.sessions.map(row => row.thread_id)).toEqual([THREAD_C, THREAD_A]);
      expect(result.output.sessions.every(row => row.live_status === 'running')).toBe(true);
      expect(result.output.partial).toBe(false);
    });
  });

  test('omits stored threads without a live CLI even when metadata exists', async () => {
    await withFixture(async f => {
      f.threads[1].status = { type: 'idle' };
      const result = await run(f, ['sessions']);
      expect(result.status).toBe(0);
      expect(result.output.sessions.map(row => [row.thread_id, row.app_server_status, row.loaded])).toEqual([
        [THREAD_C, 'idle', true],
        [THREAD_A, 'notLoaded', false],
      ]);
    });
  });

  test('excludes live subagents even when their parent process holds their thread file', async () => {
    await withFixture(async f => {
      f.threads[2].source = { subAgent: { thread_spawn: { parent_thread_id: THREAD_A } } };
      const result = await run(f, ['sessions']);
      expect(result.status).toBe(0);
      expect(result.output.sessions.map(row => row.thread_id)).toEqual([THREAD_A]);
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
      expect(result.output.reply_to).toBeNull();
      expect(result.output.submission_id).toBe('33333333-3333-4333-8333-333333333333');
      const args = JSON.parse(readFileSync(f.capture, 'utf8'));
      expect(args.at(-1)).toStartWith('--message=');
      expect(args.at(-1)).toEndWith(message);
    });
  });

  test('passes a hyphen-leading message as one --message= argument so it is not parsed as a flag', async () => {
    await withFixture(async f => {
      const message = '- decision: keep the daemon socket\n- next: tests';
      const file = join(f.root, 'bullets.txt');
      writeFileSync(file, message);
      const result = await run(f, ['send', '--thread', THREAD_A, '--message-file', file]);
      expect(result.status).toBe(0);
      const args = JSON.parse(readFileSync(f.capture, 'utf8'));
      expect(args).toHaveLength(4);
      expect(args.at(-1)).toStartWith('--message=');
      expect(args.at(-1)).toEndWith(message);
      expect(args).not.toContain('--message');
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
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message', '--project', 'target'])).toThrow();
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message='])).toThrow();
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message=hello', '--message', 'again'])).toThrow();
    expect(() => parseArgs(['send', '--thread', THREAD_A, '--message=hello', '--message-file', 'file'])).toThrow();
  });

  test('queues a double-hyphen-leading inline message with literal quotes and equals signs', async () => {
    await withFixture(async f => {
      const message = '-- review "cache=true"\n$HOME `whoami`';
      const result = await run(f, ['send', '--thread', THREAD_A, `--message=${message}`]);
      expect(result.status).toBe(0);
      expect(result.output.state).toBe('queued');
      expect(JSON.parse(readFileSync(f.capture, 'utf8')).at(-1)).toEndWith(message);
    });
  });

  test.each(['null', '[]', 'not JSON'])('reports a malformed daemon message (%s) as a JSON error', async replyText => {
    await withFixture(async f => {
      const result = await run(f, ['sessions']);
      expect(result.status).toBe(1);
      expect(result.output.ok).toBe(false);
      expect(result.output.error).toContain('invalid JSON-RPC message');
    }, { replyText });
  });

  test('rejects a connection closed before upgrade without waiting for the connection timeout', async () => {
    await withFixture(async f => {
      const started = Date.now();
      const result = await run(f, ['sessions']);
      expect(result.status).toBe(1);
      expect(result.output.error).toContain('closed before WebSocket upgrade');
      expect(Date.now() - started).toBeLessThan(2000);
    }, { closeBeforeUpgrade: true });
  }, 10000);

  test('deduplicates overlapping pages and keeps the later observed session state', async () => {
    const original = { id: THREAD_A, name: 'old', updatedAt: 1, status: { type: 'notLoaded' } };
    const latest = { ...original, name: 'latest', updatedAt: 2, status: { type: 'idle' } };
    await withFixture(async f => {
      const result = await run(f, ['sessions']);
      expect(result.status).toBe(0);
      expect(result.output.sessions.map(row => [row.thread_id, row.name, row.loaded])).toEqual([[THREAD_A, 'latest', true], [THREAD_C, 'open in daemon', true]]);
      expect(result.output.partial).toBe(false);
    }, { pages: [{ data: [original], nextCursor: 'next' }, { data: [latest], nextCursor: null }] });
  });

  test('canonicalizes each directory once per project-scoped inventory, including across pages', async () => {
    const pages = [];
    await withFixture(async f => {
      pages.push(
        { data: f.threads.slice(0, 2), nextCursor: 'next' },
        { data: [f.threads[2], { ...f.threads[0], id: THREAD_D }], nextCursor: null },
      );
      const bin = join(f.root, 'bin');
      mkdirSync(bin);
      const capture = join(f.root, 'git-calls.jsonl');
      const fakeGit = join(bin, 'git');
      writeFileSync(fakeGit, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_GIT_CAPTURE, JSON.stringify(process.cwd()) + '\\n');
process.stdout.write(process.cwd() === ${JSON.stringify(realpathSync(f.worktree))} ? ${JSON.stringify(join(realpathSync(f.repo), '.git'))} : '.git');
`);
      chmodSync(fakeGit, 0o755);
      const env = { PATH: `${bin}:${join(f.root, 'bins')}:${process.env.PATH}`, FAKE_GIT_CAPTURE: capture };
      for (let request = 0; request < 2; request++) {
        const result = await run(f, ['sessions', '--project', 'target'], env);
        expect(result.status).toBe(0);
        expect(result.output.sessions.map(row => row.thread_id)).toEqual([THREAD_C, THREAD_A]);
      }
      const calls = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      for (const directory of [f.repo, f.worktree, f.threads[1].cwd]) expect(calls.filter(cwd => cwd === realpathSync(directory))).toHaveLength(2);
    }, { pages });
  });
});
