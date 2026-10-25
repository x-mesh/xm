#!/usr/bin/env node
// xm turn-done notification hook for Claude Code and Codex.
//
//   node notify-done.mjs <claude|codex>   (stdin: the hook's JSON input)
//
// UserPromptSubmit records when the turn started. Stop sends a desktop
// notification only when the turn ran at least XM_NOTIFY_MIN_SECONDS (default
// 120), so short answers stay quiet. Claude's Notification event (a permission
// prompt or an idle wait) is forwarded at once, because the turn is blocked on
// the user. term-mesh already shows Claude's own notification, so inside
// term-mesh that event is skipped instead of shown twice.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';

const DEFAULT_MIN_SECONDS = 120;
const BODY_LIMIT = 160;
const STATE_DIR = process.env.XM_NOTIFY_STATE || join(homedir(), '.xm', 'notify-done');

// Codex pairs the two events by turn_id; Claude has no turn id, so the session is the unit there.
function stateFile(input) {
  const key = String(input.turn_id || input.session_id || '').replace(/[^A-Za-z0-9-]/g, '');
  return key ? join(STATE_DIR, `${key}.json`) : null;
}

function minSeconds() {
  const raw = process.env.XM_NOTIFY_MIN_SECONDS;
  if (!raw) return DEFAULT_MIN_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error('XM_NOTIFY_MIN_SECONDS must be a non-negative number of seconds');
  return value;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
}

function firstLine(text) {
  const line = String(text || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
  return line.length > BODY_LIMIT ? line.slice(0, BODY_LIMIT - 1) + '…' : line;
}

function argvEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === 'string')) throw new Error(`${name} must be a non-empty JSON string array`);
  return value;
}

function termMeshBinary() {
  const bundled = process.env.TERMMESH_APP_BIN ? join(process.env.TERMMESH_APP_BIN, 'term-mesh') : null;
  return bundled && existsSync(bundled) ? bundled : 'term-mesh';
}

// Inside term-mesh the notification lands on the pane that ran the agent; elsewhere
// the OS notifier is the only channel that reaches a user who looked away.
function notifier(title, body) {
  const override = argvEnv('XM_NOTIFY_ARGV');
  if (override) return [...override, title, body];
  if (process.env.TERMMESH_WORKSPACE_ID) return [termMeshBinary(), 'notify', '--title', title, '--body', body];
  if (platform() === 'darwin') {
    return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body];
  }
  return ['notify-send', title, body];
}

function send(title, body) {
  const argv = notifier(title, body);
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) {
    process.stderr.write(`notify-done: ${argv[0]} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}\n`);
    return 1;
  }
  return 0;
}

function project(input) {
  return basename(input.cwd || process.cwd()) || 'agent';
}

function main() {
  const agent = process.argv[2];
  if (!['claude', 'codex'].includes(agent)) {
    process.stderr.write('notify-done: first argument must be claude or codex\n');
    return 1;
  }
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const event = input.hook_event_name;

  if (event === 'Notification') {
    if (process.env.TERMMESH_WORKSPACE_ID) return 0;
    return send(`${agent} needs you: ${project(input)}`, firstLine(input.message) || 'waiting for input');
  }

  const file = stateFile(input);
  if (!file) return 0;
  if (event === 'UserPromptSubmit') {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ started_at: Date.now() }), { mode: 0o600 });
    return 0;
  }
  if (event !== 'Stop' || !existsSync(file)) return 0;
  // Another Stop hook asked the agent to continue; the turn is not over yet.
  if (input.stop_hook_active === true) return 0;
  let startedAt = null;
  try { startedAt = JSON.parse(readFileSync(file, 'utf8')).started_at; } catch {}
  rmSync(file, { force: true });
  if (!Number.isFinite(startedAt)) return 0;
  const seconds = (Date.now() - startedAt) / 1000;
  if (seconds < minSeconds()) return 0;
  return send(`${agent} done in ${formatDuration(seconds)}: ${project(input)}`, firstLine(input.last_assistant_message) || 'turn finished');
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`notify-done: ${error.message}\n`);
  process.exitCode = 1;
}
