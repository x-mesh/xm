#!/usr/bin/env node
import { createServer } from 'node:http';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JsonlOutbox, ProcessedLedger } from './x-remote/outbox.mjs';
import { createEnvelope, isSensitivePrompt, parseEnvelope } from './x-remote/protocol.mjs';
import { createProvider } from './x-remote/providers.mjs';

const stateDir = process.env.XM_REMOTE_STATE_DIR || join(homedir(), '.xm', 'remote');
const configPath = process.env.XM_REMOTE_HOST_CONFIG || join(stateDir, 'host.json');
if (!existsSync(configPath)) throw new Error(`host is not enrolled: ${configPath}`);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const hostId = config.host_id || hostname();
const controlPort = Number(config.control_port || 19844);
const outbox = new JsonlOutbox(join(stateDir, 'outbox.jsonl'));
const processed = new ProcessedLedger(join(stateDir, 'processed-commands.jsonl'));
const seqPath = join(stateDir, 'seq');
const sessionsPath = join(stateDir, 'sessions.json');
const sessions = new Map();
let socket = null;
let seq = existsSync(seqPath) ? Number(readFileSync(seqPath, 'utf8')) || 0 : Number(config.last_seq || 0);
let reconnectTimer = null;

function envelope(type, session, payload = {}) {
  const event = createEnvelope({ type, hostId, sessionId: session?.id || null, agentId: session?.agentId || null, provider: session?.provider || null, seq: seq++, payload });
  const tmp = `${seqPath}.tmp`;
  writeFileSync(tmp, String(seq), { mode: 0o600 }); renameSync(tmp, seqPath);
  return event;
}
function publish(type, session, payload = {}) {
  if (isSensitivePrompt(payload.original)) payload = { ...payload, original: '[withheld: local credential input required]' };
  const event = envelope(type, session, payload);
  outbox.put(event);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  return event;
}
function flush() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  for (const event of outbox.pending()) socket.send(JSON.stringify(event));
}
function sessionView(session) {
  return {
    id: session.id, provider: session.provider, status: session.status, cwd: session.cwd,
    provider_session_id: session.instance?.providerSessionId || session.instance?.threadId || session.providerSessionId || null,
    decisions: [...session.decisions.entries()].map(([id, value]) => [id, value.local ? { decisionId: value.decisionId, local: true } : value]),
  };
}
function persistSessions() {
  const tmp = `${sessionsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify([...sessions.values()].map(sessionView), null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, sessionsPath);
}
function bindProvider(session) {
  const map = {
    progress: 'session.progress', output: 'session.output', complete: 'session.complete', failed: 'session.failed',
    decision: 'decision.required', localRequired: 'decision.local_required',
  };
  for (const [providerEvent, remoteType] of Object.entries(map)) {
    session.instance.on(providerEvent, (payload) => {
      if (providerEvent === 'complete') session.status = 'complete';
      if (providerEvent === 'failed') session.status = 'failed';
      if (providerEvent === 'decision') session.decisions.set(String(payload.decisionId), payload);
      if (providerEvent === 'localRequired') {
        session.decisions.set(String(payload.decisionId), { ...payload, local: true });
        payload = { decisionId: payload.decisionId, original: 'Credential or secret input is required locally; prompt content was withheld.' };
      }
      persistSessions();
      publish(remoteType, session, payload);
    });
  }
}
function startSession({ provider, prompt, cwd = process.cwd(), agent_id = null }) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('provider must be claude or codex');
  if (!prompt) throw new Error('prompt is required');
  const session = { id: randomUUID(), provider, cwd, agentId: agent_id, status: 'running', decisions: new Map() };
  session.instance = createProvider(provider, { sessionId: session.id, cwd });
  sessions.set(session.id, session);
  bindProvider(session);
  persistSessions();
  publish('session.start', session, { original: prompt, cwd, full_access: true });
  session.instance.start(prompt);
  return sessionView(session);
}
function getSession(id) { const s = sessions.get(id); if (!s) throw new Error(`session not found: ${id}`); return s; }
function resumeDetached(session, text) {
  if (!session.providerSessionId) throw new Error('provider session id is unavailable after restart');
  session.instance = createProvider(session.provider, { sessionId: session.id, cwd: session.cwd });
  bindProvider(session);
  session.instance.resumeFrom(session.providerSessionId, text);
  session.status = 'running'; persistSessions();
}
function handleRemote(event) {
  if (event.type === 'ack') { outbox.ack(event.payload.eventId); return; }
  if (event.type === 'error') { console.error('[x-remote gateway]', event.payload); return; }
  if (processed.has(event.event_id)) { publish('ack', null, { eventId: event.event_id }); return; }
  const session = getSession(event.session_id);
  if (event.type === 'steer.request' || event.type === 'resume.request') {
    if (!session.instance) {
      if (event.type !== 'resume.request') throw new Error('detached sessions must be resumed before steering');
      resumeDetached(session, event.payload.original);
    } else if (event.type === 'resume.request') session.instance.resume(event.payload.original);
    else session.instance.steer(event.payload.original);
    session.status = 'running';
    publish(event.type === 'steer.request' ? 'steer.request' : 'resume.request', session, event.payload);
  } else if (event.type === 'interrupt.request') {
    session.instance.interrupt(); session.status = 'interrupted'; publish('interrupt.request', session, { original: 'interrupted' });
  } else if (event.type === 'decision.answer') {
    const decision = session.decisions.get(String(event.payload.decisionId));
    if (!decision) throw new Error(`decision not found: ${event.payload.decisionId}`);
    if (decision.local) throw new Error('credential decisions require local input');
    if (!session.instance) resumeDetached(session, `Answer to pending decision ${event.payload.decisionId}: ${event.payload.answer}`);
    else if (session.provider === 'codex') session.instance.answer(decision.requestId, event.payload.answer, decision.original);
    else session.instance.answer(decision.decisionId, event.payload.answer);
    session.decisions.delete(String(event.payload.decisionId)); persistSessions();
    publish('decision.answer', session, event.payload);
  }
  processed.add(event.event_id);
  publish('ack', null, { eventId: event.event_id });
}
function connect() {
  clearTimeout(reconnectTimer);
  const url = new URL(config.gateway_url);
  url.pathname = '/host'; url.searchParams.set('token', config.token); url.searchParams.set('host_id', hostId);
  socket = new WebSocket(url);
  socket.addEventListener('open', () => { publish('host.hello', null, { hostname: hostname(), platform: process.platform, runtime: process.version }); flush(); });
  socket.addEventListener('message', (event) => { try { handleRemote(parseEnvelope(event.data)); } catch (error) { publish('error', null, { message: error.message }); } });
  socket.addEventListener('close', () => { reconnectTimer = setTimeout(connect, 3000); });
  socket.addEventListener('error', (error) => console.error('[x-remote host] websocket error', error.message || error.type));
}

async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
const control = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, host_id: hostId, gateway_connected: socket?.readyState === WebSocket.OPEN });
    if (req.method === 'GET' && req.url === '/sessions') return json(res, 200, [...sessions.values()].map(sessionView));
    const input = await body(req);
    if (req.method === 'POST' && req.url === '/run') return json(res, 201, startSession(input));
    if (req.method === 'POST' && /^\/sessions\/[^/]+\/(steer|resume|interrupt)$/.test(req.url)) {
      const [, , id, action] = req.url.split('/'); const session = getSession(id);
      if (action === 'interrupt') { if (!session.instance) throw new Error('session is detached'); session.instance.interrupt(); session.status = 'interrupted'; }
      else if (!session.instance) { if (action !== 'resume') throw new Error('detached sessions must be resumed first'); resumeDetached(session, input.text); }
      else { session.instance[action](input.text); session.status = 'running'; }
      persistSessions();
      publish(`${action}.request`, session, { original: input.text || action });
      return json(res, 200, sessionView(session));
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) { return json(res, 400, { error: error.message }); }
});
if (existsSync(sessionsPath)) {
  try {
    for (const record of JSON.parse(readFileSync(sessionsPath, 'utf8'))) {
      sessions.set(record.id, { id: record.id, provider: record.provider, cwd: record.cwd, providerSessionId: record.provider_session_id, status: 'detached', decisions: new Map(record.decisions || []), instance: null });
    }
  } catch (error) { console.error('[x-remote host] session recovery skipped:', error.message); }
}
control.listen(controlPort, '127.0.0.1', () => console.log(`[x-remote host] ${hostId} control=127.0.0.1:${controlPort}`));
connect();
const heartbeat = setInterval(() => publish('host.heartbeat', null, { sessions: sessions.size }), 30000);
const retryPending = setInterval(flush, 5000);
process.on('SIGTERM', () => { clearInterval(heartbeat); clearInterval(retryPending); clearTimeout(reconnectTimer); socket?.close(); control.close(); process.exit(0); });
