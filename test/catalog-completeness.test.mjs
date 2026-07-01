// Catalog completeness (DISC-2): every marketplace plugin must be discoverable in
// BOTH user-facing catalogs — the /xm dispatcher table and the kit overview. This
// is the single-source guarantee: panel/recall/humanize shipped as plugins but were
// missing from both catalogs for months, so `/xm panel` answered "Unknown subcommand"
// and the kit overview listed only 4 of the toolkit. This test fails if a plugin is
// added to marketplace.json but not wired into the catalogs.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
const xmCmd = readFileSync(join(ROOT, 'xm', 'commands', 'xm.md'), 'utf8');
const kitSkill = readFileSync(join(ROOT, 'xm', 'skills', 'kit', 'SKILL.md'), 'utf8');

// The `xm` entry is the all-in-one bundle itself, not a sub-tool to list.
const plugins = (marketplace.plugins || [])
  .map((p) => p.name)
  .filter((n) => n && n !== 'xm');

describe('catalog completeness (DISC-2)', () => {
  test('every marketplace plugin appears in the /xm dispatcher table', () => {
    const missing = plugins.filter((n) => !new RegExp(`\\|\\s*\`${n}\``).test(xmCmd));
    expect(missing).toEqual([]);
  });

  test('every marketplace plugin appears in the "Unknown subcommand" fallback list', () => {
    const fallback = xmCmd.match(/Available:[^`]*/)?.[0] || '';
    const missing = plugins.filter((n) => !new RegExp(`\\b${n}\\b`).test(fallback));
    expect(missing).toEqual([]);
  });

  test('every marketplace plugin appears in the kit overview catalog', () => {
    const missing = plugins.filter((n) => !kitSkill.includes(`/xm:${n}`));
    expect(missing).toEqual([]);
  });
});
