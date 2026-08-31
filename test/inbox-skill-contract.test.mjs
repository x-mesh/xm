import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(join(ROOT, 'xm', 'skills', 'inbox', 'SKILL.md'), 'utf8');
const INVENTORY_DOC = readFileSync(join(ROOT, 'xm', 'lib', 'x-inbox', 'inbox.mjs'), 'utf8');

describe('inbox skill pin inventory contract', () => {
  test('queries every pin status explicitly before reconcile', () => {
    for (const status of ['open', 'in_progress', 'completed']) {
      expect(SKILL).toContain('status="' + status + '"');
    }
    expect(SKILL).toContain('`id`로 중복 제거');
    expect(SKILL).toContain('상태 하나라도 조회하지 못했을 때도');
    expect(SKILL).toContain('`--partial`을 붙입니다');
  });

  test('does not document a status-less pin listing as complete inventory', () => {
    expect(SKILL).not.toMatch(/mcp__mem-mesh__pin_list\(project_id=[^\n]+tags=\["inbox"\], limit=10\)/);
    expect(INVENTORY_DOC).toContain('A status-less call is not a complete inventory');
  });
});
