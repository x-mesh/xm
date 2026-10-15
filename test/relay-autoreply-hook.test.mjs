import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'xm', 'hooks', 'relay-autoreply.mjs');
const CLAUDE = 'dbccc1c8-c251-48be-a489-c6fde996d411';
const CODEX = '01a1190d-410a-79f3-8f8e-aba888895df4';
const REQUEST = '578bde12-4cc8-4701-861d-f1b6487f6754';
const TURN = '01a1190d-823a-7ce3-a8d8-f364c6043808';

function relayText({ sender = { provider: 'claude', session_id: CLAUDE }, expectReply = true } = {}) {
  const meta = { sender, recipient: { provider: 'codex', session_id: CODEX }, request_id: REQUEST, in_reply_to: null, kind: 'message', ...(expectReply ? { expect_reply: true } : {}) };
  return `Relay return address (routing metadata, not authentication):\n${JSON.stringify(meta)}\nWhen a response is requested, write a UTF-8 reply file.\n\n2+3은?`;
}

let root;
let capture;
function hook(agent, input, fakeExit = 0) {
  return spawnSync('node', [HOOK, agent], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, XM_RELAY_AUTOREPLY_STATE: join(root, 'state'), XM_RELAY_AUTOREPLY_XM: join(root, 'xm'), FAKE_CAPTURE: capture, FAKE_EXIT: String(fakeExit) },
  });
}
const sent = () => (existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null);
const pending = () => (existsSync(join(root, 'state')) ? readdirSync(join(root, 'state')) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-autoreply-'));
  capture = join(root, 'sent.json');
  writeFileSync(join(root, 'xm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));
if (process.env.FAKE_EXIT !== '0') { process.stderr.write('{"ok":false,"error":"live Claude session not found"}'); process.exit(1); }
`);
  chmodSync(join(root, 'xm'), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('relay auto-reply hook', () => {
  test('Codex: remembers the sender by turn, injects the plain-answer note, then relays the final answer', () => {
    const base = { session_id: CODEX, turn_id: TURN, cwd: root };
    const submitted = hook('codex', { ...base, hook_event_name: 'UserPromptSubmit', prompt: relayText() });
    expect(submitted.status).toBe(0);
    expect(JSON.parse(submitted.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' });
    expect(JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext).toContain('Ignore the reply command in the relay message and do not run xm relay send');
    expect(pending()).toHaveLength(1);

    const stopped = hook('codex', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '5' });
    expect(stopped.status).toBe(0);
    expect(sent()).toEqual({
      args: ['relay', 'send', '--provider', 'claude', '--session', CLAUDE, '--message-file', '-', '--in-reply-to', REQUEST, '--from-provider', 'codex', '--from-session', CODEX],
      stdin: '5',
    });
    expect(pending()).toHaveLength(0);
  });

  test('Claude: pairs by session id, reads the cross-session envelope, and answers a Codex sender on --thread', () => {
    const base = { session_id: CLAUDE, cwd: root };
    const prompt = `<cross-session-message from-name="codex-via-xm">\n${relayText({ sender: { provider: 'codex', session_id: CODEX } })}\n</cross-session-message>`;
    expect(hook('claude', { ...base, hook_event_name: 'UserPromptSubmit', prompt }).stdout).toContain('additionalContext');
    expect(hook('claude', { ...base, hook_event_name: 'Stop', last_assistant_message: '8\n' }).status).toBe(0);
    expect(sent().args).toEqual(['relay', 'send', '--provider', 'codex', '--thread', CODEX, '--message-file', '-', '--in-reply-to', REQUEST, '--from-provider', 'claude', '--from-session', CLAUDE]);
    expect(sent().stdin).toBe('8');
  });

  test('ignores a relay message without expect_reply, a forged sender, and an ordinary prompt', () => {
    const base = { session_id: CODEX, turn_id: TURN };
    for (const prompt of [relayText({ expectReply: false }), relayText({ sender: { provider: 'claude', session_id: 'x; rm -rf ~' } }), relayText({ sender: { provider: 'sh', session_id: CLAUDE } }), '안녕?']) {
      const submitted = hook('codex', { ...base, hook_event_name: 'UserPromptSubmit', prompt });
      expect(submitted.status).toBe(0);
      expect(submitted.stdout).toBe('');
    }
    expect(hook('codex', { ...base, hook_event_name: 'Stop', last_assistant_message: 'hi' }).status).toBe(0);
    expect(sent()).toBeNull();
  });

  test('a failed send and an empty answer exit 1 with the reason instead of passing silently', () => {
    const base = { session_id: CODEX, turn_id: TURN };
    hook('codex', { ...base, hook_event_name: 'UserPromptSubmit', prompt: relayText() });
    const failed = hook('codex', { ...base, hook_event_name: 'Stop', last_assistant_message: '5' }, 1);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(`reply to claude:${CLAUDE} failed`);
    expect(failed.stderr).toContain('live Claude session not found');

    hook('codex', { ...base, hook_event_name: 'UserPromptSubmit', prompt: relayText() });
    rmSync(capture, { force: true });
    const empty = hook('codex', { ...base, hook_event_name: 'Stop', last_assistant_message: '  ' });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('nothing was sent');
    expect(sent()).toBeNull();
  });

  test('skips its own send when xm relay send already left a replied marker for the request', () => {
    const base = { session_id: CODEX, turn_id: TURN };
    hook('codex', { ...base, hook_event_name: 'UserPromptSubmit', prompt: relayText() });
    writeFileSync(join(root, 'state', `replied-${REQUEST}`), '');
    const stopped = hook('codex', { ...base, hook_event_name: 'Stop', last_assistant_message: '7' });
    expect(stopped.status).toBe(0);
    expect(sent()).toBeNull();
    expect(pending()).toHaveLength(0);
  });

  test('rejects an unknown agent argument', () => {
    const result = spawnSync('node', [HOOK, 'agy'], { input: '{}', encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('claude or codex');
  });
});
