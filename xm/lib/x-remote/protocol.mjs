import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 'XK-REMOTE-v1';
export const EVENT_TYPES = new Set([
  'host.hello', 'host.heartbeat', 'host.offline',
  'session.start', 'session.progress', 'session.output', 'session.complete', 'session.failed',
  'decision.required', 'decision.answer', 'decision.local_required',
  'steer.request', 'interrupt.request', 'resume.request',
  'ack', 'error',
]);

const SECRET_TERM = '(?:password|passwd|passphrase|secret|token|api[_ -]?key|credential|private[_ -]?key|otp|2fa|mfa|비밀번호|암호|토큰|인증정보)';
const SECRET_RE = new RegExp(`(?:enter|provide|paste|type|input|supply|입력|붙여넣|제공).{0,40}${SECRET_TERM}|${SECRET_TERM}.{0,20}(?::|\\?|입력|provide|enter)|(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{8,}`, 'i');

export function isSensitivePrompt(value) {
  if (value && typeof value === 'object') {
    if (value.isSecret === true || value.is_secret === true) return true;
    if (Array.isArray(value) && value.some(isSensitivePrompt)) return true;
    if (!Array.isArray(value) && Object.values(value).some((entry) => entry && typeof entry === 'object' && isSensitivePrompt(entry))) return true;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return SECRET_RE.test(text);
}

export function createEnvelope({ type, hostId, sessionId = null, agentId = null, provider = null, seq, payload = {}, eventId, tsMs }) {
  if (!EVENT_TYPES.has(type)) throw new Error(`unsupported event type: ${type}`);
  if (!hostId || !Number.isSafeInteger(seq) || seq < 0) throw new Error('hostId and non-negative integer seq are required');
  return {
    v: PROTOCOL_VERSION,
    type,
    event_id: eventId || randomUUID(),
    host_id: hostId,
    session_id: sessionId,
    agent_id: agentId,
    provider,
    seq,
    ts_ms: tsMs ?? Date.now(),
    payload,
  };
}

export function validateEnvelope(value) {
  if (!value || typeof value !== 'object') return 'envelope must be an object';
  if (value.v !== PROTOCOL_VERSION) return `unsupported protocol: ${value.v}`;
  if (!EVENT_TYPES.has(value.type)) return `unsupported event type: ${value.type}`;
  if (typeof value.event_id !== 'string' || !value.event_id) return 'event_id is required';
  if (typeof value.host_id !== 'string' || !value.host_id) return 'host_id is required';
  if (!Number.isSafeInteger(value.seq) || value.seq < 0) return 'seq must be a non-negative integer';
  if (!Number.isSafeInteger(value.ts_ms) || value.ts_ms < 0) return 'ts_ms must be a non-negative integer';
  if (value.payload == null || typeof value.payload !== 'object') return 'payload must be an object';
  return null;
}

export function parseEnvelope(line) {
  let value;
  try { value = JSON.parse(String(line)); }
  catch { throw new Error('invalid JSON envelope'); }
  const error = validateEnvelope(value);
  if (error) throw new Error(error);
  return value;
}

export function eventText(event) {
  const payload = event.payload || {};
  const original = payload.original ?? payload.text ?? payload.message ?? payload.prompt ?? '';
  return typeof original === 'string' ? original : JSON.stringify(original, null, 2);
}

export function discordChunks(event, max = 1900) {
  const prefix = `[${event.type}] host=${event.host_id}${event.session_id ? ` session=${event.session_id}` : ''}${event.provider ? ` provider=${event.provider}` : ''}\n`;
  const body = eventText(event) || '(no text payload)';
  const chunks = [];
  for (let i = 0; i < body.length || i === 0; i += max - prefix.length) {
    chunks.push(prefix + body.slice(i, i + max - prefix.length));
  }
  return chunks;
}
