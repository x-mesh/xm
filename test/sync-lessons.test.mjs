import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalLessonPath, mergeLessonVersions, migrateLessonStore } from '../x-sync/lib/x-sync/sync-lessons.mjs';

const tempRoot = () => join(tmpdir(), 'sync-lessons-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const lesson = (count, last, extra = {}) => JSON.stringify({
  id: 'L1', type: 'STOP', content: 'Avoid duplicate work', reason: 'sync',
  confirmed_count: count, status: 'recorded', applied_to_claudemd: false,
  created_at: '2026-01-01T00:00:00Z', last_confirmed: last, ...extra,
});

describe('humble lesson sync canonicalization', () => {
  test('collapses compounded host suffixes to one canonical path', () => {
    expect(canonicalLessonPath('humble/lessons/L1.json')).toBe('humble/lessons/L1.json');
    expect(canonicalLessonPath('humble/lessons/L1.mac-a.local.mac-b.json')).toBe('humble/lessons/L1.json');
    expect(canonicalLessonPath('humble/retrospectives/L1.json')).toBeNull();
  });

  test('migration removes duplicates and keeps the strongest idempotent state', () => {
    const root = tempRoot();
    const dir = join(root, 'humble', 'lessons');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'L1.json'), lesson(2, '2026-01-02T00:00:00Z'));
    writeFileSync(join(dir, 'L1.mac-a.json'), lesson(5, '2026-01-03T00:00:00Z', { applied_to_claudemd: true }));
    writeFileSync(join(dir, 'L1.mac-a.mac-b.json'), lesson(5, '2026-01-03T00:00:00Z', { applied_to_claudemd: true }));
    expect(migrateLessonStore(root).removed).toBe(2);
    expect(readdirSync(dir)).toEqual(['L1.json']);
    expect(JSON.parse(readFileSync(join(dir, 'L1.json'), 'utf8'))).toMatchObject({ confirmed_count: 5, applied_to_claudemd: true });
    expect(migrateLessonStore(root).removed).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test('remote suffix variants merge into canonical without namespaced copies', () => {
    const root = tempRoot();
    const result = mergeLessonVersions(root, 'humble/lessons/L1.json', [
      { content: lesson(3, '2026-01-02T00:00:00Z') },
      { content: lesson(4, '2026-01-04T00:00:00Z') },
    ]);
    expect(result.written).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'humble/lessons/L1.json'), 'utf8')).confirmed_count).toBe(4);
    expect(readdirSync(join(root, 'humble', 'lessons'))).toEqual(['L1.json']);
    rmSync(root, { recursive: true, force: true });
  });
});
