import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(REPO, 'x-humanize', 'skills', 'humanize', 'SKILL.md');
const BUNDLE = join(REPO, 'xm', 'skills', 'humanize', 'SKILL.md');

describe('humanize skill execution contract', () => {
  const source = readFileSync(SOURCE, 'utf8');

  test('defines unambiguous option parsing', () => {
    expect(source).toContain('### Argument parsing contract');
    expect(source).toContain('| Token | Action |');
    expect(source).not.toContain('| First word | Action |');
    expect(source).toContain('`--` ends option parsing');
    expect(source).toContain('Consume `--lang en|ko` wherever it appears before `--`');
    expect(source).toContain('For `voice`, consume the next argument as the sample file');
    expect(source).toContain('then continue\n   parsing global options');
  });

  test('protects non-prose spans and verifies lossless restoration', () => {
    expect(source).toContain('### Protected-span pass');
    expect(source).toContain('restore every protected span\nbyte-for-byte');
    expect(source).toContain('count, order, and\ncontents of protected spans must match');
    expect(source).toContain('[ ] Protected spans restored byte-for-byte');
    expect(source.indexOf('Restore the protected-span map and verify it losslessly'))
      .toBeLessThan(source.indexOf('Then compare the fully restored draft against the fact inventory'));
  });

  test('uses a bounded and reproducible change-rate formula', () => {
    expect(source).toContain('levenshtein(original, rewrite) / max(len(original), len(rewrite), 1)');
    expect(source).not.toContain('edit_distance(original, rewrite) / len(original)');
  });

  test('does not block on ambiguous genre classification', () => {
    expect(source).toContain('mark the genre `uncertain`');
    expect(source).toContain('Do not\npause solely to ask the user to classify the genre');
  });

  test('bundle copy stays byte-identical to the source skill', () => {
    expect(readFileSync(BUNDLE, 'utf8')).toBe(source);
  });

  test('ui mode loads the meaning pass and a file per language', () => {
    expect(source).toContain('**Load `references/ui-meaning.md` first, then the language file: `references/ui-strings-ko.md` for Korean, `references/ui-strings-en.md` for English.**');
    expect(source.indexOf('4. **Check meaning**')).toBeGreaterThan(source.indexOf('3. **Group by screen**'));
    expect(source.indexOf('4. **Check meaning**')).toBeLessThan(source.indexOf('5. **Apply rules**'));
  });

  test('ui references ship in the bundle unchanged', () => {
    for (const name of ['ui-meaning.md', 'ui-strings-ko.md', 'ui-strings-en.md']) {
      const ref = join('skills', 'humanize', 'references', name);
      expect(readFileSync(join(REPO, 'xm', ref), 'utf8')).toBe(readFileSync(join(REPO, 'x-humanize', ref), 'utf8'));
    }
  });
});

describe('ui string regression cases', () => {
  const { cases } = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'ui-string-cases.json'), 'utf8'));

  test('judge by criteria, not a single reference output', () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.mode).toBe('ui');
      expect(['ko', 'en']).toContain(c.lang);
      expect(c.must.length).toBeGreaterThan(0);
      expect(c.must_not.length).toBeGreaterThan(0);
      expect(c).not.toHaveProperty('expected');
      for (const item of c.input) expect(typeof item[c.lang]).toBe('string');
    }
  });

  test('cover both languages, a missing-evidence flag, and unchanged strings', () => {
    const ids = cases.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([
      'astar-run-mode-option', 'astar-boundary-heading', 'ko-no-context-flag', 'ko-negative-clear-labels', 'en-run-mode-option',
    ]));
  });
});
