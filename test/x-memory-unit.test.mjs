/**
 * x-memory unit tests — direct import for coverage
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set X_MEMORY_ROOT before importing so ROOT resolves to temp dir
const ORIG = process.env.X_MEMORY_ROOT;
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'xmem-unit-'));
process.env.X_MEMORY_ROOT = TEST_ROOT;

const core = await import('../x-memory/lib/x-memory/core.mjs');
const store = await import('../x-memory/lib/x-memory/store.mjs');

afterAll(() => {
  if (ORIG !== undefined) process.env.X_MEMORY_ROOT = ORIG;
  else delete process.env.X_MEMORY_ROOT;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── parseDuration ────────────────────────────────────────────────────

describe('parseDuration', () => {
  test('parses "30d" to milliseconds', () => {
    expect(core.parseDuration('30d')).toBe(30 * 86400 * 1000);
  });

  test('parses "90d"', () => {
    expect(core.parseDuration('90d')).toBe(90 * 86400 * 1000);
  });

  test('returns null for null/undefined', () => {
    expect(core.parseDuration(null)).toBeNull();
    expect(core.parseDuration(undefined)).toBeNull();
  });

  test('returns null for invalid format', () => {
    expect(core.parseDuration('abc')).toBeNull();
    expect(core.parseDuration('30h')).toBeNull();
  });
});

// ── computeExpiresAt ─────────────────────────────────────────────────

describe('computeExpiresAt', () => {
  test('computes correct expiry from created + ttl', () => {
    const created = '2026-01-01T00:00:00.000Z';
    const result = core.computeExpiresAt(created, '30d');
    expect(result).toBe('2026-01-31T00:00:00.000Z');
  });

  test('returns null when no ttl', () => {
    expect(core.computeExpiresAt('2026-01-01T00:00:00.000Z', null)).toBeNull();
  });
});

// ── isExpired ────────────────────────────────────────────────────────

describe('isExpired', () => {
  test('not expired when expires_at is null', () => {
    expect(core.isExpired({ expires_at: null })).toBe(false);
  });

  test('expired when expires_at is in the past', () => {
    expect(core.isExpired({ expires_at: '2020-01-01T00:00:00Z' })).toBe(true);
  });

  test('not expired when expires_at is in the future', () => {
    expect(core.isExpired({ expires_at: '2099-01-01T00:00:00Z' })).toBe(false);
  });
});

// ── quoteYAML ────────────────────────────────────────────────────────

describe('quoteYAML', () => {
  test('returns plain string for simple values', () => {
    expect(core.quoteYAML('hello')).toBe('hello');
  });

  test('quotes strings with colons', () => {
    expect(core.quoteYAML('Choose Redis: Cache')).toBe('"Choose Redis: Cache"');
  });

  test('returns empty quotes for null', () => {
    expect(core.quoteYAML(null)).toBe('""');
  });
});

// ── parseFrontmatter ─────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  test('parses valid frontmatter', () => {
    const content = `---
id: mem-001
title: Test Memory
type: decision
tags: [auth, api]
created: 2026-01-01T00:00:00Z
ttl: null
---

## Body content`;

    const { meta, body } = core.parseFrontmatter(content);
    expect(meta.id).toBe('mem-001');
    expect(meta.title).toBe('Test Memory');
    expect(meta.type).toBe('decision');
    expect(meta.tags).toEqual(['auth', 'api']);
    expect(meta.ttl).toBeNull();
    expect(body).toContain('Body content');
  });

  test('handles content without frontmatter', () => {
    const { meta, body } = core.parseFrontmatter('Just plain text');
    expect(Object.keys(meta)).toHaveLength(0);
    expect(body).toBe('Just plain text');
  });
});

// ── readJSON / writeJSON ─────────────────────────────────────────────

describe('readJSON / writeJSON', () => {
  test('returns null for non-existent file', () => {
    expect(core.readJSON(join(TEST_ROOT, 'nope.json'))).toBeNull();
  });

  test('roundtrip write and read', () => {
    const path = join(TEST_ROOT, 'test-rw.json');
    core.writeJSON(path, { foo: 'bar' });
    expect(core.readJSON(path)).toEqual({ foo: 'bar' });
  });

  test('recovers from .bak on corrupt file', () => {
    const path = join(TEST_ROOT, 'test-bak.json');
    core.writeJSON(path, { good: true }); // creates .bak
    writeFileSync(path, 'CORRUPT{{{', 'utf8'); // corrupt main
    const result = core.readJSON(path);
    expect(result).toEqual({ good: true });
  });
});

// ── store: nextId ────────────────────────────────────────────────────

describe('nextId', () => {
  test('returns mem-001 for empty index', () => {
    expect(store.nextId([])).toBe('mem-001');
  });

  test('increments from highest existing', () => {
    const index = [{ id: 'mem-003' }, { id: 'mem-001' }];
    expect(store.nextId(index)).toBe('mem-004');
  });

  test('handles null index', () => {
    expect(store.nextId(null)).toBe('mem-001');
  });
});

// ── store: saveEntry / readIndex ─────────────────────────────────────

describe('saveEntry', () => {
  test('saves a decision with correct defaults', () => {
    const entry = store.saveEntry('Test Decision', { type: 'decision', why: 'test reason', tags: 'a,b' });
    expect(entry.id).toBe('mem-001');
    expect(entry.type).toBe('decision');
    expect(entry.ttl).toBeNull(); // decision = permanent
    expect(entry.expires_at).toBeNull();
    expect(entry.tags).toEqual(['a', 'b']);
    expect(entry.confidence).toBe('high');
  });

  test('saves a pattern with default TTL', () => {
    const entry = store.saveEntry('Test Pattern', { type: 'pattern' });
    expect(entry.ttl).toBe('90d');
    expect(entry.expires_at).not.toBeNull();
  });

  test('creates .md file', () => {
    const index = store.readIndex();
    const last = index[index.length - 1];
    const filepath = join(TEST_ROOT, 'memories', `${last.id}.md`);
    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, 'utf8');
    expect(content).toContain('Test Pattern');
  });
});

// ── store: searchIndex ───────────────────────────────────────────────

describe('searchIndex', () => {
  test('finds by title keyword', () => {
    const results = store.searchIndex('Decision');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('Decision');
  });

  test('finds by tag', () => {
    store.saveEntry('Tagged Memory', { type: 'learning', tags: 'uniquetag123' });
    const results = store.searchIndex('uniquetag123');
    expect(results.length).toBeGreaterThan(0);
  });

  test('returns empty for no match', () => {
    const results = store.searchIndex('zzzznonexistent');
    expect(results).toHaveLength(0);
  });
});

// ── store: deleteMemory ──────────────────────────────────────────────

describe('deleteMemory', () => {
  test('returns false for non-existent id', () => {
    expect(store.deleteMemory('mem-999')).toBe(false);
  });
});

// ── store: buildMemoryContent ────────────────────────────────────────

describe('buildMemoryContent', () => {
  test('generates valid frontmatter', () => {
    const entry = {
      id: 'mem-099',
      title: 'Test',
      type: 'decision',
      tags: ['a'],
      created: '2026-01-01T00:00:00Z',
      ttl: null,
      expires_at: null,
      confidence: 'high',
      source: 'manual',
      related_files: [],
      why: 'reason',
    };
    const content = store.buildMemoryContent(entry);
    expect(content).toContain('id: mem-099');
    expect(content).toContain('type: decision');
    expect(content).toContain('## Test');
  });
});
