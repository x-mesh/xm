import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonHeldCodexFiles, interactiveCodexCwds, liveSessionFiles } from '../xm/lib/x-relay-live.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
function check(provider, psOutput, lsofOutput, error = null, detect = liveSessionFiles) {
  const root = mkdtempSync(join(tmpdir(), 'relay-live-'));
  try {
    writeFileSync(join(root, `${ID}.lock`), '');
    const filename = join(realpathSync(root), `${ID}.lock`);
    return detect(root, provider, command => command === 'lsof'
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

test('prompt text and option values do not turn an interactive session into a service', () => {
  for (const args of [
    'codex review queue handling',
    'codex investigate app-server startup',
    'codex --profile queue',
    'codex -pqueue review app-server startup',
    'codex --profile=app-server',
    'codex --config model=queue review app-server errors',
    'codex --no-daemon -- review queue handling',
    '/usr/local/bin/codex resume thread check queue state',
  ]) expect(check('codex', `123 codex ${args}\n`).get(ID)).toEqual([123]);
  for (const args of [
    'codex queue --thread thread --message hello',
    'codex --profile work app-server daemon',
    'codex -c model=test queue --thread thread --message hello',
    'codex --config=model=test app-server daemon',
    'codex -pwork app-server daemon',
    'codex -cmodel=test queue --thread thread --message hello',
  ]) expect(check('codex', `123 codex ${args}\n`).size).toBe(0);
});

const DAEMON = '/Users/me/.codex/packages/app-server-daemon/releases/0.161.0/bin/codex app-server --listen unix:// --managed-daemon';
const heldBy = psOutput => check('codex', psOutput, null, null, (root, _provider, run) => daemonHeldCodexFiles(root, run));

test('reads the executable from args when macOS ps cuts comm to its column width', () => {
  expect(check('codex', `123 /Users/me/.c ${DAEMON}\n`).size).toBe(0);
  expect(heldBy(`123 /Users/me/.c ${DAEMON}\n`)).toEqual(new Set([ID]));
  expect(check('codex', '123 /Users/me/co /Users/me/.local/bin/codex resume thread\n').get(ID)).toEqual([123]);
});

test('reports a thread as daemon-held only when every owner is a Codex service', () => {
  expect(heldBy('123 codex codex app-server daemon\n')).toEqual(new Set([ID]));
  expect(heldBy('123 codex codex resume thread\n').size).toBe(0);
  expect(heldBy('').size).toBe(0);
});

test('maps each interactive Codex CLI of this user to its working directory', () => {
  const uid = process.getuid();
  const cwd = realpathSync(tmpdir());
  const calls = [];
  const cwds = interactiveCodexCwds((command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'ps') {
      return { status: 0, stdout: [
        `101 ${uid} codex codex --dangerously-bypass-approvals-and-sandbox`,
        `102 ${uid} /Users/me/.c ${DAEMON}`,
        `103 ${uid + 1} codex codex resume other-user`,
        `104 ${uid} node node codex.js`,
        `105 ${uid} /Users/me/co /Users/me/.local/bin/codex --profile work`,
      ].join('\n') };
    }
    return { status: 0, stdout: `p101\nfcwd\nn${tmpdir()}\np105\nfcwd\nn/missing/dir\n` };
  });
  expect(calls[1]).toContain('-p 101,105');
  expect(cwds).toEqual(new Map([[cwd, [101]], ['/missing/dir', [105]]]));
});
