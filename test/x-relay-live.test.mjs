import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveSessionFiles } from '../xm/lib/x-relay-live.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
function check(provider, psOutput, lsofOutput, error = null) {
  const root = mkdtempSync(join(tmpdir(), 'relay-live-'));
  try {
    writeFileSync(join(root, `${ID}.lock`), '');
    const filename = join(realpathSync(root), `${ID}.lock`);
    return liveSessionFiles(root, provider, command => command === 'lsof'
      ? { status: error ? 2 : 0, stderr: error || '', stdout: lsofOutput || `p123\nc${provider}\nf4\nn${filename}\n` }
      : { status: 0, stdout: psOutput });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('requires an active matching process, excluding daemon owners and exited processes', () => {
  expect(check('codex', '123 codex codex resume thread\n').get(ID)).toEqual([123]);
  expect(check('codex', '123 codex codex app-server daemon\n').size).toBe(0);
  expect(check('codex', '').size).toBe(0);
  expect(check('agy', '123 agy agy --conversation thread\n').get(ID)).toEqual([123]);
  expect(check('agy', '123 cat cat presence-file\n').size).toBe(0);
});

test('does not promote an unrelated open file or hide verification failure as an empty list', () => {
  expect(check('agy', '123 agy agy\n', 'p123\ncagy\nf4\nn/other/file.lock\n').size).toBe(0);
  expect(() => check('agy', '', '', 'permission denied')).toThrow('cannot verify');
});
