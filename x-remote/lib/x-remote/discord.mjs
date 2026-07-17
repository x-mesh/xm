import { discordChunks } from './protocol.mjs';

export function parseDiscordCommand(text) {
  const input = String(text || '').trimStart();
  if (!input.startsWith('!xr')) return null;
  const match = /^!xr[ \t]+(\S+)(?:[ \t]+(\S+))?(?:[ \t]+([\s\S]*))?$/.exec(input);
  if (!match) return { kind: 'help' };
  const [, verb, target, originalText] = match;
  if (verb === 'sessions') return { kind: 'sessions' };
  if (['steer', 'resume', 'decide'].includes(verb) && target && originalText != null) {
    return { kind: verb, target, text: originalText };
  }
  if (verb === 'interrupt' && target) return { kind: verb, target };
  return { kind: 'help' };
}

export class DiscordBridge {
  constructor({ token, channelId, allowedUserIds, onCommand, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
    this.token = token; this.channelId = channelId; this.onCommand = onCommand;
    this.allowedUserIds = new Set(allowedUserIds || []);
    this.fetch = fetchImpl; this.WebSocketImpl = WebSocketImpl;
    this.sequence = null; this.heartbeat = null; this.socket = null;
  }
  async request(path, init = {}) {
    const res = await this.fetch(`https://discord.com/api/v10${path}`, {
      ...init, headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  async send(text) {
    if (!this.token || !this.channelId) return;
    await this.request(`/channels/${this.channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: String(text).slice(0, 2000), allowed_mentions: { parse: [] } }) });
  }
  async publish(event) { for (const chunk of discordChunks(event)) await this.send(chunk); }
  async connect() {
    if (!this.token || !this.channelId) throw new Error('DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID are required');
    const gateway = await this.request('/gateway/bot');
    this.socket = new this.WebSocketImpl(`${gateway.url}/?v=10&encoding=json`);
    this.socket.addEventListener('message', (e) => this.onMessage(JSON.parse(String(e.data))));
    this.socket.addEventListener('close', () => { clearInterval(this.heartbeat); setTimeout(() => this.connect().catch(console.error), 3000); });
  }
  onMessage(packet) {
    if (packet.s != null) this.sequence = packet.s;
    if (packet.op === 10) {
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.socket.send(JSON.stringify({ op: 1, d: this.sequence })), packet.d.heartbeat_interval);
      this.socket.send(JSON.stringify({ op: 2, d: { token: this.token, intents: 33281, properties: { os: process.platform, browser: 'x-remote', device: 'x-remote' } } }));
      return;
    }
    if (packet.op === 7) { this.socket.close(); return; }
    if (packet.t !== 'MESSAGE_CREATE' || packet.d.channel_id !== this.channelId || packet.d.author?.bot) return;
    if (!this.allowedUserIds.has(packet.d.author?.id)) return;
    const command = parseDiscordCommand(packet.d.content);
    if (command) Promise.resolve(this.onCommand(command)).catch((err) => this.send(`x-remote error: ${err.message}`));
  }
  close() { clearInterval(this.heartbeat); this.socket?.close(); }
}
