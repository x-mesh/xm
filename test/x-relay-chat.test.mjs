import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { ChatWorkspace, chatCandidates } from '../xm/lib/x-relay-chat.mjs';
import { parseArgs } from '../xm/lib/x-relay-cli.mjs';

const CLI = fileURLToPath(new URL('../xm/lib/x-relay-cli.mjs', import.meta.url));
const THREAD = '11111111-1111-4111-8111-111111111111';
const roots = [];
const workspaces = [];
const daemons = [];
const supported = ['darwin', 'linux'].includes(process.platform) && spawnSync('tmux', ['-V']).status === 0;

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) spawnSync('tmux', ['-L', workspace.socketName, 'kill-server']);
  for (const daemon of daemons.splice(0)) await new Promise(resolve => daemon.close(resolve));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ realMenu = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xmchat-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const menu = join(root, 'menu.mjs');
  writeFileSync(menu, "console.log('fake menu'); process.stdin.resume();\n");
  const captures = { codex: join(root, 'codex.json'), claude: join(root, 'claude.json') };
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    const bin = join(root, provider);
    bins[provider] = bin;
    writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'agents') { process.stdout.write(process.env.FAKE_CHAT_AGENTS_FILE ? readFileSync(process.env.FAKE_CHAT_AGENTS_FILE, 'utf8') : process.env.FAKE_CHAT_AGENTS || '[]'); process.exit(0); }
if (args[0] === 'app-server') { process.stdout.write(JSON.stringify(process.env.FAKE_CHAT_DAEMON_SOCKET ? {status:'running',socketPath:process.env.FAKE_CHAT_DAEMON_SOCKET} : {status:'stopped'})); process.exit(0); }
writeFileSync(${JSON.stringify(captures[provider])}, JSON.stringify({args,pid:process.pid,cwd:process.cwd(),tty:process.stdin.isTTY,menu:process.env.XM_RELAY_CHAT_MENU}));
console.log('native ${provider} ready');
process.stdin.on('data', data => process.stdout.write(data));
`);
    chmodSync(bin, 0o755);
  }
  const workspace = new ChatWorkspace({ cliPath: realMenu ? CLI : menu,
    codexBin: bins.codex, claudeBin: bins.claude, cwd: root,
    socketName: `xm-relay-test-${process.pid}-${roots.length}-${Date.now()}` });
  workspace.env.HOME = home;
  workspace.env.FAKE_CHAT_AGENTS = JSON.stringify([{ id: 'background-id', kind: 'background', cwd: root, state: 'working', name: 'fixture Claude' }]);
  workspaces.push(workspace);
  return { root, home, captures, workspace };
}

async function waitFor(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('chat fixture did not reach its expected state');
}

describe('relay chat arguments and inventory', () => {
  test('accepts chat with only an optional project and rejects headless use before provider lookup', () => {
    expect(parseArgs(['chat', '--project', 'target']).command).toBe('chat');
    expect(() => parseArgs(['chat', '--provider', 'claude'])).toThrow('chat accepts only --project');
    const result = spawnSync('node', [CLI, 'chat'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).error).toContain('interactive terminal');
  });

  test('lists native background Claude sessions without requiring a PID or inbox socket', async () => {
    const snapshot = await chatCandidates({
      listSessions: async () => ({ sessions: [{ thread_id: THREAD, cwd: '/repo', app_server_status: 'idle' }] }),
      claudeSessions: () => [{ kind: 'background', id: 'native-id', cwd: '/repo', state: 'blocked' },
        { kind: 'interactive', sessionId: 'another-session', cwd: '/repo' }],
    });
    expect(snapshot.candidates.map(row => [row.provider, row.id, row.attachable])).toEqual([
      ['codex', THREAD, true], ['claude', 'native-id', true], ['claude', 'another-session', false],
    ]);
  });

  test('retains the other provider when one fails and applies registered project filtering', async () => {
    const snapshot = await chatCandidates({
      listSessions: async () => { throw new Error('daemon unavailable'); },
      claudeSessions: () => [{ kind: 'background', id: 'in-project', cwd: '/repo' },
        { kind: 'background', id: 'outside', cwd: '/other' }],
      registryProject: () => ({ path: '/repo' }),
      createProjectMatcher: path => cwd => cwd === path,
    }, 'target');
    expect(snapshot.candidates.map(row => row.id)).toEqual(['in-project']);
    expect(snapshot.notes[0]).toContain('daemon unavailable');
  });
});

describe.if(supported)('relay chat native tmux workspace', () => {
  test('keeps native provider processes alive across switches and reuses each identity window', async () => {
    const { root, captures, workspace } = fixture();
    workspace.ensure();
    const codex = { provider: 'codex', id: THREAD, cwd: root, name: 'literal $HOME `whoami`', attachable: true };
    const claude = { provider: 'claude', id: 'native-id', cwd: root, name: 'Claude', attachable: true };
    const codexWindow = workspace.open(codex, join(root, 'daemon.sock'));
    await waitFor(() => existsSync(captures.codex));
    const before = JSON.parse(readFileSync(captures.codex, 'utf8'));
    const claudeWindow = workspace.open(claude);
    await waitFor(() => existsSync(captures.claude));
    expect(workspace.open(codex, join(root, 'daemon.sock'))).toBe(codexWindow);
    expect(JSON.parse(readFileSync(captures.codex, 'utf8')).pid).toBe(before.pid);
    expect(before.args).toEqual(['resume', THREAD, '--remote', `unix://${join(root, 'daemon.sock')}`]);
    expect(before.tty).toBe(true);
    expect(before.menu).toBe('0');
    expect(JSON.parse(readFileSync(captures.claude, 'utf8')).args).toEqual(['attach', 'native-id']);
    expect(workspace.command(['list-windows', '-t', workspace.sessionName, '-F', '#{window_id}']).split('\n')).toHaveLength(3);
    expect(workspace.command(['list-keys', '-T', 'root'])).toMatch(/F6\s+select-window -t :0/);
    workspace.command(['select-window', '-t', `${workspace.sessionName}:0`]);
    expect(workspace.command(['display-message', '-p', '-t', claudeWindow, '#{pane_dead}'])).toBe('0');
    workspace.ensure();
    expect(workspace.open(codex, join(root, 'daemon.sock'))).toBe(codexWindow);
    expect(() => workspace.open({ ...claude, attachable: false })).toThrow('/background');
    expect(() => workspace.open({ ...codex, cwd: null, attachable: false })).toThrow('Codex 세션');
  });

  test('runs the real menu in a tmux terminal and opens its freshly listed Claude background target', async () => {
    const { captures, workspace } = fixture({ realMenu: true });
    workspace.ensure();
    const menuPane = `${workspace.sessionName}:0`;
    await waitFor(() => workspace.command(['capture-pane', '-p', '-t', menuPane]).includes('fixture Claude'));
    workspace.command(['send-keys', '-t', menuPane, '1', 'Enter']);
    await waitFor(() => existsSync(captures.claude));
    expect(JSON.parse(readFileSync(captures.claude, 'utf8')).args).toEqual(['attach', 'background-id']);
    expect(workspace.command(['display-message', '-p', '-t', menuPane, '#{pane_dead}'])).toBe('0');
  });

  test('revalidates the selected identity when fresh inventory order changes', async () => {
    const { root, captures, workspace } = fixture({ realMenu: true });
    const file = join(root, 'agents.json');
    const first = { id: 'alpha-id', kind: 'background', cwd: root, name: 'Alpha' };
    const second = { ...first, id: 'beta-id', name: 'Beta' };
    writeFileSync(file, JSON.stringify([first, second]));
    workspace.env.FAKE_CHAT_AGENTS_FILE = file;
    workspace.ensure();
    const menuPane = `${workspace.sessionName}:0`;
    await waitFor(() => workspace.command(['capture-pane', '-p', '-t', menuPane]).includes('Alpha'));
    writeFileSync(file, JSON.stringify([second, first]));
    workspace.command(['send-keys', '-t', menuPane, '1', 'Enter']);
    await waitFor(() => existsSync(captures.claude));
    expect(JSON.parse(readFileSync(captures.claude, 'utf8')).args).toEqual(['attach', 'alpha-id']);
  });

  test('does not open a replacement when the selected identity disappears', async () => {
    const { root, captures, workspace } = fixture({ realMenu: true });
    const file = join(root, 'agents.json');
    writeFileSync(file, JSON.stringify([{ id: 'gone-id', kind: 'background', cwd: root, name: 'Gone' }]));
    workspace.env.FAKE_CHAT_AGENTS_FILE = file;
    workspace.ensure();
    const menuPane = `${workspace.sessionName}:0`;
    await waitFor(() => workspace.command(['capture-pane', '-p', '-t', menuPane]).includes('Gone'));
    writeFileSync(file, '[]');
    workspace.command(['send-keys', '-t', menuPane, '1', 'Enter']);
    await waitFor(() => workspace.command(['capture-pane', '-p', '-t', menuPane]).includes('목록에서 사라졌습니다'));
    expect(existsSync(captures.claude)).toBe(false);
    expect(workspace.command(['list-windows', '-t', workspace.sessionName, '-F', '#{window_id}']).split('\n')).toHaveLength(1);
  });

  test('reopens an exited provider view in the same window only when selected again', async () => {
    const { root, captures, workspace } = fixture();
    workspace.ensure();
    const candidate = { provider: 'claude', id: 'native-id', cwd: root, name: 'Claude', attachable: true };
    const windowId = workspace.open(candidate);
    await waitFor(() => existsSync(captures.claude));
    const original = JSON.parse(readFileSync(captures.claude, 'utf8'));
    process.kill(original.pid, 'SIGTERM');
    await waitFor(() => workspace.command(['display-message', '-p', '-t', windowId, '#{pane_dead}']) === '1');
    expect(workspace.open(candidate)).toBe(windowId);
    await waitFor(() => JSON.parse(readFileSync(captures.claude, 'utf8')).pid !== original.pid);
    expect(JSON.parse(readFileSync(captures.claude, 'utf8')).args).toEqual(['attach', 'native-id']);
    expect(workspace.command(['list-windows', '-t', workspace.sessionName, '-F', '#{window_id}']).split('\n')).toHaveLength(2);
  });

  test('queries and revalidates the Codex UUID through the daemon before native resume', async () => {
    const { root, captures, workspace } = fixture({ realMenu: true });
    const socketPath = join(root, 'daemon.sock');
    const methods = [];
    const daemon = net.createServer(socket => {
      let buffer = Buffer.alloc(0);
      let upgraded = false;
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const key = /Sec-WebSocket-Key: (\S+)/i.exec(buffer.subarray(0, end).toString())[1];
          const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          buffer = buffer.subarray(end + 4);
          upgraded = true;
        }
        while (buffer.length >= 6) {
          let length = buffer[1] & 127;
          let offset = 2;
          if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]));
          buffer = buffer.subarray(offset + 4 + length);
          const request = JSON.parse(payload.toString());
          if (request.id == null) continue;
          methods.push(request.method);
          const result = request.method === 'thread/list'
            ? { data: [{ id: THREAD, cwd: root, name: 'fixture Codex', status: { type: 'idle' } }], nextCursor: null }
            : {};
          const bytes = Buffer.from(JSON.stringify({ id: request.id, result }));
          const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length])
            : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
          socket.write(Buffer.concat([header, bytes]));
        }
      });
    });
    daemons.push(daemon);
    await new Promise(resolve => daemon.listen(socketPath, resolve));
    workspace.env.FAKE_CHAT_DAEMON_SOCKET = socketPath;
    workspace.ensure();
    const menuPane = `${workspace.sessionName}:0`;
    await waitFor(() => workspace.command(['capture-pane', '-p', '-t', menuPane]).includes('fixture Codex'));
    workspace.command(['send-keys', '-t', menuPane, '1', 'Enter']);
    await waitFor(() => existsSync(captures.codex));
    expect(JSON.parse(readFileSync(captures.codex, 'utf8')).args).toEqual(['resume', THREAD, '--remote', `unix://${socketPath}`]);
    expect(methods.filter(method => method === 'thread/list')).toHaveLength(2);
    expect(existsSync(captures.claude)).toBe(false);
  });
});
