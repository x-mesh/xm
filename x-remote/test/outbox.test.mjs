import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlOutbox, ProcessedLedger } from '../lib/x-remote/outbox.mjs';
import { createEnvelope } from '../lib/x-remote/protocol.mjs';

test('outbox replays unacked events in seq order and compacts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'x-remote-')), 'outbox.jsonl');
  const box = new JsonlOutbox(path);
  const e2 = createEnvelope({ type: 'session.output', hostId: 'h', seq: 2, payload: { original: 'b' } });
  const e1 = createEnvelope({ type: 'session.output', hostId: 'h', seq: 1, payload: { original: 'a' } });
  box.put(e2); box.put(e1); box.ack(e1.event_id);
  expect(box.pending().map((e) => e.event_id)).toEqual([e2.event_id]);
  box.compact();
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('processed command ledger suppresses duplicate event ids across restarts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'x-remote-ledger-')), 'processed.jsonl');
  const first = new ProcessedLedger(path);
  expect(first.add('command-1')).toBe(true);
  expect(first.add('command-1')).toBe(false);
  expect(new ProcessedLedger(path).has('command-1')).toBe(true);
});
