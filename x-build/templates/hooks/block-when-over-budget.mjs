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

  // budget.window_hours mirrors cost-engine's normalization: unset → the
  // documented 24h rolling window (unset must not silently widen to full
  // metrics lifetime), explicit 0 → lifetime, NaN/negative → 24h with a notice.
  const windowHoursRaw = budgetConfig.window_hours;
  let windowHours = 24;
  if (windowHoursRaw != null) {
    windowHours = Number(windowHoursRaw);
    if (isNaN(windowHours) || windowHours < 0) {
      process.stderr.write(`budget guard: budget.window_hours = ${JSON.stringify(windowHoursRaw)} is not a valid window — using the 24h default window\n`);
      windowHours = 24;
    }
  }

  const state = openCircuit(root);
  if (state) {
    const spent = costEventsSpent(join(root, '.xm', 'build', 'metrics', 'sessions.jsonl'), Date.now(), windowHours);
    block(`state=open spent=$${Number(spent || 0).toFixed(4)} cap=$${cap.toFixed(4)} recovers_at=${state.cooldown_until || 'budget-recheck'}`);
  }

  // reservation_usd must be a positive amount — 0/NaN would flow into
  // checkAndReserve as invalid_reservation_input and block every dispatch.
  // A set-but-invalid value falls back audibly; unset is the normal default path.
  const rawReservation = Number(budgetConfig.reservation_usd);
  let amount;
  if (Number.isFinite(rawReservation) && rawReservation > 0) {
    amount = rawReservation;
  } else {
    amount = Math.min(cap, 0.01);
    if (budgetConfig.reservation_usd != null) {
      process.stderr.write(`budget guard: budget.reservation_usd = ${JSON.stringify(budgetConfig.reservation_usd)} is not a positive amount — using the default reservation $${amount}\n`);
    }
  }
  const now = Date.now();
  const spent = costEventsSpent(join(root, '.xm', 'build', 'metrics', 'sessions.jsonl'), now, windowHours);
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
