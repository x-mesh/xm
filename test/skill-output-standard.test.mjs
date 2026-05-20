// Enforces docs/skill-output-standard.md §6/§8: every in-scope (narrative) skill
// must carry the inline mode-aware "Korean output style (avoid AI-slop)" block.
// Checks the shipped artifact (xm/skills/<name>/SKILL.md) so both standalone-synced
// and bundle-native skills are covered in one place.
import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCK = '### Korean output style (avoid AI-slop)';

// docs/skill-output-standard.md §6 — narrative skills (terse-status UI skills exempt)
const IN_SCOPE = [
  'review', 'humble', 'build', 'probe', 'eval', 'solver', 'op',
  'ship', 'agent', 'humanize', 'memory', 'trace',
];

const skillPath = (name) => join(ROOT, 'xm', 'skills', name, 'SKILL.md');

describe('skill output standard (docs/skill-output-standard.md §6/§8)', () => {
  for (const name of IN_SCOPE) {
    test(`${name} carries the inline mode-aware output-style block`, () => {
      const p = skillPath(name);
      expect(existsSync(p)).toBe(true);
      const c = readFileSync(p, 'utf8');
      // Block present (§5 inline mechanism)
      expect(c).toContain(BLOCK);
      // Not a stub — must carry the mode-aware structure, not just the header (§3/§4)
      expect(c).toMatch(/Universal \(both modes\)/);
      expect(c).toContain('empty intensifiers');
      expect(c).toMatch(/Easy\/normal mode:|normal mode:/);
    });
  }
});
