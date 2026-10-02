#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const CODEX = process.env.XM_RELAY_CODEX_BIN || 'codex';
const CLAUDE = process.env.XM_RELAY_CLAUDE_BIN || 'claude';
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 16384;
const ENVELOPE_TAG = /<\s*\/?\s*cross-session-message\b[^>]*>/gi;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (['help', '--help', '-h'].includes(command)) return { command: 'help', options: {} };
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!['--project', '--provider', '--thread', '--session', '--message', '--message-file'].includes(flag)) throw new Error(`unknown option: ${flag}`);
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (options[flag]) throw new Error(`duplicate option: ${flag}`);
    options[flag] = value;
  }
  if (!['sessions', 'send'].includes(command)) throw new Error('use sessions [--provider codex|claude] [--project ID] or send --provider <provider> --thread/--session UUID --message-file PATH');
  const provider = options['--provider'] || 'codex';
  if (!['codex', 'claude'].includes(provider)) throw new Error('--provider must be codex or claude');
  if (command === 'sessions' && (options['--thread'] || options['--session'] || options['--message'] || options['--message-file'])) throw new Error('sessions accepts only --provider and --project');
  if (command === 'send') {
    const targetFlag = provider === 'claude' ? '--session' : '--thread';
    const otherTargetFlag = provider === 'claude' ? '--thread' : '--session';
    if (!options[targetFlag] || options[otherTargetFlag] || Boolean(options['--message']) === Boolean(options['--message-file'])) {
      throw new Error(`send with --provider ${provider} requires ${targetFlag} and exactly one of --message or --message-file`);
    }
  }
  return { command, options };
}

function registryProject(name) {
  const path = join(homedir(), '.xm', 'projects.json');
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(registry.projects)) throw new Error('project registry has no projects array');
  const matches = registry.projects.filter(project => !project.archived && (project.id === name || project.name === name));
  if (matches.length !== 1) throw new Error(matches.length ? `ambiguous project: ${name}` : `project not registered: ${name}`);
  return matches[0];
}

function canonicalRepoPath(path) {
  const absolute = realpathSync(path);
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: absolute, encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return absolute;
  const common = resolve(absolute, result.stdout.trim());
  return basename(common) === '.git' ? dirname(common) : absolute;
}

function projectMatches(cwd, projectPath) {
  if (!cwd || !existsSync(cwd) || !existsSync(projectPath)) return false;
  return canonicalRepoPath(cwd) === canonicalRepoPath(projectPath);
}

function runClaudeJson(args) {
  const result = spawnSync(CLAUDE, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error((result.stderr || result.error?.message || 'Claude Code command failed').trim());
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Claude Code returned invalid JSON'); }
}

function claudeSessions() {
  const sessions = runClaudeJson(['agents', '--json']);
  if (!Array.isArray(sessions)) throw new Error('Claude Code returned an invalid session list');
  return sessions;
}

function requireClaudeSocketPlatform() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Codex-to-Claude relay currently supports local Unix sockets on macOS and Linux; Windows named pipes are not supported');
}

function claudeSessionRecord(session) {
  if (!Number.isSafeInteger(session.pid) || session.pid <= 0 || !THREAD_ID.test(session.sessionId || '')) return null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const path = join(configDir, 'sessions', `${session.pid}.json`);
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
  if (record.pid !== session.pid || record.sessionId !== session.sessionId || record.peerProtocol !== 1) return null;
  const socketPath = record.messagingSocketPath;
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('..')) return null;
  let socket;
  let directory;
  try {
    socket = lstatSync(socketPath);
    directory = lstatSync(dirname(socketPath));
  } catch { return null; }
  const userId = process.getuid?.();
  if (userId == null || !socket.isSocket() || socket.uid !== userId || (socket.mode & 0o077) !== 0 || basename(socketPath) !== `${session.pid}.sock` || !/^cc-socks(?:-[0-9]+)?$/.test(basename(dirname(socketPath))) || !directory.isDirectory() || directory.uid !== userId || (directory.mode & 0o077) !== 0) return null;
  if (!processAlive(session.pid)) return null;
  return { ...session, socketPath };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function listClaudeSessions(projectName) {
  requireClaudeSocketPlatform();
  const project = projectName ? registryProject(projectName) : null;
  const sessions = claudeSessions().flatMap(session => {
    const record = claudeSessionRecord(session);
    if (!record || (project && !projectMatches(record.cwd, project.path))) return [];
    return [{ session_id: record.sessionId, pid: record.pid, name: record.name || null, cwd: record.cwd || null, kind: record.kind || null, status: record.status || 'unknown', transport: 'local_inbox_socket' }];
  });
  return { ok: true, provider: 'claude', project: projectName || null, sessions, note: 'Only live local Claude sessions with a registered private inbox socket are listed; delivery can still be held or refused by the receiving session.' };
}

function claudeEnvelope(message) {
  const safeBody = message.replace(ENVELOPE_TAG, tag => tag.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  return `<cross-session-message from-name="codex-via-xm">\n${safeBody}\n</cross-session-message>`;
}

function sendToClaudeSocket(session, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: session.socketPath });
    let settled = false;
    const timer = setTimeout(() => socket.destroy(new Error('Claude inbox socket timed out')), 5000);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    socket.once('connect', () => {
      const frame = { msgV: 1, msg_id: randomUUID(), type: 'user', message: { role: 'user', content: claudeEnvelope(message) }, priority: 'next', session_id: session.sessionId };
      socket.end(`${JSON.stringify(frame)}\n`);
    });
    socket.once('error', finish);
    socket.once('close', () => finish());
  });
}

async function sendClaudeMessage(options) {
  requireClaudeSocketPlatform();
  const sessionId = options['--session'];
  if (!THREAD_ID.test(sessionId)) throw new Error('send requires an exact Claude session UUID');
  const message = options['--message-file'] ? readFileSync(options['--message-file'], 'utf8') : options['--message'];
  if (!message.trim() || message.length > MAX_MESSAGE_LENGTH) throw new Error(`message must contain 1-${MAX_MESSAGE_LENGTH} characters`);
  const project = options['--project'] ? registryProject(options['--project']) : null;
  const candidates = claudeSessions().filter(session => session.sessionId === sessionId);
  if (candidates.length !== 1) throw new Error(candidates.length ? `ambiguous Claude session: ${sessionId}` : `live Claude session not found: ${sessionId}`);
  const session = claudeSessionRecord(candidates[0]);
  if (!session) throw new Error(`Claude session has no reachable inbox: ${sessionId}`);
  if (project && !projectMatches(session.cwd, project.path)) throw new Error(`Claude session ${sessionId} is not in project ${project.id}`);
  await sendToClaudeSocket(session, message);
  return { ok: true, provider: 'claude', state: 'submitted', session_id: sessionId, project: project?.id || null, note: 'Message bytes were submitted to the local socket; receiver handling and delivery are unknown, and no receipt is requested.' };
}

function daemonVersion() {
  const result = spawnSync(CODEX, ['app-server', 'daemon', 'version'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error('Codex shared App Server daemon is unavailable; start it with codex app-server daemon start');
  const status = JSON.parse(result.stdout);
  if (status.status !== 'running') throw new Error('Codex shared App Server daemon is not running');
  if (typeof status.socketPath !== 'string' || !status.socketPath) throw new Error('Codex daemon status did not report a socketPath');
  return status;
}

const WS_OP_TEXT = 0x1;
const WS_OP_CLOSE = 0x8;
const WS_OP_PING = 0x9;
const WS_OP_PONG = 0xa;
const DAEMON_CONNECT_TIMEOUT_MS = 5000;
const DAEMON_REQUEST_TIMEOUT_MS = 20000;

function encodeClientFrame(opcode, payload) {
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

// The daemon socket speaks JSON-RPC over WebSocket (observed with codex 0.160.0), not JSON lines.
// Listing must go through the daemon: a freshly spawned app-server has no loaded threads and
// reports every thread as notLoaded, hiding the sessions that are actually open.
class DaemonClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.upgraded = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new Error(`Codex daemon socket did not accept a connection within ${DAEMON_CONNECT_TIMEOUT_MS}ms`));
      }, DAEMON_CONNECT_TIMEOUT_MS);
      this.socket = net.createConnection({ path: this.socketPath });
      this.socket.once('connect', () => {
        this.socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.socket.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.upgraded) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const statusLine = this.buffer.subarray(0, end).toString('latin1').split('\r\n')[0];
          clearTimeout(timer);
          if (!/^HTTP\/1\.1 101 /.test(statusLine)) {
            this.socket.destroy();
            reject(new Error(`Codex daemon refused the WebSocket upgrade: ${statusLine}`));
            return;
          }
          this.buffer = this.buffer.subarray(end + 4);
          this.upgraded = true;
          resolve();
        }
        this.readFrames();
      });
      this.socket.on('error', error => {
        clearTimeout(timer);
        reject(error);
        this.failPending(error);
      });
      this.socket.on('close', () => this.failPending(new Error('Codex daemon socket closed')));
    });
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const final = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === WS_OP_PING) { this.socket.write(encodeClientFrame(WS_OP_PONG, payload)); continue; }
      if (opcode === WS_OP_PONG) continue;
      if (opcode === WS_OP_CLOSE) { this.failPending(new Error('Codex daemon closed the WebSocket')); this.socket.end(); return; }
      this.fragments.push(payload);
      if (!final) continue;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.dispatch(text);
    }
  }

  dispatch(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    this.socket.write(encodeClientFrame(WS_OP_TEXT, Buffer.from(JSON.stringify(message), 'utf8')));
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex daemon timed out on ${method}`));
      }, DAEMON_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    await this.connect();
    await this.request('initialize', { clientInfo: { name: 'xm_relay', title: 'xm relay', version: '0.1.0' }, capabilities: {} });
    this.send({ method: 'initialized', params: {} });
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }
}

async function withDaemon(socketPath, fn) {
  const client = new DaemonClient(socketPath);
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    client.close();
  }
}

function newestLoadedFirst(left, right) {
  if (left.loaded !== right.loaded) return left.loaded ? -1 : 1;
  return (right.updated_at ?? 0) - (left.updated_at ?? 0);
}

async function listSessions(projectName) {
  const { socketPath } = daemonVersion();
  const project = projectName ? registryProject(projectName) : null;
  const targetPath = project?.path;
  return withDaemon(socketPath, async server => {
    const sessions = [];
    const seen = new Set();
    let cursor = null;
    let partial = false;
    for (let page = 0; page < 5; page += 1) {
      const result = await server.request('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const thread of result.data || []) {
        if (targetPath && !projectMatches(thread.cwd, targetPath)) continue;
        const status = thread.status?.type || 'unknown';
        sessions.push({ thread_id: thread.id, name: thread.name || null, cwd: thread.cwd || null, updated_at: thread.updatedAt || null, app_server_status: status, loaded: status !== 'notLoaded' && status !== 'unknown', live_status: 'unverified' });
      }
      cursor = result.nextCursor || null;
      if (!cursor) break;
      if (seen.has(cursor) || page === 4) { partial = true; break; }
      seen.add(cursor);
    }
    sessions.sort(newestLoadedFirst);
    return { ok: true, provider: 'codex', transport: 'shared_daemon_queue', project: projectName || null, sessions, partial, note: 'loaded means the shared daemon has the thread open; it does not prove a Codex UI is currently attached.' };
  });
}

async function sendMessage(options) {
  const threadId = options['--thread'];
  if (!THREAD_ID.test(threadId)) throw new Error('send requires an exact thread UUID');
  const message = options['--message-file'] ? readFileSync(options['--message-file'], 'utf8') : options['--message'];
  if (!message.trim() || message.length > MAX_MESSAGE_LENGTH) throw new Error(`message must contain 1-${MAX_MESSAGE_LENGTH} characters`);
  const { socketPath } = daemonVersion();
  const project = options['--project'] ? registryProject(options['--project']) : null;
  const thread = await withDaemon(socketPath, async server => (await server.request('thread/read', { threadId, includeTurns: false })).thread);
  if (!thread?.id) throw new Error(`thread not found: ${threadId}`);
  if (project && !projectMatches(thread.cwd, project.path)) throw new Error(`thread ${threadId} is not in project ${project.id}`);
  // The = form keeps clap from reading a message that starts with "-" (a bullet list) as a flag.
  const queued = spawnSync(CODEX, ['queue', '--thread', threadId, `--message=${message}`], { encoding: 'utf8', timeout: 15000 });
  if (queued.error || queued.status !== 0) throw new Error((queued.stderr || queued.error?.message || 'Codex queue failed').trim());
  const id = /Queued message ([0-9a-f-]{36}) for thread /i.exec(queued.stdout)?.[1] || null;
  return { ok: true, provider: 'codex', state: 'queued', thread_id: threadId, submission_id: id, project: project?.id || null, note: 'Queued is not proof the target read or acted. A detached thread may not run until it is resumed.' };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === 'help') return { ok: true, usage: 'xm relay sessions [--provider codex|claude] [--project ID] | xm relay send [--provider codex --thread UUID | --provider claude --session UUID] (--message TEXT | --message-file PATH) [--project ID]' };
  const provider = options['--provider'] || 'codex';
  if (command === 'sessions') return provider === 'claude' ? listClaudeSessions(options['--project']) : listSessions(options['--project']);
  return provider === 'claude' ? sendClaudeMessage(options) : sendMessage(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await main(process.argv.slice(2))) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exitCode = 1;
  }
}

export { canonicalRepoPath, parseArgs, projectMatches, registryProject, listSessions, listClaudeSessions, sendMessage, sendClaudeMessage };
