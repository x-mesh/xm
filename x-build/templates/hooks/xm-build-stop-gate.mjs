#!/usr/bin/env node
// xm-build-stop-gate.mjs — Stop hook (installed by `x-build hooks install`).
//
// Block turn termination while an x-build review-fix has unresolved Critical/High
// fix_now findings (latest x-review verdict not LGTM). This stops the agent from
// silently walking away from a review-fix mid-way. Conservative by design: only
// Critical/High fix_now blocks — normal work, Research, and Plan stops never do.

import { hooksOff, reviewFixState } from './hook-state.mjs';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  if (hooksOff()) process.exit(0);

  let input = {};
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch { process.exit(0); }

  // Already inside a stop-hook-triggered continuation → do NOT block again, or the
  // agent could loop forever. The gate fires ONCE as a hard reminder; a second stop
  // is a deliberate choice (and XM_BUILD_HOOKS_OFF is the explicit bypass).
  if (input.stop_hook_active) process.exit(0);

  const projectRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const state = reviewFixState(projectRoot);
  if (!state.unresolvedBlocking.length) process.exit(0);

  const lines = state.unresolvedBlocking
    .map(f => `  - [${f.severity}] ${f.file || '?'}${f.summary ? ' — ' + f.summary : ''}`);
  process.stderr.write(
    `✋ Blocked by xm-build-stop-gate — unresolved Critical/High review findings.\n\n` +
    `${state.unresolvedBlocking.length} fix_now finding(s) remain and the last x-review is not LGTM:\n` +
    `${lines.join('\n')}\n\n` +
    `Fix them (edits are limited to the review-fix scope), then re-run x-review until LGTM.\n` +
    `To stop anyway, set XM_BUILD_HOOKS_OFF=1.\n`
  );
  process.exit(2);
}

main();
