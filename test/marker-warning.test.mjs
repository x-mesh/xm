// @ts-check
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeMergeMarker } from '../xm/lib/install/merge.mjs';
import { MARKER_BEGIN, MARKER_END } from '../xm/lib/install/types.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'xm-marker-warning-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('writeMergeMarker — user edit detection warning', () => {
  test('no warning on first install (file does not exist)', () => {
    const filePath = join(tmp, 'AGENTS.md');
    const result = writeMergeMarker(filePath, '# xm content\nsome skill text');
    expect(result.action).toBe('created');
    expect(result.warning).toBeUndefined();
  });

  test('no warning when content unchanged on re-install', () => {
    const filePath = join(tmp, 'AGENTS.md');
    const content = '# xm content\nsome skill text';
    writeMergeMarker(filePath, content);
    const result = writeMergeMarker(filePath, content);
    // unchanged action returns early — no warning field
    expect(result.action).toBe('unchanged');
    expect(result.warning).toBeUndefined();
  });

  test('emits warning when marker block content differs (user edited inside markers)', () => {
    const filePath = join(tmp, 'AGENTS.md');
    const originalContent = '# xm content\nsome skill text';
    // First install
    writeMergeMarker(filePath, originalContent);

    // Simulate user editing inside the marker block
    const userEdited = `${MARKER_BEGIN}\n# xm content\nsome skill text\n\nUSER ADDED THIS LINE\n${MARKER_END}\n`;
    writeFileSync(filePath, userEdited, 'utf8');

    // Re-install with different (new xm) content — should warn
    const newContent = '# xm content\nupdated skill text v2';
    const result = writeMergeMarker(filePath, newContent);
    expect(result.action).toBe('updated');
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/marker block content changed/);
    expect(result.warning).toMatch(/xm:BEGIN.*xm:END/);
  });

  test('no warning when xm content itself changes but no prior marker existed (append case)', () => {
    const filePath = join(tmp, 'AGENTS.md');
    // File exists but has no marker block — append path, not a user-edit scenario
    writeFileSync(filePath, '# Existing user content\n\nSome user text\n', 'utf8');

    const result = writeMergeMarker(filePath, '# xm content\nsome skill text');
    // This is a first-time append (rotated-and-updated or updated), not a user-edit overwrite
    expect(result.warning).toBeUndefined();
  });

  test('marker external content preserved after re-install with warning (regression)', () => {
    const filePath = join(tmp, 'AGENTS.md');
    const userPre = '# My custom header\n\n';
    const userPost = '\n## User section below markers\n\nUser content here.\n';

    // Initial file with user content surrounding the marker
    const initialContent = `${userPre}${MARKER_BEGIN}\n# original xm content\n${MARKER_END}\n${userPost}`;
    writeFileSync(filePath, initialContent, 'utf8');

    // Re-install with different xm content
    const result = writeMergeMarker(filePath, '# updated xm content');
    expect(result.action).toBe('updated');
    // warning should be emitted since content changed
    expect(result.warning).toBeDefined();

    // Verify external content is preserved
    const written = readFileSync(filePath, 'utf8');
    expect(written).toContain('# My custom header');
    expect(written).toContain('## User section below markers');
    expect(written).toContain('User content here.');
    expect(written).toContain(MARKER_BEGIN);
    expect(written).toContain(MARKER_END);
    expect(written).toContain('# updated xm content');
  });
});
