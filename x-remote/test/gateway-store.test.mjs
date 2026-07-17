import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayStore } from '../lib/x-remote/gateway-store.mjs';
import { createEnvelope } from '../lib/x-remote/protocol.mjs';

test('gateway store is idempotent and progress does not replace running status', () => {
  const store = new GatewayStore(join(mkdtempSync(join(tmpdir(), 'x-remote-db-')), 'gateway.db'));
  const start = createEnvelope({ type: 'session.start', hostId: 'h', sessionId: 's', provider: 'codex', seq: 1, payload: { original: 'go' } });
  expect(store.ingest(start)).toBe(true);
  expect(store.ingest(start)).toBe(false);
  store.ingest(createEnvelope({ type: 'session.progress', hostId: 'h', sessionId: 's', provider: 'codex', seq: 2, payload: { original: 'working' } }));
  expect(store.sessions()[0].status).toBe('running');
  expect(store.needsDiscordDelivery(start.event_id)).toBe(true);
  store.markDiscordDelivered(start.event_id);
  expect(store.needsDiscordDelivery(start.event_id)).toBe(false);
  const command = createEnvelope({ type: 'steer.request', hostId: 'h', sessionId: 's', provider: 'codex', seq: 3, payload: { original: 'continue' } });
  store.queueCommand(command);
  expect(store.nextCommandSeq()).toBe(4);
  expect(store.pendingCommands('h')).toEqual([command]);
  store.ackCommand(command.event_id);
  expect(store.pendingCommands('h')).toEqual([]);
  store.close();
});
