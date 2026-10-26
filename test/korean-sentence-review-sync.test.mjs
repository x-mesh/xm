import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '<!-- korean-sentence-review:begin -->';
const END = '<!-- korean-sentence-review:end -->';
const SKILLS = {
  humanize: join(REPO, 'x-humanize', 'skills', 'humanize', 'SKILL.md'),
  write: join(REPO, 'xm', 'skills', 'write', 'SKILL.md'),
};

function sharedBlock(path) {
  const text = readFileSync(path, 'utf8');
  expect(text.split(BEGIN).length - 1).toBe(1);
  expect(text.split(END).length - 1).toBe(1);
  const start = text.indexOf(BEGIN) + BEGIN.length;
  const end = text.indexOf(END);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('shared Korean sentence review', () => {
  test('humanize and write carry the same block', () => {
    const humanize = sharedBlock(SKILLS.humanize);
    const write = sharedBlock(SKILLS.write);
    expect(humanize.trim().length).toBeGreaterThan(0);
    expect(write).toBe(humanize);
  });
});
