import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../xm/lib/x-relay-cli.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'xm', 'lib', 'x-relay-cli.mjs');
const CHAT_A = 'a5350b87-e97e-4ff0-a542-bf373d3de254';
const CHAT_B = 'd97f183c-ce4d-4c34-944d-5beb5bf8f43e';
const CHAT_EMPTY = '3bd117fa-0000-4000-8000-000000000000';
const CHAT_OLD = 'c0ffee00-0000-4000-8000-000000000000';
const DAY = 24 * 60 * 60 * 1000;

let root;
const writeChat = (workspace, id, meta) => {
  mkdirSync(join(root, 'cursor', 'chats', workspace, id), { recursive: true });
  writeFileSync(join(root, 'cursor', 'chats', workspace, id, 'meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
};
function run(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_THREAD_ID: '', ANTIGRAVITY_CONVERSATION_ID: '', CLAUDE_CODE_SESSION_ID: '', XM_RELAY_AUTOREPLY_STATE: join(root, 'autoreply'),
      XM_RELAY_CURSOR_HOME: join(root, 'cursor'), XM_RELAY_CURSOR_BIN: join(root, 'cursor-agent'), FAKE_CAPTURE: join(root, 'args.json'), ...env },
  });
  return { status: result.status, output: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xm-relay-cursor-'));
  mkdirSync(join(root, 'work', 'app'), { recursive: true });
  const now = Date.now();
  writeChat('ws1', CHAT_A, { hasConversation: true, cwd: join(root, 'work', 'app'), updatedAtMs: now - 1000, title: 'App review' });
  writeChat('ws2', CHAT_B, { hasConversation: true, cwd: '/somewhere/else', updatedAtMs: now - 6 * DAY });
  writeChat('ws2', CHAT_EMPTY, { hasConversation: false, updatedAtMs: now });
  writeChat('ws2', CHAT_OLD, { hasConversation: true, cwd: '/somewhere/else', updatedAtMs: now - 32 * DAY, title: 'Old work' });
  writeChat('ws3', 'f00dfeed-0000-4000-8000-000000000000', '{ broken');
  writeFileSync(join(root, 'cursor-agent'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ args, cwd: process.cwd() }));
const id = args[args.indexOf('--resume') + 1];
if (process.env.FAKE_MODE === 'error') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' })); process.exit(1); }
if (process.env.FAKE_MODE === 'garbage') { process.stdout.write('not json'); process.exit(0); }
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fifteen', session_id: id, request_id: 'req-1', usage: { inputTokens: 10 } }));
`);
  chmodSync(join(root, 'cursor-agent'), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Cursor relay adapter', () => {
  test('lists saved chats with a conversation from the last week, newest first, and reports hidden and unreadable chats', () => {
    const result = run(['sessions', '--provider', 'cursor']);
    expect(result.status).toBe(0);
    expect(result.output.sessions.map(row => [row.session_id, row.name, row.capabilities.send])).toEqual([[CHAT_A, 'App review', true], [CHAT_B, null, true]]);
    expect(result.output.partial).toBe(true);
    expect(result.output.notes.join(' ')).toContain('1 Cursor chat metadata file(s) could not be read');
    expect(result.output.notes.join(' ')).toContain('1 Cursor chat(s) not updated in the last 7 days are hidden');
  });

  test('still sends to a chat older than the listing window', () => {
    const result = run(['send', '--provider', 'cursor', '--session', CHAT_OLD, '--message', 'hi']);
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ ok: true, state: 'answered', session_id: CHAT_OLD });
  });

  test('runs one read-only turn on the chat in its workspace and returns the answer as the reply', () => {
    const message = '- starts with a dash';
    const result = run(['send', '--provider', 'cursor', '--session', CHAT_A, '--message', message]);
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ ok: true, provider: 'cursor', state: 'answered', session_id: CHAT_A, reply: 'fifteen', cursor_request_id: 'req-1' });
    const { args, cwd } = JSON.parse(readFileSync(join(root, 'args.json'), 'utf8'));
    expect(args).toEqual(['--resume', CHAT_A, '--print', '--mode', 'ask', '--output-format', 'json', '--trust', '--workspace', join(root, 'work', 'app'), '--', message]);
    expect(cwd.endsWith(join('work', 'app'))).toBe(true);
  });

  test('tells the Cursor agent who sent the message when the sender is known', () => {
    run(['send', '--provider', 'cursor', '--session', CHAT_B, '--message', 'hi', '--from-provider', 'codex', '--from-session', CHAT_A]);
    const { args } = JSON.parse(readFileSync(join(root, 'args.json'), 'utf8'));
    expect(args.at(-1)).toStartWith('Relay message from another local agent session (codex,');
    expect(args.at(-1).endsWith('\n\nhi')).toBe(true);
    expect(args).not.toContain('--workspace');
  });

  test('fails visibly on a failed turn, a non-JSON answer, and an unknown chat', () => {
    const failed = run(['send', '--provider', 'cursor', '--session', CHAT_A, '--message', 'hi'], { FAKE_MODE: 'error' });
    expect(failed.status).not.toBe(0);
    expect(failed.output.error).toContain('cursor-agent turn failed (exit 1): rate limited');
    const garbage = run(['send', '--provider', 'cursor', '--session', CHAT_A, '--message', 'hi'], { FAKE_MODE: 'garbage' });
    expect(garbage.output.error).toContain('cursor-agent returned no JSON result');
    const unknown = run(['send', '--provider', 'cursor', '--session', CHAT_EMPTY, '--message', 'hi']);
    expect(unknown.output.error).toContain(`Cursor chat not found: ${CHAT_EMPTY}`);
    rmSync(join(root, 'args.json'), { force: true });
    run(['send', '--provider', 'cursor', '--session', CHAT_EMPTY, '--message', 'hi']);
    expect(existsSync(join(root, 'args.json'))).toBe(false);
  });

  test('accepts cursor as a provider and a --to target', () => {
    expect(parseArgs(['send', '--provider', 'cursor', '--session', CHAT_A, '--message', 'hi']).options['--provider']).toBe('cursor');
    expect(parseArgs(['send', '--to', `cursor:${CHAT_A}`, '--message', 'hi']).options['--to']).toEqual([`cursor:${CHAT_A}`]);
    expect(() => parseArgs(['send', '--provider', 'cursor', '--thread', CHAT_A, '--message', 'hi'])).toThrow('requires --session');
  });
});
