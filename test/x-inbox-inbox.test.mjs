/**
 * x-inbox inbox — list/take/drop over a ledger dir, plus pin
 * re-notification. Covers cross-project-handoff t7 done_criteria: status
 * updates from list/take/drop, and — after forcing a pin to `completed`
 * (simulating mem-mesh's 7-day auto-close) — renotify recreating exactly one
 * new pin, even across repeated calls (PRD §7.5 R7: "3 consecutive session
 * starts after expiry, pin stays at 1 per item").
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeLedger, readLedger } from '../xm/lib/x-inbox/ledger.mjs';
import {
  InboxItemNotFoundError,
  list,
  take,
  drop,
  reconcileItemPin,
  reconcileAllPins,
} from '../xm/lib/x-inbox/inbox.mjs';

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
    fix_direction: 'check the branch that collapses paused into ok in state judgement',
    ...overrides,
  };
}

/**
 * Fake PinPort. Tracks a create() call count so tests can assert
 * "recreated exactly once" directly, and exposes forceCompleted() to
 * simulate mem-mesh's 7-day auto-close flipping a pin's status without
 * deleting it (PRD C5).
 */
function makeFakePinPort() {
  const store = new Map(); // pin_id -> { status }
  let seq = 0;
  return {
    createCalls: 0,
    getStateCalls: 0,
    seedPin(pinId, status = 'in_progress') {
      store.set(pinId, { status });
      return pinId;
    },
    forceCompleted(pinId) {
      if (!store.has(pinId)) throw new Error(`forceCompleted: unknown pin "${pinId}"`);
      store.set(pinId, { status: 'completed' });
    },
    async getState(pinId) {
      this.getStateCalls += 1;
      return store.has(pinId) ? { ...store.get(pinId) } : null;
    },
    async create(/* item */) {
      this.createCalls += 1;
      seq += 1;
      const pinId = `pin-${seq}`;
      store.set(pinId, { status: 'in_progress' });
      return { pin_id: pinId };
    },
  };
}

let root;
let dir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'x-inbox-inbox-'));
  dir = join(root, '.xm', 'inbox');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('list — unresolved first, addressed by id', () => {
  test('sorts delivered before actioned before dismissed', () => {
    writeLedger(dir, makeItem({ id: 'c-dismissed', status: 'dismissed', created_at: '2026-07-19T00:00:00.000Z' }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'a-delivered', status: 'delivered', created_at: '2026-07-19T01:00:00.000Z' }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'b-actioned', status: 'actioned', created_at: '2026-07-19T02:00:00.000Z' }), { cwd: root });

    const items = list(dir);
    expect(items.map((i) => i.id)).toEqual(['a-delivered', 'b-actioned', 'c-dismissed']);
  });

  test('every item is addressable by a stable id field, not array position', () => {
    writeLedger(dir, makeItem({ id: 'item-1' }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'item-2', created_at: '2026-07-19T03:00:00.000Z' }), { cwd: root });
    const items = list(dir);
    for (const item of items) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
    }
  });

  test('empty/missing dir lists as empty array', () => {
    expect(list(dir)).toEqual([]);
  });
});

describe('take — status -> actioned, returns full body', () => {
  test('updates status on disk and returns why/repro/fix_direction', () => {
    writeLedger(dir, makeItem(), { cwd: root });
    const result = take(dir, 'toss-20260719-a1b2c3', { cwd: root });

    expect(result.status).toBe('actioned');
    expect(result.why).toBe('land after commit is paused but reported ok, later steps proceed wrongly');
    expect(result.repro.command).toBe('GK_AGENT=1 git-kit land');
    expect(result.fix_direction).toContain('state judgement');

    const [onDisk] = readLedger(dir);
    expect(onDisk.status).toBe('actioned');
  });

  test('unknown id throws InboxItemNotFoundError and writes nothing', () => {
    writeLedger(dir, makeItem(), { cwd: root });
    const filesBefore = readdirSync(dir);

    expect(() => take(dir, 'does-not-exist', { cwd: root })).toThrow(InboxItemNotFoundError);

    const filesAfter = readdirSync(dir);
    expect(filesAfter).toEqual(filesBefore);
    const [onDisk] = readLedger(dir);
    expect(onDisk.status).toBe('delivered');
  });
});

describe('drop — status -> dismissed', () => {
  test('updates status on disk', () => {
    writeLedger(dir, makeItem(), { cwd: root });
    const result = drop(dir, 'toss-20260719-a1b2c3', { cwd: root });
    expect(result.status).toBe('dismissed');

    const [onDisk] = readLedger(dir);
    expect(onDisk.status).toBe('dismissed');
  });

  test('unknown id throws InboxItemNotFoundError and writes nothing', () => {
    writeLedger(dir, makeItem(), { cwd: root });
    expect(() => drop(dir, 'nope', { cwd: root })).toThrow(InboxItemNotFoundError);
    const [onDisk] = readLedger(dir);
    expect(onDisk.status).toBe('delivered');
  });

  test('does not exist at all in an empty dir — throws, no directory created', () => {
    expect(existsSync(dir)).toBe(false);
    expect(() => drop(dir, 'anything', { cwd: root })).toThrow(InboxItemNotFoundError);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('reconcileItemPin / reconcileAllPins — renotify, at most 1 pin per item', () => {
  test('no pin recorded at all (degraded-path item) -> creates exactly one pin', async () => {
    writeLedger(dir, makeItem({ id: 'never-sent' }), { cwd: root });
    const pinPort = makeFakePinPort();

    const report = await reconcileItemPin(dir, 'never-sent', pinPort, { cwd: root });

    expect(report.recreated).toBe(true);
    expect(pinPort.createCalls).toBe(1);
    const [onDisk] = readLedger(dir);
    expect(onDisk.mem_mesh.pin_id).toBe(report.pin_id);
  });

  test('live pin (in_progress) -> no action, no pin created', async () => {
    const pinPort = makeFakePinPort();
    pinPort.seedPin('pin-original', 'in_progress');
    writeLedger(dir, makeItem({ mem_mesh: { pin_id: 'pin-original' } }), { cwd: root });

    const report = await reconcileItemPin(dir, 'toss-20260719-a1b2c3', pinPort, { cwd: root });

    expect(report.recreated).toBe(false);
    expect(pinPort.createCalls).toBe(0);
    const [onDisk] = readLedger(dir);
    expect(onDisk.mem_mesh.pin_id).toBe('pin-original');
  });

  test('forced-completed pin (7-day auto-close) + 3 consecutive session starts -> exactly 1 new pin, not 3', async () => {
    const pinPort = makeFakePinPort();
    pinPort.seedPin('pin-original', 'in_progress');
    writeLedger(dir, makeItem({ mem_mesh: { pin_id: 'pin-original' } }), { cwd: root });

    // Sanity: while the pin is still alive, reconciling is a no-op.
    await reconcileItemPin(dir, 'toss-20260719-a1b2c3', pinPort, { cwd: root });
    expect(pinPort.createCalls).toBe(0);

    // Simulate mem-mesh's 7-day auto-close: the pin isn't deleted, its
    // status flips to 'completed' (session.py:164 / PRD C5).
    pinPort.forceCompleted('pin-original');

    // 3 consecutive "session starts" after expiry (PRD §7.5 R7 failure mode).
    const reports = [];
    for (let i = 0; i < 3; i += 1) {
      reports.push(await reconcileItemPin(dir, 'toss-20260719-a1b2c3', pinPort, { cwd: root }));
    }

    expect(pinPort.createCalls).toBe(1);
    expect(reports[0].recreated).toBe(true);
    expect(reports[1].recreated).toBe(false);
    expect(reports[2].recreated).toBe(false);

    const finalPinId = reports[0].pin_id;
    expect(finalPinId).not.toBe('pin-original');
    expect(reports[1].pin_id).toBe(finalPinId);
    expect(reports[2].pin_id).toBe(finalPinId);

    const [onDisk] = readLedger(dir);
    expect(onDisk.mem_mesh.pin_id).toBe(finalPinId);
    // Item content itself (status, title, why...) untouched by renotify.
    expect(onDisk.status).toBe('delivered');
  });

  test('dismissed item with a dead pin -> left alone, no renotify', async () => {
    const pinPort = makeFakePinPort();
    pinPort.seedPin('pin-original', 'in_progress');
    writeLedger(dir, makeItem({ status: 'dismissed', mem_mesh: { pin_id: 'pin-original' } }), { cwd: root });
    pinPort.forceCompleted('pin-original');

    const report = await reconcileItemPin(dir, 'toss-20260719-a1b2c3', pinPort, { cwd: root });

    expect(report.recreated).toBe(false);
    expect(pinPort.createCalls).toBe(0);
    const [onDisk] = readLedger(dir);
    expect(onDisk.mem_mesh.pin_id).toBe('pin-original');
    expect(onDisk.status).toBe('dismissed');
  });

  test('unknown id throws InboxItemNotFoundError, no pinPort calls', async () => {
    const pinPort = makeFakePinPort();
    writeLedger(dir, makeItem(), { cwd: root });

    await expect(reconcileItemPin(dir, 'ghost', pinPort, { cwd: root })).rejects.toThrow(InboxItemNotFoundError);
    expect(pinPort.createCalls).toBe(0);
    expect(pinPort.getStateCalls).toBe(0);
  });

  test('reconcileAllPins walks every item in the dir, at most 1 new pin each', async () => {
    const pinPort = makeFakePinPort();
    pinPort.seedPin('pin-a', 'in_progress');
    writeLedger(dir, makeItem({ id: 'item-a', mem_mesh: { pin_id: 'pin-a' } }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'item-b', mem_mesh: undefined, created_at: '2026-07-19T05:00:00.000Z' }), { cwd: root });
    pinPort.forceCompleted('pin-a');

    const reports = await reconcileAllPins(dir, pinPort, { cwd: root });

    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.recreated)).toBe(true);
    expect(pinPort.createCalls).toBe(2);

    // Running it again immediately should not create any more pins.
    const secondPass = await reconcileAllPins(dir, pinPort, { cwd: root });
    expect(secondPass.every((r) => !r.recreated)).toBe(true);
    expect(pinPort.createCalls).toBe(2);
  });
});
