#!/usr/bin/env node
// xm turn-done notification hook for Claude Code and Codex.
//
//   node notify-done.mjs <claude|codex>   (stdin: the hook's JSON input)
//
// UserPromptSubmit records when the turn started. Stop sends a desktop
// notification only when the turn ran at least XM_NOTIFY_MIN_SECONDS (default
// 120), so short answers stay quiet. Stop hooks run in parallel, so this hook
// cannot know whether another Stop hook will make the agent continue. The start
// therefore stays until the next prompt: a continued turn notifies again at its
// real end, with the full duration. Claude's Notification event (a permission
// prompt or an idle wait) is forwarded at once, because the turn is blocked on
// the user. term-mesh already shows Claude's own notification, so inside
// term-mesh that event is skipped instead of shown twice.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_MIN_SECONDS = 120;
const BODY_LIMIT = 160;
const STATE_DIR = process.env.XM_NOTIFY_STATE || join(homedir(), '.xm', 'notify-done');
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// One file per session: the next prompt overwrites it, so a session never holds more than one.
function stateFile(input) {
  const key = String(input.session_id || input.turn_id || '').replace(/[^A-Za-z0-9-]/g, '');
  return key ? join(STATE_DIR, `${key}.json`) : null;
}

// Starts are kept until the next prompt, so files of finished sessions would pile up without this.
function pruneStale() {
  const cutoff = Date.now() - STATE_MAX_AGE_MS;
  for (const name of readdirSync(STATE_DIR)) {
    const file = join(STATE_DIR, name);
    try { if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true }); } catch {}
  }
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

function argvEnv(name, env) {
  const raw = env[name];
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
export function notifier(title, body, os = platform(), env = process.env) {
  const override = argvEnv('XM_NOTIFY_ARGV', env);
  if (override) return [...override, title, body];
  if (env.TERMMESH_WORKSPACE_ID) return [termMeshBinary(), 'notify', '--title', title, '--body', body];
  if (os === 'darwin') {
    return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body];
  }
  // `--` keeps a body such as "- Fixed the parser" from being read as an option.
  return ['notify-send', '--', title, body];
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
    pruneStale();
    return 0;
  }
  if (event !== 'Stop' || !existsSync(file)) return 0;
  let startedAt = null;
  try { startedAt = JSON.parse(readFileSync(file, 'utf8')).started_at; } catch {}
  if (!Number.isFinite(startedAt)) return 0;
  const seconds = (Date.now() - startedAt) / 1000;
  if (seconds < minSeconds()) return 0;
  return send(`${agent} done in ${formatDuration(seconds)}: ${project(input)}`, firstLine(input.last_assistant_message) || 'turn finished');
}

// The tests import notifier(); run only when this file is the entry point, even through a symlinked HOME.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`notify-done: ${error.message}\n`);
    process.exitCode = 1;
  }
}
