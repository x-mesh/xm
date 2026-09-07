#!/usr/bin/env node
// xm-build-stop-gate.mjs — Stop hook (installed by `x-build hooks install`).
//
// Report unresolved Critical/High findings without forcing another review loop.
// The review-fix gate continues to enforce merge restrictions.

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
  if (state.triageUnreadable) {
    process.stderr.write(
      `xm-build-stop-gate — warning: .xm/review/triage.json exists but could not be read or parsed; ` +
      `review-fix status is unknown. Stopping remains allowed.\n`
    );
    process.exit(0);
  }
  if (!state.unresolvedBlocking.length) process.exit(0);

  const lines = state.unresolvedBlocking
    .map(f => `  - [${f.severity}] ${f.file || '?'}${f.summary ? ' — ' + f.summary : ''}`);
  process.stderr.write(
    `xm-build-stop-gate — unresolved Critical/High review findings.\n\n` +
    `${state.unresolvedBlocking.length} fix_now finding(s) remain and the last x-review is not LGTM:\n` +
    `${lines.join('\n')}\n\n` +
    `Report unresolved findings and stop. Merge remains blocked by the review-fix gate.\n`
  );
  process.exit(0);
}

main();
