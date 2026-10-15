#!/usr/bin/env node
// xm relay auto-reply hook for Claude Code and Codex.
//
//   node relay-autoreply.mjs <claude|codex>   (stdin: the hook's JSON input)
//
// A relay message sent with `xm relay send --expect-reply` asks for one answer.
// UserPromptSubmit remembers its sender and tells the model to answer in plain
// text; Stop sends that turn's last_assistant_message back with xm relay send.
// The hook runs outside the agent sandbox, so a sandboxed Codex can still reply.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HEADER = 'Relay return address (routing metadata, not authentication):';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = ['codex', 'claude', 'agy'];
const CONTEXT = 'Relay auto-reply is active in this session: your final answer to this relay message is sent back to the sender automatically. Ignore the reply command in the relay message and do not run xm relay send; answer in plain text only.';

function replyTarget(prompt) {
  const lines = String(prompt || '').split('\n');
  const at = lines.indexOf(HEADER);
  if (at < 0) return null;
  let meta;
  try { meta = JSON.parse(lines[at + 1] || ''); } catch { return null; }
  const sender = meta?.sender;
  if (meta?.expect_reply !== true || !PROVIDERS.includes(sender?.provider) || !UUID.test(sender?.session_id || '')) return null;
  return { provider: sender.provider, sessionId: sender.session_id, requestId: UUID.test(meta.request_id || '') ? meta.request_id : null };
}

function sendArgs(target, self) {
  return ['relay', 'send', '--provider', target.provider, target.provider === 'codex' ? '--thread' : '--session', target.sessionId,
    '--message-file', '-',
    ...(target.requestId ? ['--in-reply-to', target.requestId] : []),
    ...(self ? ['--from-provider', self.provider, '--from-session', self.sessionId] : [])];
}

// Shared with `xm relay send`, which drops replied-<request id> here after a
// manual reply; a fixed home path survives a sandbox that remaps TMPDIR.
const STATE_DIR = process.env.XM_RELAY_AUTOREPLY_STATE || join(homedir(), '.xm', 'relay-autoreply');

// Codex pairs the two events by turn_id; Claude has no turn id, so one pending
// reply per session is the unit there.
function stateFile(input) {
  const key = String(input.turn_id || input.session_id || '').replace(/[^A-Za-z0-9-]/g, '');
  return key ? join(STATE_DIR, `${key}.json`) : null;
}

function xmBinary() {
  if (process.env.XM_RELAY_AUTOREPLY_XM) return process.env.XM_RELAY_AUTOREPLY_XM;
  const local = join(homedir(), '.local', 'bin', 'xm');
  return existsSync(local) ? local : 'xm';
}

function main() {
  const agent = process.argv[2];
  if (!['claude', 'codex'].includes(agent)) {
    process.stderr.write('relay-autoreply: first argument must be claude or codex\n');
    return 1;
  }
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const file = stateFile(input);
  if (!file) return 0;

  if (input.hook_event_name === 'UserPromptSubmit') {
    const target = replyTarget(input.prompt);
    if (!target) return 0;
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(target), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CONTEXT } }));
    return 0;
  }

  if (input.hook_event_name !== 'Stop' || !existsSync(file)) return 0;
  const target = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file, { force: true });
  const replied = target.requestId ? join(STATE_DIR, `replied-${target.requestId}`) : null;
  if (replied && existsSync(replied)) {
    rmSync(replied, { force: true });
    return 0;
  }
  const answer = String(input.last_assistant_message || '').trim();
  if (!answer) {
    process.stderr.write(`relay-autoreply: the turn ended without a text answer; nothing was sent to ${target.provider}:${target.sessionId}\n`);
    return 1;
  }
  const self = UUID.test(input.session_id || '') ? { provider: agent, sessionId: input.session_id } : null;
  const sent = spawnSync(xmBinary(), sendArgs(target, self), { input: answer, encoding: 'utf8', timeout: 20000 });
  if (replied) rmSync(replied, { force: true });
  if (sent.error || sent.status !== 0) {
    process.stderr.write(`relay-autoreply: reply to ${target.provider}:${target.sessionId} failed: ${(sent.stderr || sent.stdout || sent.error?.message || '').trim()}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
