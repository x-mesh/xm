/**
 * x-inbox retention — pure archivability decision + archiveExpired() sweep.
 * Covers cross-project-handoff t8 done_criteria: terminal items (resolved /
 * dismissed) move to archive after 30 days; unresolved (delivered) items
 * never do, no matter their age.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeLedger, readLedger } from '../xm/lib/x-inbox/ledger.mjs';
import {
  DEFAULT_RETENTION_DAYS,
  TERMINAL_STATUSES,
  isTerminal,
  terminalSince,
  isArchivable,
  partitionForArchive,
  archiveDirFor,
  readArchive,
  archiveExpired,
} from '../xm/lib/x-inbox/retention.mjs';

function daysAgoISO(days, from = '2026-07-19T00:00:00.000Z') {
  const base = new Date(from).getTime();
  return new Date(base - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeItem(overrides = {}) {
  return {
    id: 'toss-20260101-a1b2c3',
    from_project: 'x-kit',
    to_project: 'git-kit',
    created_at: daysAgoISO(0),
    status: 'delivered',
    title: 'sample item',
    ...overrides,
  };
}

const NOW = '2026-07-19T00:00:00.000Z';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'x-inbox-retention-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isTerminal / terminalSince', () => {
  test('isTerminal is true only for resolved/dismissed', () => {
    expect(isTerminal(makeItem({ status: 'delivered' }))).toBe(false);
    expect(isTerminal(makeItem({ status: 'in_progress' }))).toBe(false);
    expect(isTerminal(makeItem({ status: 'actioned' }))).toBe(false);
    expect(isTerminal(makeItem({ status: 'resolved' }))).toBe(true);
    expect(isTerminal(makeItem({ status: 'dismissed' }))).toBe(true);
    expect(isTerminal(makeItem({ status: 'bogus' }))).toBe(false);
    expect(isTerminal(null)).toBe(false);
  });

  test('TERMINAL_STATUSES matches isTerminal exactly', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(makeItem({ status }))).toBe(true);
    }
  });

  test('terminalSince prefers resolved_at, then updated_at, then created_at', () => {
    const created = daysAgoISO(10);
    const updated = daysAgoISO(5);
    const resolved = daysAgoISO(1);
    expect(terminalSince(makeItem({ created_at: created }))).toBe(created);
    expect(terminalSince(makeItem({ created_at: created, updated_at: updated }))).toBe(updated);
    expect(terminalSince(makeItem({ created_at: created, updated_at: updated, resolved_at: resolved })))
      .toBe(resolved);
  });
});

describe('isArchivable — pure, caller-supplied clock', () => {
  test('never archives a delivered (unresolved) item, even at 300 days — R11 core invariant', () => {
    const item = makeItem({ status: 'delivered', created_at: daysAgoISO(300, NOW) });
    expect(isArchivable(item, NOW)).toBe(false);
  });

  test('boundary: 29 days since terminal -> kept (not yet archivable)', () => {
    const item = makeItem({ status: 'resolved', created_at: daysAgoISO(29, NOW) });
    expect(isArchivable(item, NOW)).toBe(false);
  });

  test('boundary: exactly 30 days since terminal -> archivable', () => {
    const item = makeItem({ status: 'resolved', created_at: daysAgoISO(30, NOW) });
    expect(isArchivable(item, NOW)).toBe(true);
  });

  test('boundary: 31 days since terminal -> archivable', () => {
    const item = makeItem({ status: 'dismissed', created_at: daysAgoISO(31, NOW) });
    expect(isArchivable(item, NOW)).toBe(true);
  });

  test('respects a custom retentionDays override', () => {
    const item = makeItem({ status: 'resolved', created_at: daysAgoISO(10, NOW) });
    expect(isArchivable(item, NOW, 7)).toBe(true);
    expect(isArchivable(item, NOW, 14)).toBe(false);
  });

  test('uses resolved_at over created_at when both present (recent resolution keeps an old item)', () => {
    // Created 300 days ago but only resolved 5 days ago -> not yet archivable.
    const item = makeItem({
      status: 'resolved',
      created_at: daysAgoISO(300, NOW),
      resolved_at: daysAgoISO(5, NOW),
    });
    expect(isArchivable(item, NOW)).toBe(false);
  });

  test('a malformed/missing terminal timestamp is never archived (stays visible, not silently dropped)', () => {
    const item = makeItem({ status: 'resolved', created_at: 'not-a-date' });
    expect(isArchivable(item, NOW)).toBe(false);
  });

  test('DEFAULT_RETENTION_DAYS is 30', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });
});

describe('partitionForArchive', () => {
  test('splits a mixed batch into keep vs archive correctly', () => {
    const items = [
      makeItem({ id: 'a-delivered-old', status: 'delivered', created_at: daysAgoISO(300, NOW) }),
      makeItem({ id: 'b-progress-old', status: 'in_progress', created_at: daysAgoISO(300, NOW) }),
      makeItem({ id: 'c-resolved-expired', status: 'resolved', created_at: daysAgoISO(45, NOW) }),
      makeItem({ id: 'd-dismissed-expired', status: 'dismissed', created_at: daysAgoISO(30, NOW) }),
    ];
    const { keep, archive } = partitionForArchive(items, NOW);
    expect(keep.map((i) => i.id).sort()).toEqual(['a-delivered-old', 'b-progress-old']);
    expect(archive.map((i) => i.id).sort()).toEqual(['c-resolved-expired', 'd-dismissed-expired']);
  });

  test('empty input -> empty output, no throw', () => {
    expect(partitionForArchive([], NOW)).toEqual({ keep: [], archive: [] });
    expect(partitionForArchive(undefined, NOW)).toEqual({ keep: [], archive: [] });
  });
});

describe('archiveExpired — I/O sweep', () => {
  test('moves only expired terminal items; unresolved (delivered) survives at 300 days', () => {
    const dir = join(root, '.xm', 'inbox');
    writeLedger(dir, makeItem({ id: 'keep-delivered', status: 'delivered', created_at: daysAgoISO(300, NOW) }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'keep-progress-old', status: 'in_progress', created_at: daysAgoISO(300, NOW) }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'archive-resolved', status: 'resolved', created_at: daysAgoISO(30, NOW) }), { cwd: root });
    writeLedger(dir, makeItem({ id: 'archive-dismissed', status: 'dismissed', created_at: daysAgoISO(90, NOW) }), { cwd: root });

    const result = archiveExpired(dir, { now: NOW, cwd: root });

    expect(result.archivedIds.sort()).toEqual(['archive-dismissed', 'archive-resolved']);
    expect(result.keptItems.map((i) => i.id).sort()).toEqual(['keep-delivered', 'keep-progress-old']);

    // Live ledger only has the kept items left.
    const remaining = readLedger(dir);
    expect(remaining.map((i) => i.id).sort()).toEqual(['keep-delivered', 'keep-progress-old']);

    // Archived items are readable back (recoverable), with content intact.
    const archived = readArchive(dir);
    expect(archived.map((i) => i.id).sort()).toEqual(['archive-dismissed', 'archive-resolved']);
    const one = archived.find((i) => i.id === 'archive-resolved');
    expect(one.status).toBe('resolved');
    expect(one.title).toBe('sample item');
  });

  test('a second sweep is a safe no-op (idempotent) — no error, nothing left to archive', () => {
    const dir = join(root, '.xm', 'inbox');
    writeLedger(dir, makeItem({ id: 'archive-me', status: 'dismissed', created_at: daysAgoISO(60, NOW) }), { cwd: root });

    const first = archiveExpired(dir, { now: NOW, cwd: root });
    expect(first.archivedIds).toEqual(['archive-me']);

    const second = archiveExpired(dir, { now: NOW, cwd: root });
    expect(second.archivedIds).toEqual([]);
    expect(readArchive(dir).map((i) => i.id)).toEqual(['archive-me']);
  });

  test('no items eligible -> ledger untouched, empty archivedIds', () => {
    const dir = join(root, '.xm', 'inbox');
    writeLedger(dir, makeItem({ id: 'still-open', status: 'delivered', created_at: daysAgoISO(5, NOW) }), { cwd: root });

    const result = archiveExpired(dir, { now: NOW, cwd: root });
    expect(result.archivedIds).toEqual([]);
    expect(readLedger(dir)).toHaveLength(1);
    expect(existsSync(archiveDirFor(dir))).toBe(false);
  });

  test('archive lives in a subdirectory that readLedger(ledgerDir) never mistakes for a live item', () => {
    const dir = join(root, '.xm', 'inbox');
    writeLedger(dir, makeItem({ id: 'archive-me', status: 'resolved', created_at: daysAgoISO(40, NOW) }), { cwd: root });
    archiveExpired(dir, { now: NOW, cwd: root });

    // The archive subdirectory itself must not surface as a bogus item when
    // the live ledger dir is read again.
    const liveItems = readLedger(dir);
    expect(liveItems).toEqual([]);

    // Sanity: the archive dir actually exists and holds the moved file.
    expect(existsSync(archiveDirFor(dir))).toBe(true);
    const archiveFiles = readdirSync(archiveDirFor(dir)).filter((f) => f.endsWith('.json'));
    expect(archiveFiles).toEqual(['archive-me.json']);
  });

  test('respects a custom retentionDays option', () => {
    const dir = join(root, '.xm', 'inbox');
    writeLedger(dir, makeItem({ id: 'short-ttl', status: 'resolved', created_at: daysAgoISO(10, NOW) }), { cwd: root });

    const result = archiveExpired(dir, { now: NOW, cwd: root, retentionDays: 7 });
    expect(result.archivedIds).toEqual(['short-ttl']);
  });
});
