#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayStore } from './x-remote/gateway-store.mjs';
import { DiscordBridge } from './x-remote/discord.mjs';
import { createEnvelope, parseEnvelope } from './x-remote/protocol.mjs';

const port = Number(process.env.XM_REMOTE_GATEWAY_PORT || 19843);
const hostToken = process.env.XM_REMOTE_HOST_TOKEN || '';
const store = new GatewayStore(process.env.XM_REMOTE_DB_PATH || join(homedir(), '.xm', 'remote', 'gateway.db'));
const hosts = new Map();
const deliveryPromises = new Map();
const outputBatches = new Map();
let gatewaySeq = store.nextCommandSeq();

function batchKey(event) { return `${event.host_id}:${event.session_id || 'host'}`; }
function flushOutputBatch(key) {
  const batch = outputBatches.get(key);
  if (!batch) return Promise.resolve();
  outputBatches.delete(key);
  clearTimeout(batch.timer);
  return discord.publishBatch(batch.events).then(() => {
    for (const entry of batch.entries) { store.markDiscordDelivered(entry.event.event_id); entry.resolve(); }
  }).catch((error) => { for (const entry of batch.entries) entry.reject(error); });
}
function queueOutput(event) {
  const key = batchKey(event);
  let batch = outputBatches.get(key);
  if (!batch) {
    batch = { events: [], entries: [], timer: null };
    batch.timer = setTimeout(() => flushOutputBatch(key), 1200);
    outputBatches.set(key, batch);
  }
  batch.events.push(event);
  const promise = new Promise((resolve, reject) => batch.entries.push({ event, resolve, reject }));
  return promise;
}
function deliverEvent(event) {
  if (event.type === 'host.heartbeat') { store.markDiscordDelivered(event.event_id); return Promise.resolve(); }
  const existing = deliveryPromises.get(event.event_id);
  if (existing) return existing;
  const promise = (event.type === 'session.progress' || event.type === 'session.output')
    ? queueOutput(event)
    : flushOutputBatch(batchKey(event)).then(() => discord.publish(event)).then(() => store.markDiscordDelivered(event.event_id));
  deliveryPromises.set(event.event_id, promise);
  promise.then(() => deliveryPromises.delete(event.event_id), () => deliveryPromises.delete(event.event_id));
  return promise;
}

function sendHost(hostId, message) {
  store.queueCommand(message);
  const socket = hosts.get(hostId);
  if (socket) socket.send(JSON.stringify(message));
}

async function onDiscordCommand(command) {
  if (command.kind === 'help') return discord.send('`!xr sessions`, `!xr steer <session> <text>`, `!xr interrupt <session>`, `!xr resume <session> <text>`, `!xr decide <decision> <text>`');
  if (command.kind === 'sessions') return discord.send('```json\n' + JSON.stringify(store.sessions(), null, 2).slice(0, 1850) + '\n```');
  if (command.kind === 'decide') {
    const decision = store.pendingDecisions().find((d) => d.decision_id === command.target);
    if (!decision) throw new Error(`pending decision not found: ${command.target}`);
    const session = store.sessions().find((s) => s.session_id === decision.session_id);
    sendHost(session.host_id, createEnvelope({ type: 'decision.answer', hostId: session.host_id, sessionId: session.session_id, provider: session.provider, seq: gatewaySeq++, payload: { decisionId: command.target, answer: command.text } }));
    return discord.send(`decision ${command.target} forwarded`);
  }
  const session = store.sessions().find((s) => s.session_id === command.target);
  if (!session) throw new Error(`session not found: ${command.target}`);
  const type = `${command.kind}.request`;
  sendHost(session.host_id, createEnvelope({ type, hostId: session.host_id, sessionId: session.session_id, provider: session.provider, seq: gatewaySeq++, payload: { original: command.text || '' } }));
  await discord.send(`${command.kind} forwarded to ${command.target}`);
}

const allowedUserIds = String(process.env.DISCORD_ALLOWED_USER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean);
if (!allowedUserIds.length) throw new Error('DISCORD_ALLOWED_USER_IDS is required');
const discord = new DiscordBridge({ token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID, allowedUserIds, onCommand: onDiscordCommand });
await discord.connect();

const server = Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, hosts: hosts.size, sessions: store.sessions().length });
    if (url.pathname === '/host') {
      if (!hostToken || url.searchParams.get('token') !== hostToken) return new Response('unauthorized', { status: 401 });
      const hostId = url.searchParams.get('host_id');
      if (!hostId) return new Response('host_id required', { status: 400 });
      return server.upgrade(req, { data: { hostId } }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      hosts.set(ws.data.hostId, ws);
      for (const command of store.pendingCommands(ws.data.hostId)) ws.send(JSON.stringify(command));
    },
    async message(ws, message) {
      try {
        const event = parseEnvelope(message);
        if (event.host_id !== ws.data.hostId) throw new Error('host_id mismatch');
        if (event.type === 'ack') store.ackCommand(event.payload.eventId);
        store.ingest(event);
        // ACK reflects protocol-level receipt (store.ingest already happened above),
        // NOT downstream Discord delivery — send it immediately instead of awaiting
        // deliverEvent(). Previously this awaited deliverEvent() first, which for
        // session.progress/output events blocked the ACK up to the full 1200ms batch
        // window (kiro MEDIUM), and a Discord publish failure rejected that same await,
        // landing in the outer catch and sending the HOST an `error` envelope for an
        // event that was actually ingested successfully (agy MEDIUM) — panel review
        // 2026-07-17. Discord delivery now runs fire-and-forget; its own failure is
        // swallowed here (already logged via store bookkeeping / entry.reject in
        // flushOutputBatch) and never reaches the host.
        ws.send(JSON.stringify(createEnvelope({ type: 'ack', hostId: event.host_id, sessionId: event.session_id, seq: gatewaySeq++, payload: { eventId: event.event_id } })));
        // Heartbeats are liveness telemetry for the gateway, not human-facing
        // Discord updates. Keep ingest/ACK semantics intact while avoiding a
        // noisy channel and unnecessary Discord rate-limit pressure.
        const publishToDiscord = event.type !== 'ack';
        if (publishToDiscord && store.needsDiscordDelivery(event.event_id)) {
          deliverEvent(event).catch((error) => console.error(`[x-remote gateway] discord delivery failed for ${event.event_id}: ${error.message}`));
        }
      } catch (error) {
        ws.send(JSON.stringify(createEnvelope({ type: 'error', hostId: ws.data.hostId, seq: gatewaySeq++, payload: { message: error.message } })));
      }
    },
    close(ws) { if (hosts.get(ws.data.hostId) === ws) hosts.delete(ws.data.hostId); },
  },
});

console.log(`[x-remote gateway] listening on :${server.port}`);
process.on('SIGTERM', () => { discord.close(); store.close(); server.stop(); process.exit(0); });
