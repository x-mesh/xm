import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
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
    for (const step of ['3. **Group by screen**', '4. **Check meaning**', '5. **Apply rules**']) expect(source).toContain(step);
    expect(source.indexOf('4. **Check meaning**')).toBeGreaterThan(source.indexOf('3. **Group by screen**'));
    expect(source.indexOf('4. **Check meaning**')).toBeLessThan(source.indexOf('5. **Apply rules**'));
  });

  test('ui references ship in the bundle unchanged', () => {
    for (const name of ['ui-meaning.md', 'ui-strings-ko.md', 'ui-strings-en.md']) {
      const ref = join('skills', 'humanize', 'references', name);
      expect(readFileSync(join(REPO, 'xm', ref), 'utf8')).toBe(readFileSync(join(REPO, 'x-humanize', ref), 'utf8'));
    }
  });

  test('ui mode takes a screen in a codebase and answers with a report', () => {
    const wrapper = readFileSync(join(REPO, 'x-humanize', 'commands', 'humanize.md'), 'utf8');
    expect(wrapper).toContain('is `ui` mode even without the token');
    expect(wrapper).toContain('a report that opens by stating that no file was changed');
    expect(wrapper).toContain('apply only the edits you already showed');
    expect(readFileSync(join(REPO, 'xm', 'commands', 'humanize.md'), 'utf8')).toBe(wrapper);

    expect(source).toContain('2. **Load the glossary and build the term inventory**');
    expect(source).toContain('Do not pick suspects out of a context-free list of strings.');
    expect(source).toContain('re-check M-5');
    expect(source).toContain('then emit by input shape');

    const ref = (name) => readFileSync(join(REPO, 'x-humanize', 'skills', 'humanize', 'references', name), 'utf8');
    const meaning = ref('ui-meaning.md');
    for (const heading of ['## Input from a codebase', '## Term inventory', '## Report for file or screen input', '## Applying to files']) {
      expect(meaning).toContain(heading);
    }
    expect(meaning).toContain('| M-6 |');
    expect(meaning.indexOf('## Term inventory')).toBeLessThan(meaning.indexOf('## M rules — meaning'));

    const ko = ref('ui-strings-ko.md');
    const en = ref('ui-strings-en.md');
    expect(ko).toContain('| O-1 |');
    for (const file of [ko, en]) {
      expect(file).toContain('`G-P`');
      expect(file).toContain('O-1');
      for (const type of ['table_header', 'tab', 'badge', 'tooltip', 'legend', 'placeholder', 'notification']) {
        expect(file).toContain(`| \`${type}\` |`);
      }
    }
  });

  test('tooltip periods follow the other tooltips on the screen', () => {
    const ref = (name) => readFileSync(join(REPO, 'x-humanize', 'skills', 'humanize', 'references', name), 'utf8');
    expect(ref('ui-strings-ko.md')).toMatch(/\| `tooltip` \|.*같은 화면의 `tooltip`끼리만 맞춘다\. 모두 같으면 고치지 않고/);
    expect(ref('ui-strings-en.md')).toMatch(/\| `tooltip` \|.*Match only the other tooltips on the same screen\. Leave them when they agree/);
  });

  test('skill stays within the 500-line budget', () => {
    expect(source.trimEnd().split('\n').length).toBeLessThanOrEqual(500);
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
      if (c.input_files) {
        expect(typeof c.request).toBe('string');
        for (const file of c.input_files) expect(existsSync(join(REPO, file))).toBe(true);
      } else {
        for (const item of c.input) expect(typeof item[c.lang]).toBe('string');
      }
    }
  });

  test('cover failures seen on a screen written directly in Korean', () => {
    const ids = cases.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([
      'ko-term-two-names', 'ko-action-state-name', 'ko-three-sentence-why', 'ko-label-keeps-object',
      'ko-native-verb-button', 'ko-internal-name-flag', 'ko-spacing-coded', 'ko-area-input',
      'ko-tooltip-period-kept',
    ]));
  });

  test('cover both languages, a missing-evidence flag, and unchanged strings', () => {
    const ids = cases.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([
      'astar-run-mode-option', 'astar-boundary-heading', 'ko-no-context-flag', 'ko-negative-clear-labels', 'en-run-mode-option',
    ]));
  });
});
