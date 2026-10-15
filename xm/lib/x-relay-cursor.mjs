// Cursor Agent adapter for xm relay.
//
// cursor-agent has no way to push a message into a running interactive
// session, so the relay runs one headless turn on a saved chat
// (`--resume <id> --print`) and returns that turn's answer as the reply.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Saved chats accumulate without bound; only the most recent are offered.
export const CURSOR_LIST_LIMIT = 20;
// Codex and Claude list only running sessions; a Cursor chat untouched for a
// week is history, not a conversation partner. Older chats stay sendable by ID.
export const CURSOR_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
// One turn measured 11-12 s; a turn that reads files can take minutes.
const TURN_TIMEOUT_MS = 180000;

export function cursorHome() {
  return process.env.XM_RELAY_CURSOR_HOME || join(homedir(), '.cursor');
}

function cursorBinary() {
  return process.env.XM_RELAY_CURSOR_BIN || 'cursor-agent';
}

/** Every saved chat that holds a conversation, newest first, plus how many meta files could not be read. */
export function cursorChats() {
  const root = join(cursorHome(), 'chats');
  if (!existsSync(root)) return { chats: [], unreadable: 0 };
  const chats = [];
  let unreadable = 0;
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    for (const chat of readdirSync(join(root, workspace.name), { withFileTypes: true })) {
      if (!chat.isDirectory() || !CHAT_ID.test(chat.name)) continue;
      let meta;
      try {
        meta = JSON.parse(readFileSync(join(root, workspace.name, chat.name, 'meta.json'), 'utf8'));
      } catch {
        unreadable += 1;
        continue;
      }
      if (meta?.hasConversation !== true) continue;
      chats.push({
        session_id: chat.name,
        name: typeof meta.title === 'string' && meta.title ? meta.title : null,
        cwd: typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : null,
        updated_at: Number.isFinite(meta.updatedAtMs) ? meta.updatedAtMs : null,
      });
    }
  }
  chats.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return { chats, unreadable };
}

export function cursorSessions({ matchesProject = null, now = Date.now() } = {}) {
  const { chats, unreadable } = cursorChats();
  const inProject = matchesProject ? chats.filter(chat => chat.cwd && matchesProject(chat.cwd)) : chats;
  const matched = inProject.filter(chat => chat.updated_at !== null && now - chat.updated_at <= CURSOR_RECENT_MS);
  const notes = [];
  if (unreadable) notes.push(`${unreadable} Cursor chat metadata file(s) could not be read and were skipped.`);
  if (inProject.length > matched.length) notes.push(`${inProject.length - matched.length} Cursor chat(s) not updated in the last 7 days are hidden; send to one by its UUID.`);
  if (matched.length > CURSOR_LIST_LIMIT) notes.push(`Only the ${CURSOR_LIST_LIMIT} most recent of ${matched.length} Cursor chats are listed.`);
  return {
    ok: true, provider: 'cursor', transport: 'cursor_agent_resume',
    sessions: matched.slice(0, CURSOR_LIST_LIMIT).map(chat => {
      // cursorTurn refuses a chat whose directory is gone, so the listing says so up front.
      const sendable = Boolean(chat.cwd && existsSync(chat.cwd));
      return {
        ...chat, status: 'saved', live_status: 'saved', capabilities: { send: sendable }, transport: 'cursor_agent_resume',
        ...(sendable ? {} : { unavailable_reason: `Cursor chat working directory is not on this machine: ${chat.cwd || 'none recorded'}` }),
      };
    }),
    partial: matched.length > CURSOR_LIST_LIMIT || unreadable > 0,
    notes,
    note: 'Saved Cursor Agent chats. A send runs one read-only cursor-agent turn (--mode ask) and returns its answer; it does not reach a running interactive session.',
  };
}

/** Run one read-only turn on a saved chat and return its answer. */
export function cursorTurn(sessionId, message, cwd, run = spawnSync) {
  // --trust accepts whatever workspace the turn runs in. Falling back to the home
  // directory would trust all of it, so a chat whose directory is gone fails instead.
  if (!cwd || !existsSync(cwd)) throw new Error(`Cursor chat ${sessionId} has no working directory on this machine: ${cwd || 'none recorded'}`);
  const args = ['--resume', sessionId, '--print', '--mode', 'ask', '--output-format', 'json', '--trust', '--workspace', cwd, '--', message];
  const ran = run(cursorBinary(), args, { cwd, encoding: 'utf8', timeout: TURN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (ran.error?.code === 'ETIMEDOUT' || ran.error?.code === 'ENOBUFS') {
    throw new Error(`cursor-agent turn started but was stopped (${ran.error.code}); it may already be in chat ${sessionId}, so check the chat before sending again`);
  }
  if (ran.error) throw new Error(`cursor-agent did not run: ${ran.error.message}`);
  let result;
  try {
    result = JSON.parse(ran.stdout);
  } catch {
    throw new Error(`cursor-agent returned no JSON result (exit ${ran.status}): ${(ran.stderr || ran.stdout || '').trim().slice(0, 300)}`);
  }
  if (ran.status !== 0 || result?.is_error || result?.subtype !== 'success') {
    throw new Error(`cursor-agent turn failed (exit ${ran.status}): ${String(result?.result || ran.stderr || 'no detail').trim().slice(0, 300)}`);
  }
  if (result.session_id && result.session_id !== sessionId) throw new Error(`cursor-agent answered for chat ${result.session_id}, not ${sessionId}`);
  return { reply: String(result.result ?? ''), request_id: result.request_id || null, usage: result.usage || null };
}

export function cursorPreamble(replyTo) {
  if (!replyTo) return '';
  return `Relay message from another local agent session (${replyTo.provider}, ${replyTo.cwd || 'directory unknown'}). Answer in plain text; your final answer is returned to that session automatically.\n\n`;
}
