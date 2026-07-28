import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLedger } from '../xm/lib/x-inbox/ledger.mjs';
import { take } from '../xm/lib/x-inbox/inbox.mjs';
import {
  buildTerminalReceipt, persistReceipt, buildReceiptPayload, materializeReceipt,
  recordReceiptTransport, receiptStatus,
} from '../xm/lib/x-inbox/receipt.mjs';

function temp() { return mkdtempSync(join(tmpdir(), 'x-inbox-receipt-')); }
function inboxItem(status = 'resolved') {
  return {
    id: 'toss-receipt-test', from_project: 'sender-mesh', to_project: 'receiver-mesh',
    created_at: '2026-07-24T00:00:00.000Z', status, title: 'bug', mem_mesh: {},
  };
}
function outboxItem() {
  return {
    id: 'toss-receipt-test', from_project: 'sender-mesh', to_project: 'target-registry-id',
    delivery_target_project: 'receiver-mesh', created_at: '2026-07-24T00:00:00.000Z',
    status: 'delivered', title: 'bug', mem_mesh: {},
  };
}

describe('terminal receipt protocol', () => {
  test('creates an immutable durable receipt and returns the exact retry payload', () => {
    const cwd = temp();
    try {
      const receipt = buildTerminalReceipt(inboxItem(), { cwd, receiverProject: 'receiver-mesh', now: 0, summary: 'fixed', verification: 'bun test' });
      expect(receipt.id).toBe('receipt-toss-receipt-test-resolved');
      expect(persistReceipt(receipt, { cwd }).created).toBe(true);
      expect(persistReceipt(receipt, { cwd }).created).toBe(false);
      expect(buildReceiptPayload(receipt).add.project_id).toBe('sender-mesh');
      expect(JSON.parse(buildReceiptPayload(receipt).add.content)).toEqual(receipt);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('sender applies one matching receipt once; duplicate and out-of-order receipts cannot change terminal state', () => {
    const cwd = temp();
    try {
      const outbox = join(cwd, '.xm', 'outbox');
      writeLedger(outbox, outboxItem(), { cwd });
      const resolved = buildTerminalReceipt(inboxItem(), { cwd, receiverProject: 'receiver-mesh', now: 1, summary: 'fixed', verification: 'bun test' });
      expect(materializeReceipt(outbox, resolved, { cwd, projectId: 'sender-mesh' }).applied).toBe(true);
      expect(materializeReceipt(outbox, resolved, { cwd, projectId: 'sender-mesh' }).applied).toBe(false);
      const dismissed = buildTerminalReceipt(inboxItem('dismissed'), { cwd, receiverProject: 'receiver-mesh', now: 2, summary: 'not our layer' });
      expect(() => materializeReceipt(outbox, dismissed, { cwd, projectId: 'sender-mesh' })).toThrow(/conflicting/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('rejects forged/wrong-project receipts before changing the sender outbox', () => {
    const cwd = temp();
    try {
      const outbox = join(cwd, '.xm', 'outbox');
      writeLedger(outbox, outboxItem(), { cwd });
      const receipt = buildTerminalReceipt(inboxItem(), { cwd, receiverProject: 'forged-mesh', now: 1, summary: 'fixed', verification: 'bun test' });
      expect(() => materializeReceipt(outbox, receipt, { cwd, projectId: 'sender-mesh' })).toThrow(/origin/);
      expect(() => materializeReceipt(outbox, { ...receipt, to_project: 'other-sender' }, { cwd, projectId: 'sender-mesh' })).toThrow(/different source/);
      const plausibleButWrongSender = buildTerminalReceipt(
        { ...inboxItem(), from_project: 'other-sender' },
        { cwd, receiverProject: 'receiver-mesh', now: 1, summary: 'fixed', verification: 'bun test' },
      );
      expect(() => materializeReceipt(outbox, plausibleButWrongSender, { cwd, projectId: 'other-sender' })).toThrow(/source identity/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('failed delivery stays pending, retry retains terminal state, and record marks only transport delivered', () => {
    const cwd = temp();
    try {
      const inbox = join(cwd, '.xm', 'inbox');
      const receipt = buildTerminalReceipt(inboxItem(), { cwd, receiverProject: 'receiver-mesh', now: 1, summary: 'fixed', verification: 'bun test' });
      persistReceipt(receipt, { cwd });
      writeLedger(inbox, { ...inboxItem(), receipt: { ...receipt, transport: 'pending' } }, { cwd });
      expect(receiptStatus(cwd, 'toss-receipt-test')).toMatchObject({ status: 'resolved', receipt: { transport: 'pending' } });
      const updated = recordReceiptTransport(inbox, 'toss-receipt-test', 'memory-1', { cwd });
      expect(updated.status).toBe('resolved');
      expect(updated.receipt.transport).toBe('delivered');
      expect(updated.receipt.memory_id).toBe('memory-1');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('take cannot reopen an item after a terminal receipt exists', () => {
    const cwd = temp();
    try {
      const inbox = join(cwd, '.xm', 'inbox');
      const receipt = buildTerminalReceipt(inboxItem(), { cwd, receiverProject: 'receiver-mesh', now: 1, summary: 'fixed', verification: 'bun test' });
      writeLedger(inbox, { ...inboxItem(), receipt: { ...receipt, transport: 'pending' } }, { cwd });
      expect(take(inbox, 'toss-receipt-test', { cwd })).toMatchObject({ status: 'resolved', receipt: { id: receipt.id } });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

/**
 * A terminal receipt is the only thing the sender ever sees. One asserting
 * "resolved" with nothing behind it closes the report against a fix that may
 * not exist — the failure toss-20260721-056b3c49 reported, and the one that
 * left 5 x-kit items marked done while only 2 were actually fixed.
 */
describe('terminal receipt evidence gate', () => {
  test('resolving refuses a missing summary or verification', () => {
    const cwd = temp();
    try {
      expect(() => buildTerminalReceipt(inboxItem(), { cwd, receiverProject: 'receiver-mesh', now: 1 }))
        .toThrow(/requires a summary/);
      expect(() => buildTerminalReceipt(inboxItem(), {
        cwd, receiverProject: 'receiver-mesh', now: 1, summary: 'fixed',
      })).toThrow(/requires verification/);
      // Whitespace is not evidence.
      expect(() => buildTerminalReceipt(inboxItem(), {
        cwd, receiverProject: 'receiver-mesh', now: 1, summary: '   ', verification: 'bun test',
      })).toThrow(/requires a summary/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('dismissing needs a reason but not a verification — nothing was fixed', () => {
    const cwd = temp();
    try {
      expect(() => buildTerminalReceipt(inboxItem('dismissed'), { cwd, receiverProject: 'receiver-mesh', now: 1 }))
        .toThrow(/requires a summary/);
      const receipt = buildTerminalReceipt(inboxItem('dismissed'), {
        cwd, receiverProject: 'receiver-mesh', now: 1, summary: 'belongs to the runtime, not this layer',
      });
      expect(receipt.terminal_state).toBe('dismissed');
      expect(receipt.verification).toBe('');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe('buildReceiptPayload — closing the delivery pin', () => {
  test('emits pin_complete only when the item still carries a pin id', () => {
    const cwd = temp();
    try {
      const receipt = buildTerminalReceipt(inboxItem(), {
        cwd, receiverProject: 'receiver-mesh', now: 1, summary: 'fixed', verification: 'bun test',
      });

      const withPin = buildReceiptPayload(receipt, { pinId: 'pin-abc' });
      expect(withPin.pin_complete).toEqual({ pin_id: 'pin-abc' });
      // The receipt itself must be unaffected by the extra call.
      expect(JSON.parse(withPin.add.content)).toEqual(receipt);

      expect(buildReceiptPayload(receipt).pin_complete).toBeUndefined();
      expect(buildReceiptPayload(receipt, { pinId: '  ' }).pin_complete).toBeUndefined();
      expect(buildReceiptPayload(receipt, { pinId: null }).pin_complete).toBeUndefined();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
