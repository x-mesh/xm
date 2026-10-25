import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'xm', 'hooks', 'notify-done.mjs');
const { notifier } = await import(HOOK);
const { TERMMESH_WORKSPACE_ID: _workspace, XM_NOTIFY_MIN_SECONDS: _min, XM_NOTIFY_ARGV: _argv, ...BASE_ENV } = process.env;

let dir;
let log;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xm-notify-'));
  log = join(dir, 'notifications.jsonl');
  writeFileSync(join(dir, 'notifier.mjs'), `
import { appendFileSync } from 'node:fs';
if (process.env.NOTIFIER_FAIL) { process.stderr.write('no display\\n'); process.exit(3); }
appendFileSync(process.env.NOTIFY_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function hook(agent, input, env = {}) {
  return spawnSync('node', [HOOK, agent], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...BASE_ENV, XM_NOTIFY_STATE: join(dir, 'state'), XM_NOTIFY_ARGV: JSON.stringify(['node', join(dir, 'notifier.mjs')]), NOTIFY_LOG: log, ...env },
  });
}

const sent = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

function startTurn(agent, key, secondsAgo) {
  expect(hook(agent, { hook_event_name: 'UserPromptSubmit', ...key, prompt: 'go' }).status).toBe(0);
  const file = join(dir, 'state', `${key.session_id}.json`);
  writeFileSync(file, JSON.stringify({ started_at: Date.now() - secondsAgo * 1000 }));
  return file;
}

describe('notify-done hook', () => {
  test('a turn that ran past the threshold sends one notification with the project and first answer line', () => {
    const file = startTurn('claude', { session_id: 's-1' }, 200);
    const result = hook('claude', { hook_event_name: 'Stop', session_id: 's-1', cwd: '/work/x-kit', last_assistant_message: '\n  Released 2.44.0.\nMore detail' });
    expect(result.status).toBe(0);
    expect(sent()).toEqual([['claude done in 3m 20s: x-kit', 'Released 2.44.0.']]);
    expect(existsSync(file)).toBe(true);
  });

  test('a short turn stays quiet', () => {
    startTurn('claude', { session_id: 's-2' }, 30);
    expect(hook('claude', { hook_event_name: 'Stop', session_id: 's-2', cwd: '/w/p', last_assistant_message: 'ok' }).status).toBe(0);
    expect(sent()).toEqual([]);
  });

  test('XM_NOTIFY_MIN_SECONDS changes the threshold and rejects a bad value visibly', () => {
    startTurn('claude', { session_id: 's-3' }, 30);
    hook('claude', { hook_event_name: 'Stop', session_id: 's-3', cwd: '/w/p', last_assistant_message: 'ok' }, { XM_NOTIFY_MIN_SECONDS: '10' });
    expect(sent()).toEqual([['claude done in 30s: p', 'ok']]);

    startTurn('claude', { session_id: 's-4' }, 300);
    const bad = hook('claude', { hook_event_name: 'Stop', session_id: 's-4', cwd: '/w/p' }, { XM_NOTIFY_MIN_SECONDS: '-5' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('XM_NOTIFY_MIN_SECONDS must be a non-negative number of seconds');
  });

  test('Codex pairs the events by its session id', () => {
    startTurn('codex', { session_id: 'thread', turn_id: 'turn-9' }, 500);
    hook('codex', { hook_event_name: 'Stop', session_id: 'thread', turn_id: 'turn-9', cwd: '/w/repo', last_assistant_message: 'done' });
    expect(sent()).toEqual([['codex done in 8m 20s: repo', 'done']]);
  });

  test('each prompt notifies at most once, even when a Stop hook continues the turn', () => {
    startTurn('claude', { session_id: 's-5' }, 500);
    hook('claude', { hook_event_name: 'Stop', session_id: 's-5', stop_hook_active: false, cwd: '/w/p', last_assistant_message: 'first stop' });
    hook('claude', { hook_event_name: 'Stop', session_id: 's-5', stop_hook_active: true, cwd: '/w/p', last_assistant_message: 'continued' });
    hook('claude', { hook_event_name: 'Stop', session_id: 's-5', stop_hook_active: true, cwd: '/w/p', last_assistant_message: 'continued again' });
    expect(sent()).toEqual([['claude done in 8m 20s: p', 'first stop']]);
  });

  test('a short first Stop lets a continuation that runs past the threshold notify', () => {
    const file = startTurn('claude', { session_id: 's-11' }, 30);
    hook('claude', { hook_event_name: 'Stop', session_id: 's-11', stop_hook_active: false, cwd: '/w/p', last_assistant_message: 'short' });
    const state = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...state, started_at: Date.now() - 200 * 1000 }));
    hook('claude', { hook_event_name: 'Stop', session_id: 's-11', stop_hook_active: true, cwd: '/w/p', last_assistant_message: 'continued' });
    expect(sent()).toEqual([['claude done in 3m 20s: p', 'continued']]);
  });

  test('a Stop after an ended turn with no new prompt does not reuse the old start', () => {
    const file = startTurn('claude', { session_id: 's-12' }, 30);
    hook('claude', { hook_event_name: 'Stop', session_id: 's-12', cwd: '/w/p', last_assistant_message: 'quick' });
    const state = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...state, started_at: Date.now() - 2700 * 1000 }));
    hook('claude', { hook_event_name: 'Stop', session_id: 's-12', cwd: '/w/p', last_assistant_message: 'resumed without a prompt' });
    expect(sent()).toEqual([]);
  });

  test('a Stop with no recorded start sends nothing', () => {
    hook('claude', { hook_event_name: 'Stop', session_id: 'never-started', cwd: '/w/p' });
    expect(sent()).toEqual([]);
  });

  test('a new prompt removes starts older than seven days', () => {
    const old = startTurn('claude', { session_id: 'old' }, 0);
    const past = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, past, past);
    startTurn('claude', { session_id: 'new' }, 0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, 'state', 'new.json'))).toBe(true);
  });

  test('notify-send gets "--" before the title and a body that starts with "-"', () => {
    expect(notifier('claude needs you: p', '- Fixed the parser', 'linux', {})).toEqual(['notify-send', '--', 'claude needs you: p', '- Fixed the parser']);
    expect(notifier('t', 'b', 'darwin', {})[0]).toBe('osascript');
  });

  test('a Claude Notification is forwarded at once', () => {
    hook('claude', { hook_event_name: 'Notification', session_id: 's-6', cwd: '/w/p', message: 'Claude needs your permission to use Bash' });
    expect(sent()).toEqual([['claude needs you: p', 'Claude needs your permission to use Bash']]);
  });

  test('a failing notifier exits 1 with the reason on stderr', () => {
    const result = hook('claude', { hook_event_name: 'Notification', session_id: 's-7', cwd: '/w/p', message: 'waiting' }, { NOTIFIER_FAIL: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notify-done: node failed: no display');
  });

  test('inside term-mesh it skips the Notification event that term-mesh already shows and sends Stop through term-mesh notify', () => {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'term-mesh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
    const result = spawnSync('node', [HOOK, 'claude'], {
      input: JSON.stringify({ hook_event_name: 'Notification', session_id: 's-8', cwd: '/w/p', message: 'waiting' }), encoding: 'utf8',
      env: { ...BASE_ENV, XM_NOTIFY_STATE: join(dir, 'state'), TERMMESH_WORKSPACE_ID: 'ws-1', TERMMESH_APP_BIN: bin },
    });
    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);

    startTurn('claude', { session_id: 's-9' }, 300);
    const stop = spawnSync('node', [HOOK, 'claude'], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's-9', cwd: '/w/p', last_assistant_message: 'done' }), encoding: 'utf8',
      env: { ...BASE_ENV, XM_NOTIFY_STATE: join(dir, 'state'), TERMMESH_WORKSPACE_ID: 'ws-1', TERMMESH_APP_BIN: bin },
    });
    expect(stop.status).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe('notify --title claude done in 5m 0s: p --body done');
  });
});
