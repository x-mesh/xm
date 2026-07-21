/**
 * x-inbox ledger — schema validation, read/write idempotency, cwd-ownership
 * path-escape guard, and the 5 state-consistency rules (reconcile()).
 * Covers cross-project-handoff t2 done_criteria.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  STATUSES,
  RECONCILE_ACTIONS,
  isValidLedgerId,
  validateItem,
  assertOwnedLedgerDir,
  readLedger,
  writeLedger,
  reconcile,
  recordMemMesh,
  LedgerItemNotFoundError,
} from '../xm/lib/x-inbox/ledger.mjs';

function makeItem(overrides = {}) {
  return {
    id: 'toss-20260719-a1b2c3',
    from_project: 'x-kit',
    to_project: 'git-kit',
    created_at: '2026-07-19T02:30:00.000Z',
    status: 'delivered',
    title: 'land reports paused as ok',
    why: 'land after commit is paused but reported ok, later steps proceed wrongly',
    repro: { command: 'GK_AGENT=1 git-kit land', output: '<masked tail>', truncated: true },
    anchors: { from_commit: '0efdd7d', to_files: ['internal/cli/land.go'] },
    fix_direction: 'check the branch that collapses paused into ok in state判定',
    mem_mesh: { pin_id: 'pin-1', memory_id: 'mem-1' },
    ...overrides,
  };
}

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'x-inbox-ledger-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('validateItem — schema', () => {
  test('accepts a fully-populated item', () => {
    expect(() => validateItem(makeItem())).not.toThrow();
  });

  test('rejects non-object input', () => {
    expect(() => validateItem(null)).toThrow(TypeError);
    expect(() => validateItem('nope')).toThrow(TypeError);
    expect(() => validateItem([])).toThrow(TypeError);
  });

  for (const field of ['id', 'from_project', 'to_project', 'created_at', 'title']) {
    test(`rejects missing required field "${field}"`, () => {
      const item = makeItem();
      delete item[field];
      expect(() => validateItem(item)).toThrow(TypeError);
    });
  }

  test('rejects an invalid status value', () => {
    expect(() => validateItem(makeItem({ status: 'bogus' }))).toThrow(TypeError);
  });

  test('accepts every declared status', () => {
    for (const status of STATUSES) {
      expect(() => validateItem(makeItem({ status }))).not.toThrow();
    }
  });

  test('rejects an id containing a path separator', () => {
    expect(() => validateItem(makeItem({ id: '../../etc/passwd' }))).toThrow(TypeError);
    expect(() => validateItem(makeItem({ id: 'a/b' }))).toThrow(TypeError);
  });

  test('rejects non-object optional fields when present', () => {
    expect(() => validateItem(makeItem({ repro: 'not-an-object' }))).toThrow(TypeError);
    expect(() => validateItem(makeItem({ anchors: 'not-an-object' }))).toThrow(TypeError);
    expect(() => validateItem(makeItem({ anchors: { to_files: 'not-an-array' } }))).toThrow(TypeError);
  });

  test('isValidLedgerId matches validateItem\'s id acceptance', () => {
    expect(isValidLedgerId('toss-20260719-a1b2c3')).toBe(true);
    expect(isValidLedgerId('../escape')).toBe(false);
    expect(isValidLedgerId('')).toBe(false);
  });
});

describe('readLedger / writeLedger — round trip + idempotency', () => {
  test('missing directory reads back as empty array, not a throw', () => {
    expect(readLedger(join(root, 'nope'))).toEqual([]);
  });

  test('write then read returns the same item', () => {
    const dir = join(root, '.xm', 'outbox');
    const item = makeItem();
    writeLedger(dir, item, { cwd: root });
    const items = readLedger(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(item);
  });

  test('writing the same id twice is idempotent — one file, latest content wins', () => {
    const dir = join(root, '.xm', 'outbox');
    writeLedger(dir, makeItem({ status: 'delivered' }), { cwd: root });
    writeLedger(dir, makeItem({ status: 'actioned' }), { cwd: root });

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const items = readLedger(dir);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('actioned');
  });

  test('write leaves no leftover .tmp file (atomic write)', () => {
    const dir = join(root, '.xm', 'outbox');
    writeLedger(dir, makeItem(), { cwd: root });
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  test('readLedger skips a corrupt file instead of throwing', () => {
    const dir = join(root, '.xm', 'inbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'good.json'), JSON.stringify(makeItem({ id: 'good-item' })));
    writeFileSync(join(dir, 'bad.json'), '{ not valid json');
    const items = readLedger(dir);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('good-item');
  });

  test('readLedger sorts by created_at ascending', () => {
    const dir = join(root, '.xm', 'inbox');
    writeLedger(dir, makeItem({ id: 'item-later', created_at: '2026-07-20T00:00:00.000Z' }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'item-earlier', created_at: '2026-07-19T00:00:00.000Z' }), { cwd: root });
    const items = readLedger(dir);
    expect(items.map((i) => i.id)).toEqual(['item-earlier', 'item-later']);
  });
});

describe('writeLedger — cwd-ownership path-escape guard', () => {
  test('throws when dir resolves outside <cwd>/.xm/', () => {
    const outside = join(root, 'not-xm');
    expect(() => writeLedger(outside, makeItem(), { cwd: root })).toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  test('throws when dir tries to climb out via ../..', () => {
    const dir = join(root, '.xm', 'outbox', '..', '..', '..', 'escaped');
    expect(() => writeLedger(dir, makeItem(), { cwd: root })).toThrow();
  });

  test('throws when dir points at a sibling project\'s .xm/', () => {
    const otherProject = mkdtempSync(join(tmpdir(), 'x-inbox-other-'));
    try {
      const otherXm = join(otherProject, '.xm', 'inbox');
      expect(() => writeLedger(otherXm, makeItem(), { cwd: root })).toThrow();
      expect(existsSync(otherXm)).toBe(false);
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  test('accepts the .xm root itself, not just subdirectories', () => {
    const dir = join(root, '.xm');
    expect(() => writeLedger(dir, makeItem(), { cwd: root })).not.toThrow();
  });

  test('assertOwnedLedgerDir throws with the same rule writeLedger relies on', () => {
    expect(() => assertOwnedLedgerDir(join(root, 'elsewhere'), root)).toThrow();
    expect(() => assertOwnedLedgerDir(join(root, '.xm', 'outbox'), root)).not.toThrow();
  });
});

describe('recordMemMesh — write-back for skill-obtained pin_id/memory_id (t11)', () => {
  test('merges pin_id + memory_id into an item that had an empty mem_mesh', () => {
    const dir = join(root, '.xm', 'outbox');
    writeLedger(dir, makeItem({ mem_mesh: {} }), { cwd: root });

    const updated = recordMemMesh(dir, 'toss-20260719-a1b2c3', { pin_id: 'pin-9', memory_id: 'mem-9' }, { cwd: root });
    expect(updated.mem_mesh).toEqual({ pin_id: 'pin-9', memory_id: 'mem-9' });

    const [onDisk] = readLedger(dir);
    expect(onDisk.mem_mesh).toEqual({ pin_id: 'pin-9', memory_id: 'mem-9' });
  });

  test('is additive — recording only memory_id later preserves an already-recorded pin_id', () => {
    const dir = join(root, '.xm', 'outbox');
    writeLedger(dir, makeItem({ mem_mesh: {} }), { cwd: root });

    recordMemMesh(dir, 'toss-20260719-a1b2c3', { pin_id: 'pin-9' }, { cwd: root });
    const updated = recordMemMesh(dir, 'toss-20260719-a1b2c3', { memory_id: 'mem-9' }, { cwd: root });

    expect(updated.mem_mesh).toEqual({ pin_id: 'pin-9', memory_id: 'mem-9' });
  });

  test('leaves every other field of the item untouched', () => {
    const dir = join(root, '.xm', 'outbox');
    writeLedger(dir, makeItem({ mem_mesh: {} }), { cwd: root });

    const updated = recordMemMesh(dir, 'toss-20260719-a1b2c3', { pin_id: 'pin-9' }, { cwd: root });
    expect(updated.title).toBe('land reports paused as ok');
    expect(updated.repro.command).toBe('GK_AGENT=1 git-kit land');
    expect(updated.status).toBe('delivered');
  });

  test('throws LedgerItemNotFoundError and writes nothing when id does not exist', () => {
    const dir = join(root, '.xm', 'outbox');
    writeLedger(dir, makeItem(), { cwd: root });
    const filesBefore = readdirSync(dir);

    expect(() => recordMemMesh(dir, 'does-not-exist', { pin_id: 'pin-9' }, { cwd: root }))
      .toThrow(LedgerItemNotFoundError);

    const filesAfter = readdirSync(dir);
    expect(filesAfter).toEqual(filesBefore);
  });
});

describe('reconcile — 5 state-consistency rules (PRD §8)', () => {
  const unresolved = { status: 'delivered' };
  const inProgress = { status: 'in_progress' };
  const resolved = { status: 'resolved' };
  const dismissed = { status: 'dismissed' };

  test('rule 1: pin present + ledger present -> none (normal)', () => {
    expect(reconcile({ status: 'in_progress' }, unresolved)).toEqual({
      action: RECONCILE_ACTIONS.NONE,
      reason: 'normal',
    });
  });

  test('rule 2: pin absent + ledger present unresolved -> renotify (7-day expiry)', () => {
    expect(reconcile(null, unresolved)).toEqual({
      action: RECONCILE_ACTIONS.RENOTIFY,
      reason: 'pin_expired',
    });
  });

  test('rule 3: pin present + ledger absent -> self_create', () => {
    expect(reconcile({ status: 'in_progress' }, null)).toEqual({
      action: RECONCILE_ACTIONS.SELF_CREATE,
      reason: 'ledger_missing',
    });
  });

  test('rule 4: pin absent + ledger absent -> none (closed)', () => {
    expect(reconcile(null, null)).toEqual({
      action: RECONCILE_ACTIONS.NONE,
      reason: 'closed',
    });
  });

  test('rule 5: pin completed + ledger still unresolved -> sync_status (missed update)', () => {
    expect(reconcile({ status: 'completed' }, unresolved)).toEqual({
      action: RECONCILE_ACTIONS.SYNC_STATUS,
      reason: 'pin_completed_ledger_unresolved',
    });
  });

  test('pin absent + ledger already dismissed -> none (resolved, not a renotify)', () => {
    expect(reconcile(null, dismissed)).toEqual({
      action: RECONCILE_ACTIONS.NONE,
      reason: 'resolved',
    });
  });

  test('pin absent + ledger explicitly resolved -> none, not a renotify', () => {
    expect(reconcile(null, resolved)).toEqual({
      action: RECONCILE_ACTIONS.NONE,
      reason: 'resolved',
    });
  });

  test('pin absent + ledger in progress -> renotify', () => {
    expect(reconcile(null, inProgress)).toEqual({
      action: RECONCILE_ACTIONS.RENOTIFY,
      reason: 'pin_expired',
    });
  });

  test('pin present (in_progress) + ledger dismissed -> none (both terminal)', () => {
    expect(reconcile({ status: 'in_progress' }, dismissed)).toEqual({
      action: RECONCILE_ACTIONS.NONE,
      reason: 'normal',
    });
  });

  test('pin completed + ledger dismissed -> none, not a spurious sync_status', () => {
    expect(reconcile({ status: 'completed' }, dismissed)).toEqual({
      action: RECONCILE_ACTIONS.NONE,
      reason: 'normal',
    });
  });

  test('pin completed + ledger resolved -> none, not a spurious sync_status', () => {
    expect(reconcile({ status: 'completed' }, resolved)).toEqual({
      action: RECONCILE_ACTIONS.NONE,
      reason: 'normal',
    });
  });

  test('is a total function over the full pin x ledger truth table (no unhandled combo)', () => {
    const pinStates = [null, { status: 'in_progress' }, { status: 'completed' }];
    const ledgerStates = [null, unresolved, inProgress, resolved, dismissed];
    for (const pin of pinStates) {
      for (const ledger of ledgerStates) {
        const result = reconcile(pin, ledger);
        expect(Object.values(RECONCILE_ACTIONS)).toContain(result.action);
        expect(typeof result.reason).toBe('string');
      }
    }
  });
});

describe('recordMemMesh — capture→delivered promotion (review-fix)', () => {
  // One enum was serving two lifecycles: the sender writes its outbox copy
  // BEFORE any MCP call, so starting at 'delivered' persisted a false success.
  // 'captured' is the honest capture-time state; transport promotes it.
  function seed(root, overrides = {}) {
    const outbox = join(root, '.xm', 'outbox');
    const item = {
      id: 'toss-20260719-aaaaaaaa',
      from_project: 'x-kit',
      to_project: 'git-kit',
      created_at: '2026-07-19T00:00:00.000Z',
      status: 'captured',
      title: 't',
      why: '',
      repro: { command: 'c', output: 'o', truncated: false },
      anchors: { from_commit: null, to_files: [] },
      fix_direction: 'f',
      mem_mesh: {},
      ...overrides,
    };
    writeLedger(outbox, item, { cwd: root });
    return item;
  }

  test('a pin id promotes captured → delivered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-promote-'));
    try {
      const item = seed(dir);
      const updated = recordMemMesh(join(dir, '.xm', 'outbox'), item.id, { pin_id: 'pin-1' }, { cwd: dir });
      expect(updated.status).toBe('delivered');
      expect(updated.mem_mesh.pin_id).toBe('pin-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a memory id alone also promotes (partial delivery still counts)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-promote2-'));
    try {
      const item = seed(dir);
      const updated = recordMemMesh(join(dir, '.xm', 'outbox'), item.id, { memory_id: 'mem-1' }, { cwd: dir });
      expect(updated.status).toBe('delivered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recording with NO ids leaves the item captured — never a false success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-promote3-'));
    try {
      const item = seed(dir);
      const updated = recordMemMesh(join(dir, '.xm', 'outbox'), item.id, {}, { cwd: dir });
      expect(updated.status).toBe('captured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an already progressed/terminal item is never re-opened by a late id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-promote4-'));
    try {
      const item = seed(dir, { status: 'dismissed' });
      const updated = recordMemMesh(join(dir, '.xm', 'outbox'), item.id, { pin_id: 'pin-late' }, { cwd: dir });
      expect(updated.status).toBe('dismissed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
