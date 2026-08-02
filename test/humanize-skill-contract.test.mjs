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
});
