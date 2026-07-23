#!/usr/bin/env node
// block-when-over-budget.mjs — Agent-only PreToolUse hook.
//
// It runs before a NEW Agent dispatch. Already-running agents never pass this
// hook again, so their work is intentionally allowed to finish (R25).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeReservations, checkAndReserve } from './budget-reservations.mjs';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function readJSON(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
  catch { return null; }
}

function costEventsSpent(path, now, windowHours) {
  let text = '';
  try { text = existsSync(path) ? readFileSync(path, 'utf8') : ''; } catch { return null; }
  const cutoff = Number.isFinite(windowHours) && windowHours > 0 ? now - windowHours * 3600000 : null;
  let spent = 0;
  for (const line of text.split('\n')) {
    try {
      const event = JSON.parse(line);
      const cost = Number(event?.cost_usd);
      const at = Date.parse(event?.timestamp || event?.completed_at || event?.created_at || '');
      if (!Number.isFinite(cost) || cost < 0 || (cutoff != null && (!Number.isFinite(at) || at < cutoff))) continue;
      spent += cost;
    } catch { /* malformed/torn metric row is not a reason to stop a session */ }
  }
  return spent;
}

function openCircuit(root) {
  const projects = join(root, '.xm', 'build', 'projects');
  try {
    for (const name of readdirSync(projects)) {
      const state = readJSON(join(projects, name, 'circuit-breaker.json'));
      // v1 has no reason; `open` still means the existing breaker owns a stop.
      if (state?.state === 'open') return state;
    }
  } catch { /* no x-build project: reservation guard can still operate */ }
  return null;
}

function block(message) {
  process.stderr.write(`✋ Agent dispatch blocked by budget guard — ${message}\n`);
  process.exit(2);
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch { process.exit(0); } // malformed hook payload must not kill the host
  if (input.tool_name !== 'Agent') process.exit(0);

  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const config = readJSON(join(root, '.xm', 'config.json'));
  const budgetConfig = config?.budget;
  // Hard-cap is opt-in. A bad/missing config fails open; lock failures below
  // fail closed because continuing there violates the cap race invariant.
  if (budgetConfig?.enforce !== true) process.exit(0);
  const cap = Number(budgetConfig.max_usd);
  if (!Number.isFinite(cap) || cap <= 0) process.exit(0);

  const state = openCircuit(root);
  if (state) {
    const spent = costEventsSpent(join(root, '.xm', 'build', 'metrics', 'sessions.jsonl'), Date.now(), Number(budgetConfig.window_hours));
    block(`state=open spent=$${Number(spent || 0).toFixed(4)} cap=$${cap.toFixed(4)} recovers_at=${state.cooldown_until || 'budget-recheck'}`);
  }

  const amount = Number(budgetConfig.reservation_usd ?? Math.min(cap, 0.01));
  const now = Date.now();
  const spent = costEventsSpent(join(root, '.xm', 'build', 'metrics', 'sessions.jsonl'), now, Number(budgetConfig.window_hours));
  if (spent == null) process.exit(0); // metrics unavailable: retain the non-disruptive hook contract
  const result = checkAndReserve({
    filePath: join(root, '.xm', 'build', 'metrics', 'reservations.jsonl'),
    rootDir: root,
    cap, spent, amount, ttl_ms: budgetConfig.reservation_ttl_ms, now,
  });
  if (!result.ok) {
    const recoversAt = result.reason === 'cap_exceeded' ? 'reservation-expiry' : 'lock-retry';
    block(`state=open spent=$${Number(result.spent ?? spent).toFixed(4)} cap=$${cap.toFixed(4)} recovers_at=${recoversAt} (${result.reason})`);
  }
}

main();
