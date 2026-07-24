/**
 * Terminal receipts for cross-project inbox handoffs.
 *
 * Receipts are durable local records first and MCP transport payloads second.
 * A CLI process never sends them; the inbox skill delivers the returned
 * `mcp_calls.add` object and records the resulting memory id afterwards.
 */
import { join } from 'node:path';
import { mkdirSync, openSync, closeSync, unlinkSync, lstatSync } from 'node:fs';
import { readLedger, writeLedger, writeLedgerIfAbsent, validateItem, assertOwnedLedgerDir } from './ledger.mjs';
import { resolveMemMeshProjectId } from './target.mjs';

export const RECEIPT_TAG = 'inbox-receipt';
const TERMINAL = new Set(['resolved', 'dismissed']);

export class ReceiptError extends Error {
  constructor(message) { super(message); this.name = 'ReceiptError'; }
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ReceiptError(`${name} must be a non-empty string`);
  return value.trim();
}

function receiptId(tossId, state) { return `receipt-${tossId}-${state}`; }

function receiptDir(cwd) { return join(cwd, '.xm', 'receipts'); }

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

/**
 * The inbox item and its receipt are one terminal decision. A file lock is
 * deliberately held across both durable writes; otherwise two CLI processes
 * can independently observe `delivered`, choose opposite states, and leave
 * two immutable receipts behind. Lock acquisition is bounded, and a stale
 * lock is never silently removed (doing so could recreate the same split).
 */
function withTerminalLock(dir, tossId, cwd, fn) {
  const owned = assertOwnedLedgerDir(dir, cwd);
  mkdirSync(owned, { recursive: true });
  if (!lstatSync(owned).isDirectory() || lstatSync(owned).isSymbolicLink()) throw new ReceiptError('refusing terminal lock on non-directory inbox');
  const lockDir = join(owned, '.terminal-locks');
  mkdirSync(lockDir, { recursive: true });
  if (!lstatSync(lockDir).isDirectory() || lstatSync(lockDir).isSymbolicLink()) throw new ReceiptError('refusing terminal lock on unsafe lock directory');
  const lockPath = join(lockDir, `${tossId}.lock`);
  let fd;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { fd = openSync(lockPath, 'wx', 0o600); break; }
    catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      waitForLock();
    }
  }
  if (fd === undefined) throw new ReceiptError(`terminal transition is busy for ${tossId}; retry safely`);
  try { return fn(); }
  finally {
    try { closeSync(fd); unlinkSync(lockPath); } catch { /* leave a fail-closed stale lock */ }
  }
}

/** Build the immutable, receiver-authored receipt body. */
export function buildTerminalReceipt(item, opts = {}) {
  if (!item || !TERMINAL.has(item.status)) throw new ReceiptError('a receipt requires a terminal inbox item');
  const receiver = opts.receiverProject ?? resolveMemMeshProjectId(opts.cwd ?? process.cwd(), { allowEnvOverride: true });
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const state = item.status;
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : '';
  const verification = typeof opts.verification === 'string' ? opts.verification.trim() : '';
  const tossId = nonEmpty(item.id, 'toss_id');
  const toProject = nonEmpty(item.from_project, 'source_project');
  return {
    schema: 'xm.inbox.receipt.v1',
    id: receiptId(tossId, state),
    toss_id: tossId,
    from_project: receiver,
    to_project: toProject,
    terminal_state: state,
    terminal_at: at,
    summary,
    verification,
  };
}

function receiptLedgerItem(receipt) {
  return {
    id: receipt.id,
    from_project: receipt.from_project,
    to_project: receipt.to_project,
    created_at: receipt.terminal_at,
    status: receipt.terminal_state,
    title: `terminal receipt for ${receipt.toss_id}`,
    mem_mesh: {},
    receipt,
  };
}

/** Persist a receipt once. Existing ids must be byte-for-byte equivalent. */
export function persistReceipt(receipt, opts = {}) {
  validateReceipt(receipt);
  const cwd = opts.cwd ?? process.cwd();
  const dir = receiptDir(cwd);
  // `writeLedgerIfAbsent` is a link-based create-if-absent primitive. It is
  // essential here: a check-then-write would let two terminal transitions
  // race and overwrite what is supposed to be an immutable evidence record.
  const result = writeLedgerIfAbsent(dir, receiptLedgerItem(receipt), { cwd });
  if (!result.created) {
    if (JSON.stringify(result.item.receipt) !== JSON.stringify(receipt)) {
      throw new ReceiptError(`immutable receipt conflict for ${receipt.id}`);
    }
    return { receipt: result.item.receipt, created: false };
  }
  return { receipt, created: true };
}

export function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new ReceiptError('receipt must be an object');
  if (receipt.schema !== 'xm.inbox.receipt.v1') throw new ReceiptError('unsupported receipt schema');
  nonEmpty(receipt.id, 'receipt.id');
  nonEmpty(receipt.toss_id, 'receipt.toss_id');
  nonEmpty(receipt.from_project, 'receipt.from_project');
  nonEmpty(receipt.to_project, 'receipt.to_project');
  nonEmpty(receipt.terminal_at, 'receipt.terminal_at');
  if (!TERMINAL.has(receipt.terminal_state)) throw new ReceiptError('receipt.terminal_state must be resolved or dismissed');
  if (receipt.id !== receiptId(receipt.toss_id, receipt.terminal_state)) throw new ReceiptError('receipt id does not match toss id and terminal state');
  if (typeof receipt.summary !== 'string' || typeof receipt.verification !== 'string') throw new ReceiptError('receipt evidence must be strings');
  return receipt;
}

/** Exact MCP call arguments the skill must pass verbatim to mem-mesh add. */
export function buildReceiptPayload(receipt) {
  validateReceipt(receipt);
  return {
    add: {
      content: JSON.stringify(receipt),
      project_id: receipt.to_project,
      category: 'bug',
      tags: [RECEIPT_TAG],
    },
  };
}

/** Atomically choose (or reuse) exactly one terminal state and receipt. */
export function transitionWithReceipt(inboxDir, tossId, requestedState, opts = {}) {
  if (!TERMINAL.has(requestedState)) throw new ReceiptError('terminal state must be resolved or dismissed');
  const cwd = opts.cwd ?? process.cwd();
  return withTerminalLock(inboxDir, tossId, cwd, () => {
    const current = readLedger(inboxDir).find((entry) => entry.id === tossId);
    if (!current) throw new ReceiptError(`no inbox item for ${tossId}`);
    if (TERMINAL.has(current.status) && current.status !== requestedState) {
      throw new ReceiptError(`cannot ${requestedState === 'resolved' ? 'resolve' : 'dismiss'} an item already terminal as ${current.status}`);
    }
    let receipt;
    if (current.receipt) {
      const { transport: _transport, memory_id: _memoryId, ...body } = current.receipt;
      validateReceipt(body);
      if (body.terminal_state !== requestedState) throw new ReceiptError('existing receipt terminal state conflicts with requested transition');
      return { item: current, receipt: body, changed: false };
    }
    const at = new Date(opts.now ?? Date.now()).toISOString();
    const terminalItem = { ...current, status: requestedState, updated_at: at, resolved_at: at };
    receipt = buildTerminalReceipt(terminalItem, {
      cwd, receiverProject: opts.receiverProject, now: at, summary: opts.summary, verification: opts.verification,
    });
    persistReceipt(receipt, { cwd });
    const updated = { ...terminalItem, receipt: { ...receipt, transport: 'pending' } };
    writeLedger(inboxDir, updated, { cwd });
    return { item: updated, receipt, changed: true };
  });
}

/**
 * Reconcile a receiver receipt in the original sender outbox. It never lets
 * a receipt reopen or replace a previously accepted terminal decision.
 */
export function materializeReceipt(outboxDir, content, opts = {}) {
  let receipt;
  try { receipt = typeof content === 'string' ? JSON.parse(content) : content; }
  catch { throw new ReceiptError('receipt content is not valid JSON'); }
  validateReceipt(receipt);
  const cwd = opts.cwd ?? process.cwd();
  const localProject = opts.projectId ?? resolveMemMeshProjectId(cwd, { allowEnvOverride: true });
  if (receipt.to_project !== localProject) throw new ReceiptError('receipt targets a different source project');
  const item = readLedger(outboxDir).find((entry) => entry.id === receipt.toss_id);
  if (!item) throw new ReceiptError(`no outbox item for receipt toss id ${receipt.toss_id}`);
  if (item.from_project !== receipt.to_project) {
    throw new ReceiptError('receipt source identity does not match this outbox sender');
  }
  // A sender records the registry-independent target identity at capture
  // time. Without it a legacy outbox cannot safely authenticate a receipt.
  if (item.delivery_target_project !== receipt.from_project) {
    throw new ReceiptError('receipt origin does not match this outbox target');
  }
  const prior = item.receipt;
  if (prior) {
    if (prior.id === receipt.id && prior.terminal_state === receipt.terminal_state) return { item, applied: false };
    throw new ReceiptError(`conflicting terminal receipt already recorded for ${item.id}`);
  }
  const updated = {
    ...item,
    status: receipt.terminal_state,
    resolved_at: receipt.terminal_at,
    updated_at: receipt.terminal_at,
    receipt: { ...receipt, transport: 'received' },
  };
  writeLedger(outboxDir, updated, { cwd });
  return { item: updated, applied: true };
}

/** Store successful delivery without changing the terminal receipt itself. */
export function recordReceiptTransport(inboxDir, tossId, memoryId, opts = {}) {
  nonEmpty(memoryId, 'memory_id');
  const item = readLedger(inboxDir).find((entry) => entry.id === tossId);
  if (!item || !item.receipt) throw new ReceiptError(`no pending receipt for ${tossId}`);
  if (item.receipt.transport === 'delivered' && item.receipt.memory_id === memoryId) return item;
  const updated = { ...item, receipt: { ...item.receipt, transport: 'delivered', memory_id: memoryId } };
  writeLedger(inboxDir, updated, { cwd: opts.cwd ?? process.cwd() });
  return updated;
}

export function receiptStatus(cwd, tossId) {
  const inbox = readLedger(join(cwd, '.xm', 'inbox')).find((item) => item.id === tossId);
  const outbox = readLedger(join(cwd, '.xm', 'outbox')).find((item) => item.id === tossId);
  const item = inbox ?? outbox;
  if (!item) throw new ReceiptError(`no inbox or outbox item for ${tossId}`);
  return { scope: inbox ? 'inbox' : 'outbox', item_id: item.id, status: item.status, receipt: item.receipt ?? null };
}
